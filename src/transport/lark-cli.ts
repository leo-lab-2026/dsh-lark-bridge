/**
 * Lark transport: delivers notifications through the official lark-cli
 * (`lark-cli im +messages-send … --as bot --format json`). Sends are
 * serialized through an internal queue (rate-limit friendly), fail-soft
 * (never throw), and fully inspectable via {@link LarkCliTransport.status}.
 *
 * Credentials live entirely inside lark-cli (keychain / its own config) —
 * this plugin never touches App Secret material.
 * @module dsh-lark-bridge/transport/lark-cli
 */

import { createHash } from 'node:crypto'
import type { PluginLogger } from '../logger.js'
import { describeError, parseErrorEnvelope, parseSuccessEnvelope } from './envelope.js'
import { runProcess, type ProcessResult, type RunProcessOptions } from './spawn.js'
import type { Notifier, NotificationMessage, NotifierStatus } from './types.js'

/** Configuration of the lark-cli transport. */
export interface LarkCliTransportOptions {
  /** lark-cli executable (resolved from PATH by default). */
  bin: string
  /** `--as` identity used for sends. */
  identity: 'bot' | 'user'
  /** Per-send hard timeout. */
  timeoutMs: number
  /** Where notifications go: one of chatId (recommended) or userId — read per send, so settings updates apply live. */
  target: () => { chatId?: string; userId?: string }
  /** Log the would-be message instead of spawning lark-cli — read per send (live setting). */
  dryRun: () => boolean
  logger: PluginLogger
  /** Injectable process runner (tests); defaults to the real spawn-based runner. */
  runner?: (options: RunProcessOptions) => Promise<ProcessResult>
}

/** Silence lark-cli update/skill notices on machine-read stderr (docs/06 §2). */
export const QUIET_ENV = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
} as const

/** Derive a stable ≤50-char idempotency key from event identity parts. */
export function makeIdempotencyKey(parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 16)
  return `dsh-${digest}`
}

export class LarkCliTransport implements Notifier {
  private readonly runner: (options: RunProcessOptions) => Promise<ProcessResult>
  private chain: Promise<unknown> = Promise.resolve()
  private sentCount = 0
  private failedCount = 0
  private lastError: string | undefined

  constructor(private readonly options: LarkCliTransportOptions) {
    this.runner = options.runner ?? runProcess
  }

  status(): NotifierStatus {
    return {
      sent: this.sentCount,
      failed: this.failedCount,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  /** Effective notification target right now (diagnostics + setup). */
  currentTarget(): { chatId?: string; userId?: string } {
    return this.options.target()
  }

  /** Whether dry-run is currently in effect (diagnostics). */
  isDryRun(): boolean {
    return this.options.dryRun()
  }

  /** Queue one send behind all previous sends; resolves true on delivery. */
  send(message: NotificationMessage): Promise<boolean> {
    const task = this.chain.then(() => this.deliver(message))
    // Keep the chain alive even when a deliver step throws unexpectedly.
    this.chain = task.catch(() => undefined)
    return task
  }

  private buildArgs(message: NotificationMessage): string[] {
    const override = message.target ?? this.options.target()
    const chatId = override.chatId ?? ''
    const userId = override.userId ?? ''
    const targetArgs = chatId !== ''
      ? ['--chat-id', chatId]
      : userId !== ''
        ? ['--user-id', userId]
        : []
    return [
      'im', '+messages-send',
      ...targetArgs,
      '--as', this.options.identity,
      '--text', message.text,
      '--format', 'json',
      '--idempotency-key', message.idempotencyKey.slice(0, 50),
    ]
  }

  private async deliver(message: NotificationMessage): Promise<boolean> {
    const { logger, bin } = this.options
    if (this.options.dryRun()) {
      logger.info(`[dry-run] would send via ${bin}:\n${message.text}`)
      this.sentCount += 1
      return true
    }
    try {
      const result = await this.runner({
        bin,
        args: this.buildArgs(message),
        timeoutMs: this.options.timeoutMs,
        env: { ...QUIET_ENV },
      })
      if (result.exitCode === 0) {
        const envelope = parseSuccessEnvelope(result.stdout)
        if (envelope !== undefined) {
          this.sentCount += 1
          return true
        }
      }
      const envelope = parseErrorEnvelope(result.stderr)
      const reason = envelope !== undefined
        ? describeError(envelope)
        : `lark-cli exited ${result.exitCode}${result.signal !== null ? ` (${result.signal})` : ''}`
          + (result.stderr.trim() !== '' ? `: ${result.stderr.trim().slice(0, 300)}` : '')
      this.recordFailure(reason)
      return false
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  private recordFailure(reason: string): void {
    this.failedCount += 1
    this.lastError = reason
    this.options.logger.warn(`lark-cli notification failed: ${reason}`)
  }
}
