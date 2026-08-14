/**
 * error category: notifies when a turn ends fatally (`turn/end` with
 * `reason.kind === 'error'`) — the moment a session stops and waits for the
 * human. Covers non-retryable model failures (400/401/403, quota, retries
 * exhausted): the failure arrives as an `LlmFailure` with a stable `code`
 * and an optional HTTP `status` (100-599) captured by the adapter.
 * Transient model errors that lark-cli's retry policy recovers automatically
 * never reach `turn/end` with an error (future `retry` category).
 *
 * Terminal event: no grace window; repeats per session are throttled by
 * `categories.error.throttleMs`.
 * @module dsh-lark-bridge/categories/error
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderTemplate } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef } from './types.js'

export const errorCategory: Category = {
  id: 'error',

  handle(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void {
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
    const failure = event.data.reason.error
    const hasStatus = typeof failure.status === 'number'
    engine.notifyNow(session, 'error', String(session.id), () => ({
      text: renderTemplate(engine.templateFor('error'), {
        ...engine.commonVars(session),
        errorLabel: hasStatus ? `${failure.code} (HTTP ${failure.status})` : failure.code,
        errorCode: failure.code,
        errorStatus: hasStatus ? `HTTP ${failure.status}` : '',
        errorMessage: failure.message,
        turn: event.data.turn,
      }),
      idempotencyKey: makeIdempotencyKey(['error', String(session.id), String(event.data.turn)]),
    }))
  },
}
