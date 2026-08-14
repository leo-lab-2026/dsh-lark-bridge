import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { PauseEngine } from '../src/engine.js'
import {
  approvalAskedEvent,
  approvalDecidedEvent,
  createFakeTimers,
  createLogger,
  createNotifierStub,
  sessionId,
  sessionTitleEvent,
  testConfig,
  toolCallEvent,
  toolResultEvent,
  turnEndErrorEvent,
} from './helpers.js'

function createHarness(configOverrides: Partial<Config> = {}, now: () => number = () => 0) {
  const ctx = new Context()
  const config = testConfig(configOverrides)
  const logger = createLogger()
  const { notifier, messages } = createNotifierStub()
  const timers = createFakeTimers()
  const engine = new PauseEngine({ config, notifier, logger, timeout: timers.timeout, now })
  engine.install(ctx)
  const session = { id: sessionId('s1') } as Session
  const emit = (event: SessionEvent): void => { ctx.emit('session/event', session, event) }
  return { ctx, engine, logger, messages, timers, session, emit }
}

describe('PauseEngine grace-period race', () => {
  it('cancels the notification when the pause settles within the grace window', () => {
    const { engine, emit, timers, messages } = createHarness()
    emit(approvalAskedEvent('req-1'))
    expect(engine.pendingCount()).toBe(1)
    emit(approvalDecidedEvent('req-1'))
    expect(engine.pendingCount()).toBe(0)
    timers.fireAll()
    expect(messages).toHaveLength(0)
  })

  it('sends one notification when the pause outlives the grace window', () => {
    const { emit, timers, messages } = createHarness()
    emit(approvalAskedEvent('req-1', 'bash', 'needs escalation'))
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('bash')
    expect(messages[0]!.text).toContain('needs escalation')
    expect(messages[0]!.text).toContain('s1')
  })

  it('applies the same race to the question category', () => {
    const { engine, emit, timers, messages } = createHarness()
    const ask = toolCallEvent('ask_user_question', JSON.stringify({ questions: [{ id: 'q1', question: 'Continue?' }] }), 'call-1')
    emit(ask)
    emit(toolResultEvent('call-1'))
    timers.fireAll()
    expect(engine.pendingCount()).toBe(0)
    expect(messages).toHaveLength(0)

    emit(toolCallEvent('ask_user_question', JSON.stringify({ questions: [{ id: 'q2', question: 'Still going?' }] }), 'call-2'))
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('Still going?')
  })
})

describe('PauseEngine debounce', () => {
  it('suppresses a second pause of the same session+category within the window', () => {
    const { emit, timers, messages } = createHarness({ debounceMs: 3_000 })
    emit(approvalAskedEvent('req-1'))
    emit(approvalAskedEvent('req-2'))
    timers.fireAll()
    expect(messages).toHaveLength(1)
  })

  it('sends again once the window expires', () => {
    let clock = 0
    const { emit, timers, messages } = createHarness({ debounceMs: 3_000 }, () => clock)
    emit(approvalAskedEvent('req-1'))
    timers.fireAll()
    expect(messages).toHaveLength(1)
    clock += 4_000
    emit(approvalAskedEvent('req-2'))
    timers.fireAll()
    expect(messages).toHaveLength(2)
  })

  it('a zero window sends every pause', () => {
    const { emit, timers, messages } = createHarness({ debounceMs: 0 })
    emit(approvalAskedEvent('req-1'))
    emit(approvalAskedEvent('req-2'))
    timers.fireAll()
    expect(messages).toHaveLength(2)
  })
})

describe('PauseEngine notifyNow (error category)', () => {
  it('sends immediately without a grace window and throttles repeats per session', () => {
    let clock = 0
    const { emit, messages } = createHarness({}, () => clock)
    emit(turnEndErrorEvent(1, { code: 'RATE_LIMIT', status: 429, message: 'too fast' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('RATE_LIMIT (HTTP 429)')

    emit(turnEndErrorEvent(2, { code: 'RATE_LIMIT', status: 429, message: 'again' }))
    expect(messages).toHaveLength(1)

    clock += 300_001
    emit(turnEndErrorEvent(3, { code: 'RATE_LIMIT', status: 429, message: 'still' }))
    expect(messages).toHaveLength(2)
  })

  it('honors a custom throttle window', () => {
    let clock = 0
    const { emit, messages } = createHarness({
      debounceMs: 0,
      categories: {
        permission: { enabled: true, template: 'p' },
        question: { enabled: true, template: 'q', templateMultiple: 'q', itemTemplate: 'q' },
        error: { enabled: true, template: 'e', throttleMs: 100 },
      },
    }, () => clock)
    emit(turnEndErrorEvent(1))
    clock += 101
    emit(turnEndErrorEvent(2))
    expect(messages).toHaveLength(2)
  })
})

describe('PauseEngine switches and containment', () => {
  it('a disabled category never notifies', () => {
    const { emit, timers, messages } = createHarness({
      categories: {
        permission: { enabled: false, template: 'p' },
        question: { enabled: true, template: 'q', templateMultiple: 'q', itemTemplate: 'q' },
        error: { enabled: false, template: 'e', throttleMs: 1 },
      },
    })
    emit(approvalAskedEvent('req-1'))
    emit(turnEndErrorEvent(1))
    timers.fireAll()
    expect(messages).toHaveLength(0)
  })

  it('uses the cached session title in notifications', () => {
    const { emit, timers, messages } = createHarness()
    emit(sessionTitleEvent('Fix the build'))
    emit(approvalAskedEvent('req-1'))
    timers.fireAll()
    expect(messages[0]!.text).toContain('Fix the build')
  })

  it('contains a throwing render (no send, warn only)', () => {
    const { engine, logger, messages } = createHarness()
    expect(() => engine.notifyNow({ id: sessionId('s1') }, 'error', undefined, () => {
      throw new Error('render boom')
    })).not.toThrow()
    expect(messages).toHaveLength(0)
    expect(logger.calls.some(call => call.level === 'warn' && call.args.some(arg => String(arg).includes('render boom')))).toBe(true)
  })

  it('exposes diagnostics counts', () => {
    const { engine, emit } = createHarness()
    emit(approvalAskedEvent('req-1'))
    expect(engine.pendingCount()).toBe(1)
    emit(sessionTitleEvent('T'))
    expect(engine.watchedSessionCount()).toBe(1)
  })
})
