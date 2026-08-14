import { describe, expect, it } from 'vitest'
import { describeError, isErrorEnvelope, isSuccessEnvelope, parseErrorEnvelope, parseSuccessEnvelope } from '../src/transport/envelope.js'

describe('envelope narrowers', () => {
  it('accepts the success envelope shape only', () => {
    expect(isSuccessEnvelope({ ok: true, identity: 'bot' })).toBe(true)
    expect(isSuccessEnvelope({ ok: false })).toBe(false)
    expect(isSuccessEnvelope(null)).toBe(false)
    expect(isSuccessEnvelope('ok')).toBe(false)
  })

  it('accepts the failure envelope shape only', () => {
    expect(isErrorEnvelope({ ok: false, error: { code: 1 } })).toBe(true)
    expect(isErrorEnvelope({ ok: false, error: 'x' })).toBe(false)
    expect(isErrorEnvelope({ ok: true })).toBe(false)
  })
})

describe('parseSuccessEnvelope', () => {
  it('parses a clean stdout envelope', () => {
    expect(parseSuccessEnvelope('{"ok":true,"identity":"bot","data":{"message_id":"om_1"}}')).toMatchObject({ ok: true })
  })

  it('parses the envelope line among surrounding text', () => {
    const stdout = 'notice\n{"ok":true,"identity":"bot"}\n'
    expect(parseSuccessEnvelope(stdout)).toMatchObject({ ok: true })
  })

  it('returns undefined for garbage', () => {
    expect(parseSuccessEnvelope('')).toBeUndefined()
    expect(parseSuccessEnvelope('not json')).toBeUndefined()
    expect(parseSuccessEnvelope('{"ok":false,"error":{}}')).toBeUndefined()
  })
})

describe('parseErrorEnvelope', () => {
  it('parses a clean stderr envelope', () => {
    expect(parseErrorEnvelope('{"ok":false,"error":{"type":"auth","code":999,"message":"bad","hint":"login"}}'))
      .toMatchObject({ ok: false, error: { type: 'auth', hint: 'login' } })
  })

  it('parses the envelope line among notices', () => {
    const stderr = 'WARN update available\n{"ok":false,"error":{"code":1}}\n'
    expect(parseErrorEnvelope(stderr)).toMatchObject({ ok: false })
  })

  it('returns undefined for garbage', () => {
    expect(parseErrorEnvelope('some plain error')).toBeUndefined()
    expect(parseErrorEnvelope('{"ok":true}')).toBeUndefined()
  })
})

describe('describeError', () => {
  it('joins type/subtype/code/message/hint into one line', () => {
    const summary = describeError({
      ok: false,
      error: { type: 'api', subtype: 'missing_scope', code: 999, message: 'scope missing', hint: 'run lark-cli auth login' },
    })
    expect(summary).toBe('lark-cli error (api.missing_scope) code=999: scope missing — hint: run lark-cli auth login')
  })

  it('omits absent facts', () => {
    expect(describeError({ ok: false, error: { message: 'boom' } })).toBe('lark-cli error: boom')
  })
})
