import { describe, expect, it } from 'vitest'
import { completeCategory } from '../src/categories/complete.js'
import { errorCategory } from '../src/categories/error.js'
import { permissionCategory } from '../src/categories/permission.js'
import { parseQuestions, questionCategory } from '../src/categories/question.js'
import { retryCategory } from '../src/categories/retry.js'
import { createStallCategory } from '../src/categories/stall.js'
import { createStopCategories } from '../src/categories/stop.js'
import type { CategoryEngine, SessionRef } from '../src/categories/types.js'
import {
  DEFAULT_COMPLETE_TEMPLATE,
  DEFAULT_ERROR_TEMPLATE,
  DEFAULT_PERMISSION_TEMPLATE,
  DEFAULT_QUESTION_ITEM_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
  DEFAULT_RETRY_TEMPLATE,
  DEFAULT_STALL_TEMPLATE,
  DEFAULT_STOP_ABORTED_TEMPLATE,
  DEFAULT_STOP_BLOCKED_TEMPLATE,
  DEFAULT_STOP_INTERRUPTED_TEMPLATE,
  DEFAULT_STOP_MAX_TOKENS_TEMPLATE,
} from '../src/config.js'
import { SessionMeta } from '../src/session-meta.js'
import type { NotificationMessage } from '../src/transport/types.js'
import {
  approvalAskedEvent,
  approvalDecidedEvent,
  llmRetryEvent,
  sessionId,
  toolCallEvent,
  toolResultEvent,
  turnEndCompletedEvent,
  turnEndErrorEvent,
  updateGoalBlockedEvent,
} from './helpers.js'

const session: SessionRef = { id: sessionId('s1') }

function createEngineStub() {
  const begins: { session: SessionRef; categoryId: string; key: string; make: () => NotificationMessage }[] = []
  const settles: string[] = []
  const nows: { session: SessionRef; categoryId: string; throttleKey: string | undefined; make: () => NotificationMessage }[] = []
  const engine: CategoryEngine = {
    meta: new SessionMeta(),
    enabled: () => true,
    templateFor: (id, kind = 'template') => {
      if (kind === 'templateMultiple') return DEFAULT_QUESTION_TEMPLATE_MULTIPLE
      if (kind === 'itemTemplate') return DEFAULT_QUESTION_ITEM_TEMPLATE
      if (id === 'permission') return DEFAULT_PERMISSION_TEMPLATE
      if (id === 'question') return DEFAULT_QUESTION_TEMPLATE
      if (id === 'complete') return DEFAULT_COMPLETE_TEMPLATE
      if (id === 'stop:blocked') return DEFAULT_STOP_BLOCKED_TEMPLATE
      if (id === 'stop:max-tokens') return DEFAULT_STOP_MAX_TOKENS_TEMPLATE
      if (id === 'stop:aborted') return DEFAULT_STOP_ABORTED_TEMPLATE
      if (id === 'stop:interrupted') return DEFAULT_STOP_INTERRUPTED_TEMPLATE
      if (id === 'retry') return DEFAULT_RETRY_TEMPLATE
      if (id === 'stall') return DEFAULT_STALL_TEMPLATE
      return DEFAULT_ERROR_TEMPLATE
    },
    graceMs: 500,
    idleGraceMs: () => 5_000,
    categoryNumber: (id, key, fallback) => {
      if (id === 'retry' && key === 'retryThreshold') return 2
      if (id === 'stall' && key === 'stallMs') return 600_000
      if (id === 'stall' && key === 'repeatMs') return 3_600_000
      return fallback
    },
    now: () => 0,
    beginPause: (subject, categoryId, key, make) => { begins.push({ session: subject, categoryId, key, make }) },
    settlePause: (key) => { settles.push(key) },
    notifyNow: (subject, categoryId, throttleKey, make) => { nows.push({ session: subject, categoryId, throttleKey, make }) },
    commonVars: subject => ({
      sessionId: String(subject.id),
      sessionTitle: 'Session One',
      webUrl: 'http://127.0.0.1:3080',
      time: '10:00:00',
    }),
  }
  return { engine, begins, settles, nows }
}

