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
  emitAgentStatus,
  llmRetryEvent,
  sessionId,
  sessionTitleEvent,
  testConfig,
  toolCallEvent,
  toolResultEvent,
  turnEndAbortedEvent,
  turnEndBlockedEvent,
  turnEndCompletedEvent,
  turnEndErrorEvent,
  turnEndInterruptedEvent,
  turnEndMaxTokensEvent,
  updateGoalBlockedEvent,
} from './helpers.js'

function createHarness(configOverrides: Partial<Config> = {}, now: () => number = () => 0) {
  const ctx = new Context()
  const config = testConfig(configOverrides)
  const logger = createLogger()
  const { notifier, messages } = createNotifierStub()
  const timers = createFakeTimers()
  const engine = new PauseEngine({ config, notifier, logger, timeout: timers.timeout, interval: timers.interval, now })
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
        ...testConfig().categories,
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
        ...testConfig().categories,
        permission: { enabled: false, template: 'p' },
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

describe('PauseEngine idle model (complete + stop family)', () => {
  it('notifies completion when the agent stays idle past the idle grace window', () => {
    const { ctx, emit, timers, messages } = createHarness()
    emit(turnEndCompletedEvent(3))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('任务完成')
    expect(messages[0]!.text).toContain('s1')
  })

  it('cancels the idle settlement when the agent returns to running (goal auto-round)', () => {
    const { ctx, emit, timers, messages } = createHarness()
    emit(turnEndCompletedEvent(1))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    timers.fireAll()
    expect(messages).toHaveLength(0)
  })

  it('throttles repeated completions per session', () => {
    let clock = 0
    const { ctx, emit, timers, messages } = createHarness({
      debounceMs: 0,
      categories: { ...testConfig().categories, complete: { enabled: true, template: 'done {turn}', idleGraceMs: 5_000, throttleMs: 1_800_000 } },
    }, () => clock)
    const round = (turn: number): void => {
      emit(turnEndCompletedEvent(turn))
      emitAgentStatus(ctx, sessionId('s1'), 'idle')
      timers.fireAll()
      emitAgentStatus(ctx, sessionId('s1'), 'running')
    }
    round(1)
    expect(messages).toHaveLength(1)
    round(2)
    expect(messages).toHaveLength(1)
    clock += 1_800_001
    round(3)
    expect(messages).toHaveLength(2)
  })

  it('notifies stop:blocked with the latest update_goal blocked_reason', () => {
    const { ctx, emit, timers, messages } = createHarness()
    emit(updateGoalBlockedEvent('waiting for the credentials', 'call-a'))
    emit(turnEndBlockedEvent(4))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('目标阻塞')
    expect(messages[0]!.text).toContain('waiting for the credentials')
  })

  it('falls back to a generic blocked reason without an update_goal detail', () => {
    const { ctx, emit, timers, messages } = createHarness()
    emit(turnEndBlockedEvent(1))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('DSH 目标阻塞')
  })

  it('notifies stop:max-tokens and stop:interrupted', () => {
    const { ctx, emit, timers, messages } = createHarness({ debounceMs: 0 })
    emit(turnEndMaxTokensEvent(2))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('令牌上限')

    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(turnEndInterruptedEvent(5))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(2)
    expect(messages[1]!.text).toContain('异常中断')
  })

  it('suppresses stop:aborted for user/parent causes and notifies hook/disposed/legacy', () => {
    let clock = 0
    const { ctx, emit, timers, messages } = createHarness({ debounceMs: 0 }, () => clock)
    emit(turnEndAbortedEvent(1, { kind: 'user' }))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(0)

    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(turnEndAbortedEvent(2, { kind: 'parent' }))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(0)

    clock += 300_001
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(turnEndAbortedEvent(3, { kind: 'hook', reason: 'policy stop' }))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('hook (policy stop)')

    clock += 300_001
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(turnEndAbortedEvent(4, { kind: 'legacy' }))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(2)
    expect(messages[1]!.text).toContain('legacy')
  })

  it('does not settle when no turn/end was observed', () => {
    const { ctx, timers, messages } = createHarness()
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(0)
  })

  it('skips subagent child sessions in the idle model', () => {
    const { ctx, emit, timers, messages } = createHarness()
    // A subagent child finishing its task is not "DSH stopped working".
    ctx.emit('session/event', { id: sessionId('s2'), header: { origin: 'subagent' } } as Session, turnEndCompletedEvent(1))
    emitAgentStatus(ctx, sessionId('s2'), 'idle', { subagent: true })
    timers.fireAll()
    expect(messages).toHaveLength(0)

    // The top-level session still notifies.
    emit(turnEndCompletedEvent(2))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireAll()
    expect(messages).toHaveLength(1)
  })
})

describe('PauseEngine retry category', () => {
  it('notifies from the attempt threshold with backoff facts', () => {
    const { emit, messages } = createHarness({ debounceMs: 0 })
    emit(llmRetryEvent(1, { maxRetries: 4, delayMs: 9_500, code: 'RATE_LIMIT', status: 429, message: 'busy' }))
    expect(messages).toHaveLength(0)
    emit(llmRetryEvent(2, { maxRetries: 4, delayMs: 9_500, code: 'RATE_LIMIT', status: 429, message: 'busy' }))
    expect(messages).toHaveLength(1)
    const text = messages[0]!.text
    expect(text).toContain('重试')
    expect(text).toContain('2/4')
    expect(text).toContain('10s')
    expect(text).toContain('RATE_LIMIT (HTTP 429)')
  })

  it('renders unbounded always-mode retries without a max label', () => {
    const { emit, messages } = createHarness({ debounceMs: 0 })
    emit(llmRetryEvent(3, { mode: 'always', delayMs: 1_000, code: 'OVERLOADED', message: 'x' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('重试: 3')
    expect(messages[0]!.text).not.toContain('3/')
  })

  it('throttles repeated reminders per session within the interval window', () => {
    let clock = 0
    const { emit, messages } = createHarness({ debounceMs: 0 }, () => clock)
    emit(llmRetryEvent(2))
    emit(llmRetryEvent(3))
    expect(messages).toHaveLength(1)
    clock += 300_001
    emit(llmRetryEvent(4))
    expect(messages).toHaveLength(2)
  })
})

describe('PauseEngine stall scanner', () => {
  it('notifies when a running agent stops producing events for the stall window', () => {
    let clock = 0
    const { ctx, emit, timers, messages } = createHarness({
      categories: { ...testConfig().categories, stall: { enabled: true, template: 'stalled {stalledMin}m {sessionTitle}', stallMs: 10 * 60_000, repeatMs: 60 * 60_000 } },
    }, () => clock)
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(sessionTitleEvent('Long task'))
    clock += 11 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toContain('stalled 11m')
    expect(messages[0]!.text).toContain('Long task')
  })

  it('activity resets the stall clock', () => {
    let clock = 0
    const { ctx, emit, timers, messages } = createHarness({
      categories: { ...testConfig().categories, stall: { enabled: true, template: 'stalled', stallMs: 10 * 60_000, repeatMs: 60 * 60_000 } },
    }, () => clock)
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    clock += 9 * 60_000
    emit(sessionTitleEvent('still working'))
    clock += 9 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(0)
    clock += 2 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(1)
  })

  it('ignores idle sessions and repeats per the reminder window', () => {
    let clock = 0
    const { ctx, emit, timers, messages } = createHarness({
      categories: { ...testConfig().categories, stall: { enabled: true, template: 'stalled', stallMs: 10 * 60_000, repeatMs: 60 * 60_000 } },
    }, () => clock)
    emitAgentStatus(ctx, sessionId('s1'), 'running')
    emit(turnEndCompletedEvent(1))
    clock += 11 * 60_000
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    timers.fireIntervals()
    expect(messages).toHaveLength(0)

    emitAgentStatus(ctx, sessionId('s1'), 'running')
    clock += 11 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(1)
    clock += 10 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(1)
    clock += 50 * 60_000
    timers.fireIntervals()
    expect(messages).toHaveLength(2)
  })
})
