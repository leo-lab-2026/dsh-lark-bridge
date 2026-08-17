/**
 * stop category family: complete coverage of the remaining "DSH stopped
 * working" reasons, sharing the Phase 2A idle model with `complete`. Each
 * member matches one `turn/end` reason kind and has its own switch
 * (`categories.stop:*`):
 *
 * - `stop:blocked`     — goal blocked / pre-step rejection. The notification
 *                        detail resolves the most recent `update_goal`
 *                        `action:'blocked'` call's `blocked_reason`.
 * - `stop:max-tokens`  — the output-token ceiling truncated the turn.
 * - `stop:aborted`     — the turn was cancelled from outside. `user`/`parent`
 *                        causes are suppressed (the human is present — noise);
 *                        `hook`/`disposed`/`legacy` notify.
 * - `stop:interrupted` — a crash-orphaned turn was closed on reload. That
 *                        event is produced during load (seed), so live
 *                        broadcasts may never carry it; the watchdog covers
 *                        the process-death blind spot in practice.
 * @module dsh-lark-bridge/categories/stop
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderTemplate } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef, TurnEndSummary } from './types.js'

const DEFAULT_BLOCKED_REASON = 'DSH 目标阻塞（详见会话轮次）'

/** Tolerantly read `blocked_reason` from a raw `update_goal` tool-call JSON. */
function parseBlockedReason(raw: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.action !== 'blocked') return undefined
  if (typeof record.blocked_reason !== 'string') return undefined
  const reason = record.blocked_reason.trim()
  return reason === '' ? undefined : reason
}

interface StopKind {
  id: string
  reasonKind: 'blocked' | 'max-tokens' | 'aborted' | 'interrupted'
}

const KINDS: readonly StopKind[] = [
  { id: 'stop:blocked', reasonKind: 'blocked' },
  { id: 'stop:max-tokens', reasonKind: 'max-tokens' },
  { id: 'stop:aborted', reasonKind: 'aborted' },
  { id: 'stop:interrupted', reasonKind: 'interrupted' },
]

function settle(
  session: SessionRef,
  lastTurnEnd: TurnEndSummary,
  engine: CategoryEngine,
  kind: StopKind,
  blockedReasons: ReadonlyMap<string, string>,
): void {
  const reason = lastTurnEnd.reason
  switch (reason.kind) {
    case 'completed':
    case 'error':
      return
    case 'blocked':
      if (kind.reasonKind !== 'blocked') return
      break
    case 'max-tokens':
      if (kind.reasonKind !== 'max-tokens') return
      break
    case 'aborted':
      if (kind.reasonKind !== 'aborted') return
      break
    case 'interrupted':
      if (kind.reasonKind !== 'interrupted') return
      break
  }
  if (reason.kind === 'aborted' && (reason.reason.kind === 'user' || reason.reason.kind === 'parent')) return
  engine.notifyNow(session, kind.id, String(session.id), () => {
    const vars: Record<string, string | number> = {
      ...engine.commonVars(session),
      turn: lastTurnEnd.turn,
    }
    if (reason.kind === 'blocked') {
      vars.reason = blockedReasons.get(String(session.id)) ?? DEFAULT_BLOCKED_REASON
    }
    if (reason.kind === 'aborted') {
      vars.cancelCause = reason.reason.kind === 'hook' ? `hook (${reason.reason.reason})` : reason.reason.kind
    }
    return {
      text: renderTemplate(engine.templateFor(kind.id), vars),
      idempotencyKey: makeIdempotencyKey([kind.id, String(session.id), String(lastTurnEnd.turn)]),
    }
  })
}

function makeStopCategory(kind: StopKind, blockedReasons: Map<string, string>): Category {
  return {
    id: kind.id,
    ...(kind.reasonKind === 'blocked' ? {
      handle(session: SessionRef, event: SessionEvent): void {
        if (event.type !== 'tool/call' || event.data.name !== 'update_goal') return
        const reason = parseBlockedReason(event.data.arguments)
        if (reason === undefined) return
        blockedReasons.set(String(session.id), reason)
      },
    } : {}),
    onIdleSettle: (session, lastTurnEnd, engine) => {
      if (lastTurnEnd === undefined) return
      if (session.subagent === true) return
      settle(session, lastTurnEnd, engine, kind, blockedReasons)
    },
  }
}

/**
 * Build the four stop-family categories, listed in the engine next to
 * `complete`. Factory (not a module singleton) so engine instances and
 * plugin reloads never share blocked-reason state.
 */
export function createStopCategories(): readonly Category[] {
  const blockedReasons = new Map<string, string>()
  return KINDS.map(kind => makeStopCategory(kind, blockedReasons))
}
