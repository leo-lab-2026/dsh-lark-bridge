/**
 * Shared test fixtures: typed session-event constructors, stub factories,
 * and a default config builder.
 * @module dsh-lark-bridge/tests/helpers
 */

import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { TurnEndCancelCause, SessionEvent, SessionEventMap, SessionEventType, SessionId, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { settingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import {
  DEFAULT_COMPLETE_TEMPLATE,
  DEFAULT_ERROR_TEMPLATE,
  DEFAULT_GOODBYE_TEMPLATE,
  DEFAULT_PERMISSION_TEMPLATE,
  DEFAULT_QUESTION_ITEM_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
  DEFAULT_RETRY_TEMPLATE,
  DEFAULT_STALL_TEMPLATE,
  DEFAULT_STOP_ABORTED_TEMPLATE,
  DEFAULT_STOP_BLOCKED_TEMPLATE,
  DEFAULT_STOP_INTERRUPTED_TEMPLATE,
  DEFAULT_STOP_MAX_TOKENS_TEMPLATE,
  type Config,
} from '../src/config.js'
import type { PluginLogger } from '../src/logger.js'
import type { NotificationMessage, Notifier } from '../src/transport/types.js'

export function sessionId(value: string): SessionId {
  return value as SessionId
}

/** In-memory settings provider: real settings resolution without file I/O. */
export class MemorySettingsProvider extends SettingsProvider {
  override readonly writable = true
  /** Seed the stored document BEFORE mounting (simulates an existing settings.yaml). */
  static initialDocument: Record<string, unknown> = {}
  private storedDocument: Record<string, unknown> = MemorySettingsProvider.initialDocument

  protected override async load(): Promise<Record<string, unknown>> {
    return this.storedDocument
  }

  protected override async persist(ns: ReturnType<typeof settingsNamespace>, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[String(ns)] = section
  }
}

export function callId(value: string): CallId {
  return value as CallId
}

export function approvalId(value: string): ApprovalRequestId {
  return value as ApprovalRequestId
}

/** Build one durable session event envelope. */
export function event<K extends SessionEventType>(type: K, data: SessionEventMap[K], seq = 1, time = 1): SessionEvent<K> {
  return { type, seq, time, data } as SessionEvent<K>
}

export function approvalAskedEvent(id: string, toolName = 'bash', reason?: string): SessionEvent<'approval/asked'> {
  return event('approval/asked', {
    id: approvalId(id),
    toolName,
    ...(reason !== undefined ? { reason } : {}),
  })
}

export function approvalDecidedEvent(id: string, outcome: ApprovalOutcome = 'allowed-once'): SessionEvent<'approval/decided'> {
  return event('approval/decided', { id: approvalId(id), outcome })
}

export function toolCallEvent(name: string, argumentsJson: string, id = 'call-1'): SessionEvent<'tool/call'> {
  return event('tool/call', { turn: 1, step: 1, callId: callId(id), name, arguments: argumentsJson })
}

export function toolResultEvent(id: string): SessionEvent<'tool/result'> {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId(id), content: [] }],
    } as unknown as ToolResultMessage,
  })
}

export function turnEndErrorEvent(turn = 1, options: { message?: string; code?: string; status?: number } = {}): SessionEvent<'turn/end'> {
  return event('turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: {
        message: options.message ?? 'provider exploded',
        code: options.code ?? 'PROVIDER_HTTP_ERROR',
        ...(options.status !== undefined ? { status: options.status } : {}),
      },
    },
  })
}

export function turnEndCompletedEvent(turn = 1): SessionEvent<'turn/end'> {
  return event('turn/end', { turn, reason: { kind: 'completed' } })
}

export function turnEndBlockedEvent(turn = 1): SessionEvent<'turn/end'> {
  return event('turn/end', { turn, reason: { kind: 'blocked' } })
}

export function turnEndMaxTokensEvent(turn = 1): SessionEvent<'turn/end'> {
  return event('turn/end', { turn, reason: { kind: 'max-tokens' } })
}

export function turnEndAbortedEvent(turn = 1, cause: TurnEndCancelCause = { kind: 'user' }): SessionEvent<'turn/end'> {
  return event('turn/end', { turn, reason: { kind: 'aborted', reason: cause } })
}

export function turnEndInterruptedEvent(turn = 1): SessionEvent<'turn/end'> {
  return event('turn/end', { turn, reason: { kind: 'interrupted' } })
}

export function updateGoalBlockedEvent(blockedReason = 'waiting for credentials', call = 'goal-call-1'): SessionEvent<'tool/call'> {
  return toolCallEvent('update_goal', JSON.stringify({
    goal_id: 'goal-1',
    revision: 2,
    action: 'blocked',
    blocked_reason: blockedReason,
  }), call)
}

export function llmRetryEvent(
  retry: number,
  options: { maxRetries?: number; delayMs?: number; mode?: 'normal' | 'always'; code?: string; status?: number; message?: string; turn?: number } = {},
): SessionEvent<'llm/retry'> {
  const mode = options.mode ?? 'normal'
  const failure = {
    message: options.message ?? 'provider busy',
    code: options.code ?? 'RATE_LIMIT',
    ...(options.status !== undefined ? { status: options.status } : {}),
  }
  const base = {
    retryId: `retry-${retry}` as never,
    turn: options.turn ?? 1,
    step: 1,
    provider: 'deepseek',
    mode,
    policyKey: 'k',
    retry,
    delayMs: options.delayMs ?? 5_000,
    failure,
  }
  const data: LlmRetryEventData = mode === 'normal'
    ? { ...base, maxRetries: options.maxRetries ?? 4 }
    : base as Extract<LlmRetryEventData, { mode: 'always' }>
  return event('llm/retry', data)
}

