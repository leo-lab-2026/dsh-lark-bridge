import { describe, expect, it } from 'vitest'
import { errorCategory } from '../src/categories/error.js'
import { permissionCategory } from '../src/categories/permission.js'
import { parseQuestions, questionCategory } from '../src/categories/question.js'
import type { CategoryEngine, SessionRef } from '../src/categories/types.js'
import {
  DEFAULT_ERROR_TEMPLATE,
  DEFAULT_PERMISSION_TEMPLATE,
  DEFAULT_QUESTION_ITEM_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE,
  DEFAULT_QUESTION_TEMPLATE_MULTIPLE,
} from '../src/config.js'
import { SessionMeta } from '../src/session-meta.js'
import type { NotificationMessage } from '../src/transport/types.js'
import {
  approvalAskedEvent,
  approvalDecidedEvent,
  sessionId,
  toolCallEvent,
  toolResultEvent,
  turnEndCompletedEvent,
  turnEndErrorEvent,
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
      return DEFAULT_ERROR_TEMPLATE
    },
    graceMs: 500,
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
    permissionCategory.handle(session, approvalAskedEvent('req-1', 'bash', 'writes outside the workspace'), engine)
    expect(begins).toHaveLength(1)
    expect(begins[0]).toMatchObject({ categoryId: 'permission', key: 'approval:req-1' })
    const text = begins[0]!.make().text
    expect(text).toContain('bash')
    expect(text).toContain('writes outside the workspace')
    expect(text).toContain('Session One')
    expect(text).toContain('http://127.0.0.1:3080')

    permissionCategory.handle(session, approvalDecidedEvent('req-1'), engine)
    expect(settles).toEqual(['approval:req-1'])
  })

  it('renders an empty reason placeholder without one', () => {
    const { engine, begins } = createEngineStub()
    permissionCategory.handle(session, approvalAskedEvent('req-2', 'fs'), engine)
    expect(begins[0]!.make().text).toContain('原因:')
  })

  it('ignores unrelated events', () => {
    const { engine, begins } = createEngineStub()
    permissionCategory.handle(session, turnEndCompletedEvent(), engine)
    permissionCategory.handle(session, toolCallEvent('bash', '{}'), engine)
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
    questionCategory.handle(session, toolCallEvent('ask_user_question', askArgs, 'call-1'), engine)
    expect(begins).toHaveLength(1)
    expect(begins[0]).toMatchObject({ categoryId: 'question', key: 'question:call-1' })
    const text = begins[0]!.make().text
    expect(text).toContain('Confirm')
    expect(text).toContain('Proceed with the deploy?')
    expect(text).toContain('Yes (Recommended) — deploy now')
    expect(text).toContain('No')

    questionCategory.handle(session, toolResultEvent('call-1'), engine)
    expect(settles).toEqual(['question:call-1'])
  })

  it('drops the Options line when the question has no options', () => {
    const { engine, begins } = createEngineStub()
    const args = JSON.stringify({ questions: [{ id: 'q1', question: 'What is your name?' }] })
    questionCategory.handle(session, toolCallEvent('ask_user_question', args), engine)
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
    questionCategory.handle(session, toolCallEvent('ask_user_question', args), engine)
    const text = begins[0]!.make().text
    expect(text).toContain('1. First')
    expect(text).toContain('Question A?')
    expect(text).toContain('2. Second')
    expect(text).toContain('Question B?')
  })

  it('ignores non-ask tool calls and malformed argument JSON', () => {
    const { engine, begins } = createEngineStub()
    questionCategory.handle(session, toolCallEvent('bash', '{}'), engine)
    questionCategory.handle(session, toolCallEvent('ask_user_question', '{not json'), engine)
    questionCategory.handle(session, toolCallEvent('ask_user_question', '{"questions":[]}'), engine)
    expect(begins).toHaveLength(0)
  })

  it('settles only the matching tool result', () => {
    const { engine, settles } = createEngineStub()
    questionCategory.handle(session, toolResultEvent('call-other'), engine)
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
    errorCategory.handle(session, turnEndErrorEvent(3, { code: 'RATE_LIMIT', status: 429, message: 'too fast' }), engine)
    expect(nows).toHaveLength(1)
    expect(nows[0]).toMatchObject({ categoryId: 'error', throttleKey: 's1' })
    const text = nows[0]!.make().text
    expect(text).toContain('RATE_LIMIT (HTTP 429)')
    expect(text).toContain('too fast')
  })

  it('renders a failure without a status using the bare code', () => {
    const { engine, nows } = createEngineStub()
    errorCategory.handle(session, turnEndErrorEvent(1, { code: 'UNKNOWN', message: 'boom' }), engine)
    expect(nows[0]!.make().text).toContain('[UNKNOWN]')
  })

  it('ignores non-error turn endings', () => {
    const { engine, nows } = createEngineStub()
    errorCategory.handle(session, turnEndCompletedEvent(), engine)
    errorCategory.handle(session, approvalAskedEvent('r'), engine)
    expect(nows).toHaveLength(0)
  })
})
