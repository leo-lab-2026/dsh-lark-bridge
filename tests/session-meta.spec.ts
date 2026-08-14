import { describe, expect, it } from 'vitest'
import { SessionMeta } from '../src/session-meta.js'
import { sessionId, sessionTitleEvent, toolCallEvent } from './helpers.js'

describe('SessionMeta', () => {
  it('caches the latest session/title per session', () => {
    const meta = new SessionMeta()
    meta.observe(sessionId('s1'), sessionTitleEvent('First title'))
    meta.observe(sessionId('s1'), sessionTitleEvent('Second title'))
    meta.observe(sessionId('s2'), sessionTitleEvent('Other session'))
    expect(meta.titleOf(sessionId('s1'))).toBe('Second title')
    expect(meta.titleOf(sessionId('s2'))).toBe('Other session')
    expect(meta.titleOf(sessionId('s3'))).toBeUndefined()
    expect(meta.size()).toBe(2)
  })

  it('ignores blank titles and non-title events', () => {
    const meta = new SessionMeta()
    meta.observe(sessionId('s1'), sessionTitleEvent('   '))
    meta.observe(sessionId('s1'), toolCallEvent('bash', '{}'))
    expect(meta.titleOf(sessionId('s1'))).toBeUndefined()
  })
})
