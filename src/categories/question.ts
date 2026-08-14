/**
 * question category: notifies when the model pauses on `ask_user_question`
 * (the model-facing consumer of the `ctx.userQuestions` seam — this also
 * covers plan-mode plan reviews). Durable facts: `tool/call` with the tool
 * name opens the pause (its `arguments` JSON carries the questions);
 * the matching `tool/result` (same `toolCallId`) closes it. Delegated
 * subagents asking questions fail instantly (`DELEGATED_CALLER`), so their
 * result settles within the grace window and stays silent.
 * @module dsh-lark-bridge/categories/question
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { renderOptions, renderTemplate, type RenderOption } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { NotificationMessage } from '../transport/types.js'
import type { Category, CategoryEngine, SessionRef } from './types.js'

/** A question after tolerant parsing of the raw tool arguments. */
export interface ParsedQuestion {
  id: string
  question: string
  header?: string
  options?: RenderOption[]
}

/**
 * Parse the raw `arguments` JSON string of an ask_user_question tool call.
 * Malformed payloads yield an empty list (category stays silent).
 */
export function parseQuestions(raw: string): ParsedQuestion[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  // The tool arguments JSON is an object wrapping the questions array
  // ({"questions":[...]}); tolerate a bare array as well.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    value = (value as Record<string, unknown>).questions
  }
  if (!Array.isArray(value)) return []
  const questions: ParsedQuestion[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.question !== 'string' || record.question.trim() === '') continue
    const parsed: ParsedQuestion = {
      id: typeof record.id === 'string' ? record.id : `q${questions.length}`,
      question: record.question.trim(),
    }
    if (typeof record.header === 'string' && record.header.trim() !== '') parsed.header = record.header.trim()
    if (Array.isArray(record.options)) {
      const options: RenderOption[] = []
      for (const option of record.options) {
        if (typeof option !== 'object' || option === null) continue
        const raw = option as Record<string, unknown>
        if (typeof raw.label !== 'string' || raw.label.trim() === '') continue
        options.push({
          label: raw.label.trim(),
          ...(typeof raw.description === 'string' && raw.description.trim() !== '' ? { description: raw.description.trim() } : {}),
        })
      }
      parsed.options = options
    }
    questions.push(parsed)
  }
  return questions
}

function buildMessage(engine: CategoryEngine, session: SessionRef, questions: ParsedQuestion[]): NotificationMessage {
  const common = engine.commonVars(session)
  let text: string
  if (questions.length === 1) {
    const question = questions[0]!
    text = renderTemplate(engine.templateFor('question'), {
      ...common,
      header: question.header ?? '问题',
      question: question.question,
      options: renderOptions(question.options),
    }, { dropEmptyOptionsLine: true })
  } else {
    const itemTemplate = engine.templateFor('question', 'itemTemplate')
    const items = questions.map((question, index) =>
      renderTemplate(itemTemplate, {
        number: index + 1,
        header: question.header ?? '问题',
        question: question.question,
        options: renderOptions(question.options),
      }, { dropEmptyOptionsLine: true }),
    ).join('\n')
    text = renderTemplate(engine.templateFor('question', 'templateMultiple'), {
      ...common,
      questions: items,
    })
  }
  return {
    text,
    idempotencyKey: makeIdempotencyKey(['question', String(session.id), ...questions.map(question => question.id)]),
  }
}

export const questionCategory: Category = {
  id: 'question',

  handle(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      const questions = parseQuestions(event.data.arguments)
      if (questions.length === 0) return
      const key = `question:${String(event.data.callId)}`
      engine.beginPause(session, 'question', key, () => buildMessage(engine, session, questions))
      return
    }
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      if (block !== undefined && block.type === 'tool-result') {
        engine.settlePause(`question:${String(block.toolCallId)}`)
      }
    }
  },
}