describe('permissionCategory', () => {
  it('begins a pause on approval/asked and settles on the paired decision', () => {
    const { engine, begins, settles } = createEngineStub()
    permissionCategory.handle!(session, approvalAskedEvent('req-1', 'bash', 'writes outside the workspace'), engine)
    expect(begins).toHaveLength(1)
    expect(begins[0]).toMatchObject({ categoryId: 'permission', key: 'approval:req-1' })
    const text = begins[0]!.make().text
    expect(text).toContain('bash')
    expect(text).toContain('writes outside the workspace')
    expect(text).toContain('Session One')
    expect(text).toContain('http://127.0.0.1:3080')

    permissionCategory.handle!(session, approvalDecidedEvent('req-1'), engine)
    expect(settles).toEqual(['approval:req-1'])
  })

  it('renders an empty reason placeholder without one', () => {
    const { engine, begins } = createEngineStub()
    permissionCategory.handle!(session, approvalAskedEvent('req-2', 'fs'), engine)
    expect(begins[0]!.make().text).toContain('原因:')
  })

  it('ignores unrelated events', () => {
    const { engine, begins } = createEngineStub()
    permissionCategory.handle!(session, turnEndCompletedEvent(), engine)
    permissionCategory.handle!(session, toolCallEvent('bash', '{}'), engine)
    expect(begins).toHaveLength(0)
  })
})

describe('questionCategory', () => {
  const askArgs = JSON.stringify({
    questions: [{
      id: 'q1',
      header: 'Confirm',
      question: 'Proceed with the deploy?',
      options: [
        { label: 'Yes (Recommended)', description: 'deploy now' },
        { label: 'No' },
      ],
    }],
  })

  it('begins a pause on an ask_user_question tool call and settles on its result', () => {
    const { engine, begins, settles } = createEngineStub()
    questionCategory.handle!(session, toolCallEvent('ask_user_question', askArgs, 'call-1'), engine)
    expect(begins).toHaveLength(1)
    expect(begins[0]).toMatchObject({ categoryId: 'question', key: 'question:call-1' })
    const text = begins[0]!.make().text
    expect(text).toContain('Confirm')
    expect(text).toContain('Proceed with the deploy?')
    expect(text).toContain('Yes (Recommended) — deploy now')
    expect(text).toContain('No')

    questionCategory.handle!(session, toolResultEvent('call-1'), engine)
    expect(settles).toEqual(['question:call-1'])
  })

  it('drops the Options line when the question has no options', () => {
    const { engine, begins } = createEngineStub()
    const args = JSON.stringify({ questions: [{ id: 'q1', question: 'What is your name?' }] })
    questionCategory.handle!(session, toolCallEvent('ask_user_question', args), engine)
    const text = begins[0]!.make().text
    expect(text).toContain('What is your name?')
    expect(text).not.toContain('Options:')
  })

  it('renders multiple questions through the multi-question template', () => {
    const { engine, begins } = createEngineStub()
    const args = JSON.stringify({
      questions: [
        { id: 'q1', header: 'First', question: 'Question A?', options: [{ label: 'A1' }] },
        { id: 'q2', header: 'Second', question: 'Question B?' },
      ],
    })
    questionCategory.handle!(session, toolCallEvent('ask_user_question', args), engine)
    const text = begins[0]!.make().text
    expect(text).toContain('1. First')
    expect(text).toContain('Question A?')
    expect(text).toContain('2. Second')
    expect(text).toContain('Question B?')
  })

  it('ignores non-ask tool calls and malformed argument JSON', () => {
    const { engine, begins } = createEngineStub()
    questionCategory.handle!(session, toolCallEvent('bash', '{}'), engine)
    questionCategory.handle!(session, toolCallEvent('ask_user_question', '{not json'), engine)
    questionCategory.handle!(session, toolCallEvent('ask_user_question', '{"questions":[]}'), engine)
    expect(begins).toHaveLength(0)
  })

  it('settles only the matching tool result', () => {
    const { engine, settles } = createEngineStub()
    questionCategory.handle!(session, toolResultEvent('call-other'), engine)
    expect(settles).toEqual(['question:call-other'])
  })
})

