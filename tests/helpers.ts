/**
 * Shared test fixtures: typed session-event constructors, stub factories,
 * and a default config builder.
 * @module dsh-lark-bridge/tests/helpers
 */

import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionEventType, SessionId, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { settingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import { vi } from 'vitest'
import {
  DEFAULT_ERROR_TEMPLATE,
  DEFAULT_PERMISSION_TEMPLATE,
  DEFAULT_QUESTION_ITEM_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
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
    categories: {
      permission: { enabled: true, template: DEFAULT_PERMISSION_TEMPLATE },
      question: {
        enabled: true,
        template: DEFAULT_QUESTION_TEMPLATE,
        templateMultiple: DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
        itemTemplate: DEFAULT_QUESTION_ITEM_TEMPLATE,
      },
      error: { enabled: true, template: DEFAULT_ERROR_TEMPLATE, throttleMs: 300_000 },
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

/** Fake timeout factory: records scheduled callbacks; fire() runs non-cancelled ones. */
export function createFakeTimers(): {
  timeout: (callback: () => void, ms: number) => () => void
  scheduled: () => { ms: number; cancelled: boolean }[]
  fireAll: () => void
} {
  interface Entry { callback: () => void; ms: number; cancelled: boolean }
  const entries: Entry[] = []
  const timeout = (callback: () => void, ms: number): (() => void) => {
    const entry: Entry = { callback, ms, cancelled: false }
    entries.push(entry)
    return () => { entry.cancelled = true }
  }
  const scheduled = () => entries.filter(entry => !entry.cancelled).map(entry => ({ ms: entry.ms, cancelled: entry.cancelled }))
  const fireAll = () => {
    for (const entry of entries) {
      if (entry.cancelled) continue
      entry.cancelled = true
      entry.callback()
    }
  }
  return { timeout, scheduled, fireAll }
}
