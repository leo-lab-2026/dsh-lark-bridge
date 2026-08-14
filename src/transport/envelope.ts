/**
 * Parsing for the lark-cli structured output contract (see docs/06 §3):
 * success → stdout `{ok:true, identity, data, meta}` with exit 0;
 * failure → stderr `{ok:false, error:{type, subtype, code, message, hint}}`
 * with a non-zero exit. Success is judged by `ok === true` (or the exit
 * code), never by a `code` field — the success envelope has none.
 * @module dsh-lark-bridge/transport/envelope
 */

/** Structured error facts of a lark-cli failure envelope. */
export interface LarkCliErrorInfo {
  type?: string
  subtype?: string
  code?: number
  message?: string
  hint?: string
}

/** Success envelope: `ok: true`. */
export interface LarkCliSuccessEnvelope {
  ok: true
  identity?: string
  data?: unknown
  meta?: unknown
}

/** Failure envelope: `ok: false` plus structured error facts. */
export interface LarkCliErrorEnvelope {
  ok: false
  error: LarkCliErrorInfo
}

/** Narrow an arbitrary parsed value to the success envelope. */
export function isSuccessEnvelope(value: unknown): value is LarkCliSuccessEnvelope {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
}

/** Narrow an arbitrary parsed value to the failure envelope. */
export function isErrorEnvelope(value: unknown): value is LarkCliErrorEnvelope {
  return typeof value === 'object' && value !== null
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: unknown }).error === 'object'
}

/**
 * Parse the FIRST JSON object found in a text blob. lark-cli guarantees the
 * envelope shape, but stderr may carry notices around the JSON — try the
 * whole text first, then each line, so machine reads stay resilient.
 */
function firstJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to per-line parsing
  }
  for (const line of text.split('\n')) {
    const candidate = line.trim()
    if (candidate.startsWith('{')) {
      try {
        return JSON.parse(candidate)
      } catch {
        // keep scanning
      }
    }
  }
  return undefined
}

/**
 * Parse the first JSON object of a text blob (any shape). Some lark-cli
 * surfaces (e.g. `auth status`) print facts without the `{ok}` wrapper.
 */
export function parseFirstJson(text: string): unknown {
  return firstJsonObject(text)
}

/** Extract the success envelope from lark-cli stdout, or undefined. */
export function parseSuccessEnvelope(stdout: string): LarkCliSuccessEnvelope | undefined {
  const value = firstJsonObject(stdout)
  return isSuccessEnvelope(value) ? value : undefined
}

/** Extract the failure envelope from lark-cli stderr, or undefined. */
export function parseErrorEnvelope(stderr: string): LarkCliErrorEnvelope | undefined {
  const value = firstJsonObject(stderr)
  return isErrorEnvelope(value) ? value : undefined
}

/** Human-readable one-line summary of a failure envelope (for logs/status). */
export function describeError(envelope: LarkCliErrorEnvelope): string {
  const error = envelope.error
  const kind = [error.type, error.subtype].filter((part): part is string => typeof part === 'string' && part !== '').join('.')
  const head = `lark-cli error${kind !== '' ? ` (${kind})` : ''}${typeof error.code === 'number' ? ` code=${error.code}` : ''}`
  const message = typeof error.message === 'string' && error.message !== '' ? `: ${error.message}` : ''
  const hint = typeof error.hint === 'string' && error.hint !== '' ? ` — hint: ${error.hint}` : ''
  return head + message + hint
}