describe('parseQuestions', () => {
  it('tolerantly parses questions and skips malformed entries', () => {
    const parsed = parseQuestions(JSON.stringify({
      questions: [
        { id: 'a', question: '  A?  ', header: 'H', options: [{ label: '  X  ', description: '  d  ' }, { label: '' }] },
        { question: 'B?' },
        { question: '   ' },
        'garbage',
      ],
    }))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'a', question: 'A?', header: 'H' })
    expect(parsed[0]!.options).toEqual([{ label: 'X', description: 'd' }])
    expect(parsed[1]).toMatchObject({ question: 'B?' })
  })

  it('returns empty for invalid JSON and non-array payloads', () => {
    expect(parseQuestions('nope')).toEqual([])
    expect(parseQuestions('{"questions":{}}')).toEqual([])
    expect(parseQuestions('42')).toEqual([])
  })
})

describe('errorCategory', () => {
  it('notifies on a fatal turn/end with the failure facts and the HTTP status', () => {
    const { engine, nows } = createEngineStub()
    errorCategory.handle!(session, turnEndErrorEvent(3, { code: 'RATE_LIMIT', status: 429, message: 'too fast' }), engine)
    expect(nows).toHaveLength(1)
    expect(nows[0]).toMatchObject({ categoryId: 'error', throttleKey: 's1' })
    const text = nows[0]!.make().text
    expect(text).toContain('RATE_LIMIT (HTTP 429)')
    expect(text).toContain('too fast')
  })

  it('renders a failure without a status using the bare code', () => {
    const { engine, nows } = createEngineStub()
    errorCategory.handle!(session, turnEndErrorEvent(1, { code: 'UNKNOWN', message: 'boom' }), engine)
    expect(nows[0]!.make().text).toContain('[UNKNOWN]')
  })

  it('ignores non-error turn endings', () => {
    const { engine, nows } = createEngineStub()
    errorCategory.handle!(session, turnEndCompletedEvent(), engine)
    errorCategory.handle!(session, approvalAskedEvent('r'), engine)
    expect(nows).toHaveLength(0)
  })
})

describe('completeCategory', () => {
  it('notifies on idle settlement after a completed turn', () => {
    const { engine, nows } = createEngineStub()
    completeCategory.onIdleSettle!(session, { turn: 7, reason: { kind: 'completed' } }, engine)
    expect(nows).toHaveLength(1)
    expect(nows[0]).toMatchObject({ categoryId: 'complete', throttleKey: 's1' })
    expect(nows[0]!.make().text).toContain('任务完成')
    expect(nows[0]!.make().text).toContain('7')
  })

  it('stays silent for other turn endings and missing attribution', () => {
    const { engine, nows } = createEngineStub()
    completeCategory.onIdleSettle!(session, { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'X' } } }, engine)
    completeCategory.onIdleSettle!(session, undefined, engine)
    expect(nows).toHaveLength(0)
  })
})

