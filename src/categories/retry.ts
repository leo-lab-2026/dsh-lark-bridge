/**
 * retry category: notifies when provider-routed request recovery backs off —
 * the self-healing pause kind. Durable `llm/retry` events (appended by
 * `dsh-llm-retry` before each cancellable wait) are broadcast live through
 * the session event stream. Notifications fire from the configured attempt
 * threshold (`categories.retry.retryThreshold`) and repeat at most once per
 * session within the interval throttle (`categories.retry.intervalMs`).
 *
 * Template variables: common + `{retry}` `{maxRetries}` `{maxRetriesLabel}`
 * `{delaySec}` `{provider}` `{mode}` `{errorLabel}` `{errorCode}`
 * `{errorStatus}` `{errorMessage}` `{turn}`. `maxRetries`/`maxRetriesLabel`
 * are empty for `mode: 'always'` (unbounded) policies.
 * @module dsh-lark-bridge/categories/retry
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { renderTemplate } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef } from './types.js'

const DEFAULT_RETRY_THRESHOLD = 2

export const retryCategory: Category = {
  id: 'retry',

  handle(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void {
    if (event.type !== 'llm/retry') return
    const data = event.data
    const threshold = engine.categoryNumber('retry', 'retryThreshold', DEFAULT_RETRY_THRESHOLD)
    if (data.retry < threshold) return
    const failure = data.failure
    const hasStatus = typeof failure.status === 'number'
    engine.notifyNow(session, 'retry', String(session.id), () => ({
      text: renderTemplate(engine.templateFor('retry'), {
        ...engine.commonVars(session),
        retry: data.retry,
        maxRetries: data.mode === 'normal' ? data.maxRetries : '',
        maxRetriesLabel: data.mode === 'normal' ? `/${data.maxRetries}` : '',
        delaySec: Math.max(0, Math.round(data.delayMs / 1000)),
        provider: data.provider,
        mode: data.mode,
        errorLabel: hasStatus ? `${failure.code} (HTTP ${failure.status})` : failure.code,
        errorCode: failure.code,
        errorStatus: hasStatus ? `HTTP ${failure.status}` : '',
        errorMessage: failure.message,
        turn: data.turn,
      }),
      idempotencyKey: makeIdempotencyKey(['retry', String(session.id), String(data.turn), String(data.step), String(data.retry)]),
    }))
  },
}
