/**
 * Category seam: every notification kind is a `Category` — a small
 * interpreter of the durable session events and live agent lifecycle that
 * reports pause begin/settle moments to the engine. Adding a future category
 * means adding one module implementing this interface and listing it in the
 * engine.
 *
 * Phase 2A widens the seam with three optional callbacks without touching
 * the V1 contract:
 * - `agentStatus` observes the second data source (`agent/status`);
 * - `onIdleSettle` participates in the shared idle model (complete/stop
 *   family): the engine schedules one grace window per session after
 *   `agent/status` → `idle` and settles it once the agent stayed idle;
 * - `tick` receives the engine's periodic scan (stall detection).
 * @module dsh-lark-bridge/categories/types
 */

import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionMeta } from '../session-meta.js'
import type { NotificationMessage } from '../transport/types.js'

/** The session facts categories need (a live Session satisfies this). */
export interface SessionRef {
  id: SessionId
  /**
   * True when the session is a subagent child (`origin: 'subagent'`). The
   * idle-model categories (complete / stop family) skip these: a subagent
   * finishing is not "DSH stopped working".
   */
  subagent?: boolean
}

/** The last durable `turn/end` fact of a session (idle-model attribution). */
export interface TurnEndSummary {
  turn: number
  reason: TurnEndReason
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
  /** Idle grace window (ms): an `agent/status` → idle must persist this long before `onIdleSettle`. */
  idleGraceMs(): number
  /** Numeric category config field, falling back to `fallback` when absent/invalid. */
  categoryNumber(categoryId: string, key: string, fallback: number): number
  /** Monotonic clock (ms) used for throttle/stall math. */
  now(): number
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

/** One notification category (permission / question / error / complete / stop:* / retry / stall / …). */
export interface Category {
  readonly id: string
  /** Durable session events (the V1 data source). */
  handle?(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void
  /** Live agent lifecycle transitions (Phase 2A second data source: `agent/status`). */
  agentStatus?(session: SessionRef, status: AgentStatus, engine: CategoryEngine): void
  /**
   * The agent went idle and stayed idle past the idle grace window. `lastTurnEnd`
   * carries the session's most recent `turn/end` for attribution; undefined when
   * the session produced none while observed.
   */
  onIdleSettle?(session: SessionRef, lastTurnEnd: TurnEndSummary | undefined, engine: CategoryEngine): void
  /** Periodic engine tick (used by the stall scanner). */
  tick?(engine: CategoryEngine): void
}
