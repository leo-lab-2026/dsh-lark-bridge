/**
 * stall category: detects a running agent that stopped making progress.
 * The engine owns the periodic scan (`tick`); this category tracks per
 * session the last live activity (any durable session event) and the
 * agent lifecycle status. A session is stalled when its agent stays
 * `running` for `categories.stall.stallMs` without a single event. While
 * the stall persists, one reminder is sent per `categories.stall.repeatMs`.
 *
 * Template variables: common + `{stalledMin}` (floor minutes stalled).
 * @module dsh-lark-bridge/categories/stall
 */

import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { renderTemplate, WORKSPACE_DROP_RULE } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef } from './types.js'

const DEFAULT_STALL_MS = 600_000
const DEFAULT_REPEAT_MS = 3_600_000

/**
 * Build a fresh stall category. Factory (not a module singleton) so engine
 * instances and plugin reloads never share stall state.
 */
export function createStallCategory(): Category {
  const activity = new Map<string, number>()
  const statuses = new Map<string, AgentStatus>()
  const lastNotify = new Map<string, number>()

  return {
    id: 'stall',

    handle(session: SessionRef, _event: SessionEvent, engine: CategoryEngine): void {
      activity.set(String(session.id), engine.now())
    },

    agentStatus(session: SessionRef, status: AgentStatus, engine: CategoryEngine): void {
      const id = String(session.id)
      statuses.set(id, status)
      // Entering a run (or a resumed run) restarts the stall clock.
      if (status === 'running') activity.set(id, engine.now())
    },

    tick(engine: CategoryEngine): void {
      if (!engine.enabled('stall')) return
      const stallMs = engine.categoryNumber('stall', 'stallMs', DEFAULT_STALL_MS)
      const repeatMs = engine.categoryNumber('stall', 'repeatMs', DEFAULT_REPEAT_MS)
      const nowMs = engine.now()
      for (const [id, lastActivity] of activity) {
        if (statuses.get(id) !== 'running') continue
        const stalledFor = nowMs - lastActivity
        if (stalledFor < stallMs) continue
        const previous = lastNotify.get(id)
        if (previous !== undefined && nowMs - previous < repeatMs) continue
        lastNotify.set(id, nowMs)
        const session: SessionRef = { id: id as SessionId }
        engine.notifyNow(session, 'stall', undefined, () => ({
          text: renderTemplate(engine.templateFor('stall'), {
            ...engine.commonVars(session),
            stalledMin: Math.floor(stalledFor / 60_000),
          }, { dropEmptyVarLine: WORKSPACE_DROP_RULE }),
          idempotencyKey: makeIdempotencyKey(['stall', id, String(nowMs)]),
        }))
      }
    },
  }
}
