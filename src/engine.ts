/**
 * PauseEngine: the notification orchestration core.
 *
 * - Owns the single `session/event` listener (global, read-only observation
 *   — it never intercepts or alters DSH behavior).
 * - Phase 2A adds the second data source `agent/status`: the engine tracks
 *   the latest `turn/end` per session, and when an agent goes `idle` it arms
 *   an idle grace window. When the window expires with the agent still idle,
 *   the last `turn/end` is offered to every category's `onIdleSettle`
 *   (complete + stop family attribution). A return to `running` cancels the
 *   window — this filters goal auto-continuation rounds and `/loop` followups.
 * - Runs the periodic `tick` scan (stall detection) on an injected interval.
 * - Dispatches every event to the installed categories and the session-title
 *   cache; every failure is contained (logs only).
 * - Mechanics shared by all categories: enabled switches, grace-period
 *   begin/settle race, per-session-per-category debounce, throttle windows,
 *   rendering containment, and fire-and-forget delivery.
 *
 * All timers go through the injected `timeout`/`interval` (the cordis timer
 * service in production), so plugin unload disposes them automatically.
 * @module dsh-lark-bridge/engine
 */

import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { completeCategory } from './categories/complete.js'
import { errorCategory } from './categories/error.js'
import { permissionCategory } from './categories/permission.js'
import { questionCategory } from './categories/question.js'
import { retryCategory } from './categories/retry.js'
import { createStallCategory } from './categories/stall.js'
import { createStopCategories } from './categories/stop.js'
import type { Category, CategoryEngine, SessionRef, TurnEndSummary } from './categories/types.js'
import type { Config } from './config.js'
import type { PluginLogger } from './logger.js'
import { SessionMeta } from './session-meta.js'
import type { Notifier, NotificationMessage } from './transport/types.js'

/** Timer seam: schedule a callback, return a disposer that cancels it. */
export type TimeoutFn = (callback: () => void, delay: number) => () => void

export interface PauseEngineOptions {
  config: Config
  notifier: Notifier
  logger: PluginLogger
  timeout: TimeoutFn
  /** Repeating timer seam (cordis `ctx.interval`); used for the stall scan. */
  interval: TimeoutFn
  now?: () => number
}

const DEFAULT_THROTTLE_MS = 300_000
const DEFAULT_IDLE_GRACE_MS = 5_000
const DEFAULT_STALL_MS = 600_000
/** Upper bound for the stall scan cadence (the scan itself is near-free). */
const MAX_SCAN_INTERVAL_MS = 60_000

/** Structural read of `session.header.origin` (Session / Agent.session both carry it). */
function isSubagentSession(value: unknown): boolean {
  const header = (value as { header?: { origin?: string } } | null | undefined)?.header
  return header?.origin === 'subagent'
}

export class PauseEngine implements CategoryEngine {
  readonly meta = new SessionMeta()
  private readonly pending = new Map<string, () => void>()
  private readonly lastSent = new Map<string, number>()
  private readonly lastThrottled = new Map<string, number>()
  private readonly agentStatuses = new Map<string, AgentStatus>()
  private readonly lastTurnEnds = new Map<string, TurnEndSummary>()
  private readonly idleTimers = new Map<string, () => void>()
  private readonly subagentSessions = new Set<string>()
  private readonly clock: () => number
  private readonly categories: readonly Category[] = [
    permissionCategory,
    questionCategory,
    errorCategory,
    completeCategory,
    ...createStopCategories(),
    retryCategory,
    createStallCategory(),
  ]

  constructor(private readonly options: PauseEngineOptions) {
    this.clock = options.now ?? Date.now
  }

  get graceMs(): number {
    return this.options.config.graceMs
  }

