/**
 * Session metadata cache: folds the durable `session/title` events into the
 * latest title per session. Titles only decorate notification text — a
 * missing title falls back to the session id.
 * @module dsh-lark-bridge/session-meta
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

export class SessionMeta {
  private readonly titles = new Map<string, string>()

  /** Fold one live session event (no-op unless it is a title event). */
  observe(sessionId: SessionId, event: SessionEvent): void {
    if (event.type !== 'session/title') return
    const title = event.data.title.trim()
    if (title === '') return
    this.titles.set(String(sessionId), title)
  }

  /** Latest known title for a session, or undefined. */
  titleOf(sessionId: SessionId): string | undefined {
    return this.titles.get(String(sessionId))
  }

  /** Number of sessions with a cached title (diagnostics). */
  size(): number {
    return this.titles.size
  }
}
