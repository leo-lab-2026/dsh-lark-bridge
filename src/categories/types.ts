/**
 * Category seam: every notification kind is a `Category` — a small
 * interpreter of durable session events that reports pause begin/settle
 * moments to the engine. Adding a future category (retry, stall, …) means
 * adding one module implementing this interface and listing it in the engine.
 * @module dsh-lark-bridge/categories/types
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionMeta } from '../session-meta.js'
import type { NotificationMessage } from '../transport/types.js'

/** The session facts categories need (a live Session satisfies this). */
export interface SessionRef {
  id: SessionId
}

/**
 * Engine surface consumed by categories. It owns all notification mechanics
 * (enabled checks, grace-period race, debounce, throttle, logging, send).
 */
export interface CategoryEngine {
  readonly meta: SessionMeta
  /** Category switch from config. */
  enabled(categoryId: string): boolean
  /** Template text of a category (template/templateMultiple/itemTemplate). */
  templateFor(categoryId: string, kind?: 'template' | 'templateMultiple' | 'itemTemplate'): string
  /** Grace window (ms) applied to begin/settle races. */
  readonly graceMs: number
  /**
   * Begin a resolvable pause: `make` is only invoked (and the notification
   * only sent) when the pause outlives the grace window. `settlePause(key)`
   * cancels it.
   */
  beginPause(session: SessionRef, categoryId: string, key: string, make: () => NotificationMessage): void
  /** Cancel a pending pause by key (no-op when absent). */
  settlePause(key: string): void
  /**
   * Notify immediately (terminal events). `throttleKey` dedupes repeats
   * within the category's throttle window; undefined disables throttling.
   */
  notifyNow(session: SessionRef, categoryId: string, throttleKey: string | undefined, make: () => NotificationMessage): void
  /** Common template variables ({sessionId} {sessionTitle} {webUrl} {time}). */
  commonVars(session: SessionRef): Record<string, string>
}

/** One notification category (permission / question / error / …). */
export interface Category {
  readonly id: string
  handle(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void
}
