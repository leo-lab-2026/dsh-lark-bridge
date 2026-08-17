import { describe, expect, it } from 'vitest'
import { WorkspaceIndex } from '../src/workspace.js'
import { makeWorkspaceRegistry, sessionId } from './helpers.js'

describe('WorkspaceIndex', () => {
  it('indexes sessions to their owning workspace', () => {
    const index = new WorkspaceIndex()
    index.refresh(makeWorkspaceRegistry([
      { title: 'Alpha', path: '/home/u/alpha', sessionIds: ['s1', 's2'] },
      { title: 'Beta', path: '/home/u/beta', sessionIds: ['s3'] },
    ]))
    expect(index.workspaceOf(String(sessionId('s1')))).toEqual({ title: 'Alpha', path: '/home/u/alpha', sessionIds: ['s1', 's2'] })
    expect(index.workspaceOf(String(sessionId('s3')))).toEqual({ title: 'Beta', path: '/home/u/beta', sessionIds: ['s3'] })
    expect(index.workspaceOf(String(sessionId('s9')))).toBeUndefined()
    expect(index.size()).toBe(3)
  })

  it('keeps the first workspace claiming a session on duplicates', () => {
    const index = new WorkspaceIndex()
    index.refresh(makeWorkspaceRegistry([
      { title: 'First', path: '/home/u/first', sessionIds: ['s1'] },
      { title: 'Second', path: '/home/u/second', sessionIds: ['s1'] },
    ]))
    expect(index.workspaceOf(String(sessionId('s1')))!.title).toBe('First')
  })

  it('is a no-op when the registry provider is absent or throws', () => {
    const index = new WorkspaceIndex()
    index.refresh(() => undefined)
    expect(index.size()).toBe(0)
    index.refresh(() => { throw new Error('not ready') })
    expect(index.size()).toBe(0)
  })

  it('rebuilds from scratch on refresh (removes stale sessions)', () => {
    const index = new WorkspaceIndex()
    const registry = makeWorkspaceRegistry([{ title: 'Alpha', path: '/home/u/alpha', sessionIds: ['s1'] }])
    index.refresh(registry)
    expect(index.size()).toBe(1)
    index.refresh(makeWorkspaceRegistry([{ title: 'Alpha', path: '/home/u/alpha', sessionIds: ['s2'] }]))
    expect(index.workspaceOf('s1')).toBeUndefined()
    expect(index.workspaceOf('s2')).toBeDefined()
    expect(index.size()).toBe(1)
  })
})