  /** Install the global listeners (session events + agent status) and the stall scan. */
  install(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      try {
        this.dispatch(session, event)
      } catch (error) {
        // A notifier must never break the harness event dispatch.
        this.options.logger.error('[dsh-lark-notify] handler failure (contained)', error)
      }
    })
    ctx.on('agent/status', ({ agent, status }) => {
      try {
        this.onAgentStatus(agent.id, isSubagentSession(agent.session), status)
      } catch (error) {
        this.options.logger.error('[dsh-lark-notify] agent/status handler failure (contained)', error)
      }
    })
    this.options.interval(() => {
      this.tickAll()
    }, this.scanIntervalMs())
  }

  private dispatch(session: SessionRef, event: SessionEvent): void {
    this.meta.observe(session.id, event)
    if (isSubagentSession(session)) this.subagentSessions.add(String(session.id))
    if (event.type === 'turn/end') {
      this.lastTurnEnds.set(String(session.id), { turn: event.data.turn, reason: event.data.reason })
    }
    for (const category of this.categories) {
      if (category.handle === undefined) continue
      try {
        category.handle(session, event, this)
      } catch (error) {
        this.options.logger.warn(`[dsh-lark-notify] category "${category.id}" failure (contained)`, error)
      }
    }
  }

  private onAgentStatus(sessionId: SessionId, subagent: boolean, status: AgentStatus): void {
    const id = String(sessionId)
    this.agentStatuses.set(id, status)
    if (subagent) this.subagentSessions.add(id)
    const pendingIdle = this.idleTimers.get(id)
    if (pendingIdle !== undefined) {
      pendingIdle()
      this.idleTimers.delete(id)
    }
    const session: SessionRef = { id: sessionId, ...(this.subagentSessions.has(id) ? { subagent: true } : {}) }
    if (status === 'idle') {
      // Settle after the grace window unless the agent wakes again: goal
      // auto-continuation and /loop followups re-enter `running` within it.
      const dispose = this.options.timeout(() => {
        this.idleTimers.delete(id)
        if (this.agentStatuses.get(id) !== 'idle') return
        this.settleIdle(session, this.lastTurnEnds.get(id))
      }, this.idleGraceMs())
      this.idleTimers.set(id, dispose)
    }
    for (const category of this.categories) {
      if (category.agentStatus === undefined) continue
      try {
        category.agentStatus(session, status, this)
      } catch (error) {
        this.options.logger.warn(`[dsh-lark-notify] category "${category.id}" agent-status failure (contained)`, error)
      }
    }
  }

  private settleIdle(session: SessionRef, lastTurnEnd: TurnEndSummary | undefined): void {
    for (const category of this.categories) {
      if (category.onIdleSettle === undefined) continue
      try {
        category.onIdleSettle(session, lastTurnEnd, this)
      } catch (error) {
        this.options.logger.warn(`[dsh-lark-notify] category "${category.id}" idle-settle failure (contained)`, error)
      }
    }
  }

  private tickAll(): void {
    for (const category of this.categories) {
      if (category.tick === undefined) continue
      try {
        category.tick(this)
      } catch (error) {
        this.options.logger.warn(`[dsh-lark-notify] category "${category.id}" tick failure (contained)`, error)
      }
    }
  }

  private scanIntervalMs(): number {
    const stallMs = this.categoryNumber('stall', 'stallMs', DEFAULT_STALL_MS)
    return Math.max(1_000, Math.min(stallMs / 4, MAX_SCAN_INTERVAL_MS))
  }

  // ---- CategoryEngine implementation ------------------------------------

  enabled(categoryId: string): boolean {
    const category = (this.options.config.categories as Record<string, unknown>)[categoryId]
    if (category !== null && typeof category === 'object') {
      const enabled = (category as Record<string, unknown>).enabled
      if (typeof enabled === 'boolean') return enabled
    }
    return true
  }

  templateFor(categoryId: string, kind: 'template' | 'templateMultiple' | 'itemTemplate' = 'template'): string {
    const category = (this.options.config.categories as Record<string, unknown>)[categoryId]
    if (category !== null && typeof category === 'object') {
      const value = (category as Record<string, unknown>)[kind]
      if (typeof value === 'string' && value.trim() !== '') return value
    }
    if (kind === 'templateMultiple') return this.templateFor(categoryId, 'template')
    if (kind === 'itemTemplate') return '{number}. {header}\n   {question}\n   Options: {options}'
    return 'DSH 需要你的处理\n会话: {sessionTitle} ({sessionId})\n→ {webUrl}'
  }

  idleGraceMs(): number {
    return this.categoryNumber('complete', 'idleGraceMs', DEFAULT_IDLE_GRACE_MS)
  }

  categoryNumber(categoryId: string, key: string, fallback: number): number {
    const category = (this.options.config.categories as Record<string, unknown>)[categoryId]
    if (category !== null && typeof category === 'object') {
      const value = (category as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return fallback
  }

  now(): number {
    return this.clock()
  }

  beginPause(session: SessionRef, categoryId: string, key: string, make: () => NotificationMessage): void {
    if (!this.enabled(categoryId) || this.pending.has(key)) return
    const dispose = this.options.timeout(() => {
      this.pending.delete(key)
      this.emit(session, categoryId, make)
    }, this.options.config.graceMs)
    this.pending.set(key, dispose)
  }

  settlePause(key: string): void {
    const dispose = this.pending.get(key)
    if (dispose === undefined) return
    this.pending.delete(key)
    dispose()
  }

  notifyNow(session: SessionRef, categoryId: string, throttleKey: string | undefined, make: () => NotificationMessage): void {
    if (!this.enabled(categoryId)) return
    if (throttleKey !== undefined) {
      // Namespace by category: per-session throttles must not collide across
      // categories (complete / stop:* / error / retry all pass the session id).
      const key = `${categoryId}:${throttleKey}`
      const nowMs = this.clock()
      const last = this.lastThrottled.get(key)
      if (last !== undefined && nowMs - last < this.throttleMs(categoryId)) return
      this.lastThrottled.set(key, nowMs)
    }
    this.emit(session, categoryId, make)
  }

  commonVars(session: SessionRef): Record<string, string> {
    const sessionId = String(session.id)
    return {
      sessionId,
      sessionTitle: this.meta.titleOf(session.id) ?? sessionId,
      webUrl: this.options.config.webUrl,
      time: new Date(this.clock()).toTimeString().slice(0, 8),
    }
  }

  // ---- internals ----------------------------------------------------------

  private throttleMs(categoryId: string): number {
    const category = (this.options.config.categories as Record<string, unknown>)[categoryId]
    if (category !== null && typeof category === 'object') {
      const record = category as Record<string, unknown>
      for (const key of ['throttleMs', 'intervalMs']) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
      }
    }
    return DEFAULT_THROTTLE_MS
  }

  private emit(session: SessionRef, categoryId: string, make: () => NotificationMessage): void {
    const nowMs = this.clock()
    const debounceKey = `${categoryId}:${String(session.id)}`
    const last = this.lastSent.get(debounceKey)
    if (last !== undefined && nowMs - last < this.options.config.debounceMs) return
    this.lastSent.set(debounceKey, nowMs)

    let message: NotificationMessage
    try {
      message = make()
    } catch (error) {
      this.options.logger.warn(`[dsh-lark-notify] "${categoryId}" render failure (contained)`, error)
      return
    }
    this.options.logger.info(`[dsh-lark-notify] ${categoryId}: ${message.text.replaceAll('\n', ' | ')}`)
    void this.options.notifier.send(message).catch((error: unknown) => {
      this.options.logger.warn('[dsh-lark-notify] send rejected (contained)', error)
    })
  }

  // ---- diagnostics ---------------------------------------------------------

  /** Number of pauses currently waiting out their grace window. */
  pendingCount(): number {
    return this.pending.size
  }

  /** Number of sessions with a cached title. */
  watchedSessionCount(): number {
    return this.meta.size()
  }

  /** Number of sessions whose agent went idle and still await their idle grace window. */
  idleWaitCount(): number {
    return this.idleTimers.size
  }

  /** Number of sessions whose agent lifecycle status is tracked. */
  trackedSessionCount(): number {
    return this.agentStatuses.size
  }
}
