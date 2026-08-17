import { describe, expect, it } from 'vitest'
import { matchRoute, upsertRoute } from '../src/routing.js'

const routes = [
  { title: 'Alpha', path: '/home/u/alpha', chatId: 'oc_alpha', userId: '' },
  { title: 'Beta', path: '/home/u/beta', chatId: '', userId: 'ou_beta' },
]

describe('matchRoute', () => {
  it('matches by exact workspace title', () => {
    expect(matchRoute(routes, { title: 'Alpha', path: '/home/u/alpha' })).toEqual({ chatId: 'oc_alpha' })
  })

  it('falls back to path matching after a rename', () => {
    // Title changed but path identical → path match keeps routing stable.
    expect(matchRoute(routes, { title: 'Alpha Renamed', path: '/home/u/alpha' })).toEqual({ chatId: 'oc_alpha' })
  })

  it('returns the user target when chatId is empty', () => {
    expect(matchRoute(routes, { title: 'Beta', path: '/home/u/beta' })).toEqual({ userId: 'ou_beta' })
  })

  it('returns undefined when nothing matches', () => {
    expect(matchRoute(routes, { title: 'Gamma', path: '/home/u/gamma' })).toBeUndefined()
    expect(matchRoute(routes, undefined)).toBeUndefined()
  })

  it('does not match an empty-title route entry', () => {
    const withEmpty = [...routes, { title: '', path: '/home/u/gamma', chatId: 'oc_gamma', userId: '' }]
    expect(matchRoute(withEmpty, { title: '', path: '/home/u/gamma' })).toEqual({ chatId: 'oc_gamma' })
  })
})

describe('upsertRoute', () => {
  it('replaces an existing entry for the same path (rename rebind)', () => {
    const next = upsertRoute(routes, { title: 'Alpha Renamed', path: '/home/u/alpha', chatId: 'oc_new', userId: '' })
    expect(next).toHaveLength(2)
    expect(next.find(route => route.path === '/home/u/alpha')).toEqual({
      title: 'Alpha Renamed', path: '/home/u/alpha', chatId: 'oc_new', userId: '',
    })
  })

  it('replaces an existing entry for the same title', () => {
    const next = upsertRoute(routes, { title: 'Alpha', path: '/home/u/alpha', chatId: 'oc_new', userId: '' })
    expect(next).toHaveLength(2)
    expect(next.find(route => route.title === 'Alpha')!.chatId).toBe('oc_new')
  })

  it('appends a new workspace binding', () => {
    const next = upsertRoute(routes, { title: 'Gamma', path: '/home/u/gamma', chatId: 'oc_gamma', userId: '' })
    expect(next).toHaveLength(3)
    expect(next[2]).toEqual({ title: 'Gamma', path: '/home/u/gamma', chatId: 'oc_gamma', userId: '' })
  })
})