/**
 * Emit a scoped `agent/status` event visible to root-context listeners
 * (mirrors `agentEvents(ctx, agent).emit('agent/status', …)` — the scope
 * carrier admits untagged listeners globally).
 */
export function emitAgentStatus(ctx: Context, id: SessionId, status: AgentStatus, options: { subagent?: boolean } = {}): void {
  const session = {
    id,
    ...(options.subagent === true ? { header: { origin: 'subagent' as const } } : {}),
  }
  const agent = { id, session } as unknown as Agent
  const carrier = scopeTarget(agent, {})
  ctx.emit(carrier, 'agent/status', { agent, status })
}

export function sessionTitleEvent(title: string): SessionEvent<'session/title'> {
  return event('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
}

/** Fully-defaulted config (what the schema yields) with optional top-level overrides. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    target: { chatId: '', userId: '' },
    webUrl: 'http://127.0.0.1:3080',
    identity: 'bot',
    bin: 'lark-cli',
    timeoutMs: 30_000,
    graceMs: 500,
    debounceMs: 3_000,
    dryRun: false,
    setupTimeoutMs: 180_000,
    goodbye: { enabled: true, template: DEFAULT_GOODBYE_TEMPLATE },
    watchdog: { enabled: false, heartbeatFile: '', intervalMs: 5_000 },
    categories: {
      permission: { enabled: true, template: DEFAULT_PERMISSION_TEMPLATE },
      question: {
        enabled: true,
        template: DEFAULT_QUESTION_TEMPLATE,
        templateMultiple: DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
        itemTemplate: DEFAULT_QUESTION_ITEM_TEMPLATE,
      },
      error: { enabled: true, template: DEFAULT_ERROR_TEMPLATE, throttleMs: 300_000 },
      complete: { enabled: true, template: DEFAULT_COMPLETE_TEMPLATE, idleGraceMs: 5_000, throttleMs: 1_800_000 },
      'stop:blocked': { enabled: true, template: DEFAULT_STOP_BLOCKED_TEMPLATE, throttleMs: 300_000 },
      'stop:max-tokens': { enabled: true, template: DEFAULT_STOP_MAX_TOKENS_TEMPLATE, throttleMs: 300_000 },
      'stop:aborted': { enabled: true, template: DEFAULT_STOP_ABORTED_TEMPLATE, throttleMs: 300_000 },
      'stop:interrupted': { enabled: true, template: DEFAULT_STOP_INTERRUPTED_TEMPLATE, throttleMs: 300_000 },
      retry: { enabled: true, template: DEFAULT_RETRY_TEMPLATE, retryThreshold: 2, intervalMs: 300_000 },
      stall: { enabled: true, template: DEFAULT_STALL_TEMPLATE, stallMs: 600_000, repeatMs: 3_600_000 },
    },
    ...overrides,
  }
}

export interface LogCall {
  level: string
  message: string
  args: unknown[]
}

/** Logger stub that records calls. */
export function createLogger(): PluginLogger & { calls: LogCall[] } {
  const calls: LogCall[] = []
  const make = (level: string) => (message: string, ...args: unknown[]): void => {
    calls.push({ level, message, args })
  }
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), calls }
}

/** Notifier stub that records messages. */
export function createNotifierStub(): { notifier: Notifier; messages: NotificationMessage[] } {
  const messages: NotificationMessage[] = []
  const notifier: Notifier = {
    send: vi.fn(async (message: NotificationMessage) => {
      messages.push(message)
      return true
    }),
    status: () => ({ sent: messages.length, failed: 0 }),
  }
  return { notifier, messages }
}

/** Fake timer factory: records scheduled callbacks; fire() runs non-cancelled ones. */
export function createFakeTimers(): {
  timeout: (callback: () => void, ms: number) => () => void
  interval: (callback: () => void, ms: number) => () => void
  scheduled: () => { ms: number; cancelled: boolean }[]
  fireAll: () => void
  fireIntervals: () => void
} {
  interface Entry { callback: () => void; ms: number; cancelled: boolean; repeating: boolean }
  const entries: Entry[] = []
  const timeout = (callback: () => void, ms: number): (() => void) => {
    const entry: Entry = { callback, ms, cancelled: false, repeating: false }
    entries.push(entry)
    return () => { entry.cancelled = true }
  }
  // Intervals persist across firings until explicitly disposed.
  const interval = (callback: () => void, ms: number): (() => void) => {
    const entry: Entry = { callback, ms, cancelled: false, repeating: true }
    entries.push(entry)
    return () => { entry.cancelled = true }
  }
  const scheduled = () => entries.filter(entry => !entry.cancelled).map(entry => ({ ms: entry.ms, cancelled: entry.cancelled }))
  const fireAll = () => {
    for (const entry of entries) {
      if (entry.cancelled) continue
      if (!entry.repeating) entry.cancelled = true
      entry.callback()
    }
  }
  const fireIntervals = () => {
    for (const entry of entries) {
      if (entry.cancelled || !entry.repeating) continue
      entry.callback()
    }
  }
  return { timeout, interval, scheduled, fireAll, fireIntervals }
}
