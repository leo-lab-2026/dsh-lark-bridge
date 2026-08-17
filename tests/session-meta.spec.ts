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

  it('remembers a session header working directory', () => {
    const meta = new SessionMeta()
    meta.observeHeader(sessionId('s1'), { cwd: '/home/user/projects/alpha' })
    expect(meta.cwdOf(sessionId('s1'))).toBe('/home/user/projects/alpha')
    expect(meta.cwdOf(sessionId('s2'))).toBeUndefined()
  })

  it('ignores missing or blank cwd values', () => {
    const meta = new SessionMeta()
    meta.observeHeader(sessionId('s1'), undefined)
    meta.observeHeader(sessionId('s1'), { cwd: '   ' })
    expect(meta.cwdOf(sessionId('s1'))).toBeUndefined()
  })

  it('records a session owning workspace and keeps it queryable', () => {
    const meta = new SessionMeta()
    meta.setWorkspace(sessionId('s1'), { title: 'Alpha Project', path: '/home/user/projects/alpha' })
    expect(meta.workspaceOf(sessionId('s1'))).toEqual({ title: 'Alpha Project', path: '/home/user/projects/alpha' })
    expect(meta.workspaceOf(sessionId('s2'))).toBeUndefined()
    expect(meta.workspaceCount()).toBe(1)
  })

  it('ignores an empty workspace record', () => {
    const meta = new SessionMeta()
    meta.setWorkspace(sessionId('s1'), { title: '', path: '' })
    expect(meta.workspaceOf(sessionId('s1'))).toBeUndefined()
  })
})