describe('stopCategories', () => {
  const stopCategories = createStopCategories()
  const blocked = stopCategories.find(category => category.id === 'stop:blocked')!
  const maxTokens = stopCategories.find(category => category.id === 'stop:max-tokens')!
  const aborted = stopCategories.find(category => category.id === 'stop:aborted')!
  const interrupted = stopCategories.find(category => category.id === 'stop:interrupted')!

  it('registers the four stop kinds', () => {
    expect(stopCategories.map(category => category.id).sort())
      .toEqual(['stop:aborted', 'stop:blocked', 'stop:interrupted', 'stop:max-tokens'].sort())
  })

  it('stop:blocked notifies with the captured update_goal blocked_reason', () => {
    const { engine, nows } = createEngineStub()
    blocked.handle!(session, updateGoalBlockedEvent('missing API token', 'call-9'), engine)
    blocked.onIdleSettle!(session, { turn: 4, reason: { kind: 'blocked' } }, engine)
    expect(nows).toHaveLength(1)
    expect(nows[0]).toMatchObject({ categoryId: 'stop:blocked', throttleKey: 's1' })
    expect(nows[0]!.make().text).toContain('missing API token')
  })

  it('stop:blocked ignores non-blocked update_goal calls and malformed JSON', () => {
    const { engine, nows } = createEngineStub()
    blocked.handle!(session, toolCallEvent('update_goal', JSON.stringify({ action: 'pause' })), engine)
    blocked.handle!(session, toolCallEvent('update_goal', '{not json'), engine)
    blocked.onIdleSettle!(session, { turn: 1, reason: { kind: 'blocked' } }, engine)
    expect(nows[0]!.make().text).toContain('DSH 目标阻塞')
  })

  it('each stop kind notifies only for its own reason', () => {
    const { engine, nows } = createEngineStub()
    maxTokens.onIdleSettle!(session, { turn: 2, reason: { kind: 'max-tokens' } }, engine)
    maxTokens.onIdleSettle!(session, { turn: 2, reason: { kind: 'blocked' } }, engine)
    interrupted.onIdleSettle!(session, { turn: 5, reason: { kind: 'interrupted' } }, engine)
    expect(nows.map(entry => entry.categoryId)).toEqual(['stop:max-tokens', 'stop:interrupted'])
    expect(nows[0]!.make().text).toContain('令牌上限')
    expect(nows[1]!.make().text).toContain('异常中断')
  })

  it('stop:aborted suppresses user/parent and renders hook/disposed causes', () => {
    const { engine, nows } = createEngineStub()
    aborted.onIdleSettle!(session, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, engine)
    aborted.onIdleSettle!(session, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'parent' } } }, engine)
    expect(nows).toHaveLength(0)
    aborted.onIdleSettle!(session, { turn: 3, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'sandbox guard' } } }, engine)
    aborted.onIdleSettle!(session, { turn: 4, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }, engine)
    expect(nows).toHaveLength(2)
    expect(nows[0]!.make().text).toContain('hook (sandbox guard)')
    expect(nows[1]!.make().text).toContain('disposed')
  })
})

describe('retryCategory', () => {
  it('stays silent below the threshold and notifies at it', () => {
    const { engine, nows } = createEngineStub()
    retryCategory.handle!(session, llmRetryEvent(1, { maxRetries: 4 }), engine)
    expect(nows).toHaveLength(0)
    retryCategory.handle!(session, llmRetryEvent(2, { maxRetries: 4, delayMs: 5_500, code: 'RATE_LIMIT', status: 429, message: 'busy' }), engine)
    expect(nows).toHaveLength(1)
    expect(nows[0]).toMatchObject({ categoryId: 'retry', throttleKey: 's1' })
    const text = nows[0]!.make().text
    expect(text).toContain('2/4')
    expect(text).toContain('6s')
    expect(text).toContain('RATE_LIMIT (HTTP 429)')
    expect(text).toContain('busy')
  })

  it('ignores unrelated session events', () => {
    const { engine, nows } = createEngineStub()
    retryCategory.handle!(session, turnEndErrorEvent(1), engine)
    expect(nows).toHaveLength(0)
  })
})

describe('stallCategory', () => {
  it('tracks activity and status, then notifies through the tick when stalled', () => {
    const stall = createStallCategory()
    let clock = 0
    const base = createEngineStub()
    const engine: CategoryEngine = { ...base.engine, now: () => clock }
    stall.handle!(session, turnEndCompletedEvent(1), engine)
    stall.agentStatus!(session, 'running', engine)
    clock = 11 * 60_000
    stall.tick!(engine)
    expect(base.nows).toHaveLength(1)
    expect(base.nows[0]).toMatchObject({ categoryId: 'stall', throttleKey: undefined })
    expect(base.nows[0]!.make().text).toContain('11 分钟')
  })

  it('skips idle sessions and resets on fresh activity', () => {
    const stall = createStallCategory()
    let clock = 0
    const base = createEngineStub()
    const engine: CategoryEngine = { ...base.engine, now: () => clock }
    stall.agentStatus!(session, 'running', engine)
    stall.agentStatus!(session, 'idle', engine)
    clock = 11 * 60_000
    stall.tick!(engine)
    expect(base.nows).toHaveLength(0)

    stall.agentStatus!(session, 'running', engine)
    clock = 11 * 60_000
    stall.handle!(session, turnEndCompletedEvent(2), engine)
    stall.tick!(engine)
    expect(base.nows).toHaveLength(0)
    clock = 22 * 60_000
    stall.tick!(engine)
    expect(base.nows).toHaveLength(1)
  })
})
