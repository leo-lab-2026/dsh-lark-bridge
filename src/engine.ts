/**
 * PauseEngine: the notification orchestration core.
 *
 * - Owns the single `session/event` listener (global, read-only observation
 *   — it never intercepts or alters DSH behavior).
 * - Dispatches every event to the installed categories and the session-title
 *   cache; every failure is contained (logs only).
 * - Mechanics shared by all categories: enabled switches, grace-period
 *   begin/settle race, per-session-per-category debounce, throttle windows,
 *   rendering containment, and fire-and-forget delivery.
 *
 * All timers go through the injected `timeout` (the cordis timer service in
 * production), so plugin unload disposes them automatically.
 * @module dsh-lark-bridge/engine
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { errorCategory } from './categories/error.js'
import { permissionCategory } from './categories/permission.js'
import { questionCategory } from './categories/question.js'
import type { Category, CategoryEngine, SessionRef } from './categories/types.js'
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
  now?: () => number
}

const DEFAULT_THROTTLE_MS = 300_000

export class PauseEngine implements CategoryEngine {
  readonly meta = new SessionMeta()
  private readonly pending = new Map<string, () => void>()
  private readonly lastSent = new Map<string, number>()
  private readonly lastThrottled = new Map<string, number>()
  private readonly now: () => number
  private readonly categories: readonly Category[] = [
    permissionCategory,
    questionCategory,
    errorCategory,
  ]

  constructor(private readonly options: PauseEngineOptions) {
    this.now = options.now ?? Date.now
  }

  get graceMs(): number {
    return this.options.config.graceMs
  }

  /** Install the single global session/event listener. */
  install(ctx: Context): void {
    ctx.on('session/event', (session, event) => {
      try {
        this.dispatch(session, event)
      } catch (error) {
        // A notifier must never break the harness event dispatch.
        this.options.logger.error('[dsh-lark-notify] handler failure (contained)', error)
      }
    })
  }

  private dispatch(session: SessionRef, event: SessionEvent): void {
    this.meta.observe(session.id, event)
    for (const category of this.categories) {
      try {
        category.handle(session, event, this)
      } catch (error) {
        this.options.logger.warn(`[dsh-lark-notify] category "${category.id}" failure (contained)`, error)
      }
    }
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
      const nowMs = this.now()
      const last = this.lastThrottled.get(throttleKey)
      if (last !== undefined && nowMs - last < this.throttleMs(categoryId)) return
      this.lastThrottled.set(throttleKey, nowMs)
    }
    this.emit(session, categoryId, make)
  }

  commonVars(session: SessionRef): Record<string, string> {
    const sessionId = String(session.id)
    return {
      sessionId,
      sessionTitle: this.meta.titleOf(session.id) ?? sessionId,
      webUrl: this.options.config.webUrl,
      time: new Date(this.now()).toTimeString().slice(0, 8),
    }
  }

  // ---- internals ----------------------------------------------------------

  private throttleMs(categoryId: string): number {
    const category = (this.options.config.categories as Record<string, unknown>)[categoryId]
    if (category !== null && typeof category === 'object') {
      const value = (category as Record<string, unknown>).throttleMs
      if (typeof value === 'number' && value >= 0) return value
    }
    return DEFAULT_THROTTLE_MS
  }

  private emit(session: SessionRef, categoryId: string, make: () => NotificationMessage): void {
    const nowMs = this.now()
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
}
