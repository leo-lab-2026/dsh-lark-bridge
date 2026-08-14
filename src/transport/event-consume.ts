/**
 * Minimal consumer of the lark-cli `event consume` subprocess contract
 * (docs/06 §6): wait for the stderr ready marker, then take the first human
 * message from the stdout NDJSON stream. Bounded run (`--max-events 1
 * --timeout`), so stdin EOF is ignored and no keep-alive plumbing is needed.
 * Used by `/lark-notify setup` to discover the user's p2p chat_id.
 * @module dsh-lark-bridge/transport/event-consume
 */

import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { PluginLogger } from '../logger.js'
import { QUIET_ENV } from './lark-cli.js'

/** One human message captured from the event stream (flattened CLI shape). */
export interface CapturedMessage {
  chatId: string
  chatType: string
  senderId: string
  senderType: string
  messageId: string
  text: string
}

export interface CaptureOneMessageOptions {
  bin: string
  /** EventKey to subscribe, e.g. 'im.message.receive_v1'. */
  eventKey: string
  identity: 'bot' | 'user'
  /** Hard deadline for the whole capture (also forwarded as --timeout). */
  timeoutMs: number
  logger: PluginLogger
  signal?: AbortSignal
  /** Fired once the subprocess reports its ready marker on stderr. */
  onReady?: () => void
}

/** SIGTERM the whole process group (reaps lark-cli's bus daemon helpers). */
function stopGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Nothing left to signal.
    }
  }
}

/** Tolerant extraction of the flattened message fields from one NDJSON line. */
export function extractMessage(value: unknown): CapturedMessage | undefined {
  const record = value as Record<string, unknown>
  if (typeof record !== 'object' || record === null) return undefined
  // V2 envelopes nest under `event`; the CLI's flattened shape sits at top level.
  const event = (typeof record.event === 'object' && record.event !== null ? record.event : record) as Record<string, unknown>
  const message = (typeof event.message === 'object' && event.message !== null ? event.message : event) as Record<string, unknown>
  const sender = (typeof event.sender === 'object' && event.sender !== null ? event.sender : {}) as Record<string, unknown>
  const senderId = (typeof sender.sender_id === 'object' && sender.sender_id !== null
    ? (sender.sender_id as Record<string, unknown>).open_id
    : undefined) ?? sender.sender_id ?? event.sender_id ?? record.sender_id
  const chatId = message.chat_id ?? event.chat_id ?? record.chat_id
  const messageId = message.message_id ?? event.message_id ?? record.message_id
  const senderType = message.sender_type ?? sender.sender_type ?? event.sender_type ?? record.sender_type
  const chatType = message.chat_type ?? event.chat_type ?? record.chat_type
  const content = message.content ?? event.content ?? record.content
  if (typeof chatId !== 'string' || !chatId.startsWith('oc_')
    || typeof messageId !== 'string' || !messageId.startsWith('om_')
    || typeof senderId !== 'string' || typeof senderType !== 'string') {
    return undefined
  }
  return {
    chatId,
    chatType: typeof chatType === 'string' ? chatType : 'p2p',
    senderId,
    senderType,
    messageId,
    text: typeof content === 'string' ? content : '',
  }
}

/**
 * Run one bounded `lark-cli event consume …` and resolve with the first
 * human message, or undefined on timeout/exit/abort. Never rejects — spawn
 * failures are logged and resolve undefined (setup reports them via status).
 */
export function captureOneMessage(options: CaptureOneMessageOptions): Promise<CapturedMessage | undefined> {
  return new Promise<CapturedMessage | undefined>((resolve) => {
    const { logger, bin } = options
    let settled = false

    const finish = (value: CapturedMessage | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      if (!child.killed) stopGroup(child)
      resolve(value)
    }

    const onAbort = (): void => { stopGroup(child) }

    const child = spawn(bin, [
      'event', 'consume', options.eventKey,
      '--as', options.identity,
      '--max-events', '1',
      '--timeout', `${Math.max(1, Math.round(options.timeoutMs / 1000))}s`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...QUIET_ENV },
      detached: true,
    })

    child.on('error', (error) => {
      logger.warn(`[dsh-lark-notify] setup capture failed to spawn ${bin}: ${error.message}`)
      finish(undefined)
    })
    child.on('close', () => { finish(undefined) })

    const timer = setTimeout(() => {
      logger.warn(`[dsh-lark-notify] setup capture timed out after ${options.timeoutMs}ms without a message`)
      finish(undefined)
    }, options.timeoutMs)
    timer.unref?.()

    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const stderrLines = readline.createInterface({ input: child.stderr })
    stderrLines.on('line', (line) => {
      if (line.startsWith('[event] ready') || (line.startsWith('[event]') && line.includes('ready'))) {
        options.onReady?.()
      } else if (line.trim() !== '') {
        logger.debug('[dsh-lark-notify] setup lark-cli stderr:', line)
      }
    })

    const stdoutLines = readline.createInterface({ input: child.stdout })
    stdoutLines.on('line', (line) => {
      // No ready-marker gate: stdout/stderr are separate pipes, so the first
      // event line may legally overtake the marker in the consumer. Strict
      // shape validation (oc_/om_/ou_ prefixes) is the real acceptance test.
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        return
      }
      const message = extractMessage(value)
      if (message === undefined) return
      if (message.senderType === 'bot') {
        logger.debug('[dsh-lark-notify] setup: skipping bot message', message.messageId)
        return
      }
      logger.info(`[dsh-lark-notify] setup captured a message from chat ${message.chatId} (sender ${message.senderId})`)
      finish(message)
    })
  })
}
