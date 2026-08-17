/**
 * complete category: notifies when a task finished and DSH stopped working.
 * Phase 2A idle model: the engine watches `agent/status` and calls
 * `onIdleSettle` once the agent stayed idle past the idle grace window
 * (which filters goal auto-continuation rounds and `/loop` followups).
 * This category notifies only when the session's last `turn/end` is
 * `completed`. Repeats are throttled per session (`categories.complete.throttleMs`).
 * @module dsh-lark-bridge/categories/complete
 */

import { renderTemplate } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef, TurnEndSummary } from './types.js'

export const completeCategory: Category = {
  id: 'complete',

  onIdleSettle(session: SessionRef, lastTurnEnd: TurnEndSummary | undefined, engine: CategoryEngine): void {
    if (lastTurnEnd === undefined || lastTurnEnd.reason.kind !== 'completed') return
    // Subagent children finishing is routine — only the top-level agent
    // going idle means "DSH stopped working" from the user's view.
    if (session.subagent === true) return
    engine.notifyNow(session, 'complete', String(session.id), () => ({
      text: renderTemplate(engine.templateFor('complete'), {
        ...engine.commonVars(session),
        turn: lastTurnEnd.turn,
      }),
      idempotencyKey: makeIdempotencyKey(['complete', String(session.id), String(lastTurnEnd.turn)]),
    }))
  },
}
