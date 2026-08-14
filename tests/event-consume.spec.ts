import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from './helpers.js'
import { captureOneMessage, extractMessage } from '../src/transport/event-consume.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-lark-cli.sh', import.meta.url))

const HUMAN_EVENT = JSON.stringify({
  type: 'im.message.receive_v1',
  event_id: 'ev_1',
  message_id: 'om_human',
  chat_id: 'oc_chat_1',
  chat_type: 'p2p',
  message_type: 'text',
  sender_id: 'ou_sender',
  sender_type: 'user',
  content: 'hello bot',
  create_time: '1',
})

const BOT_EVENT = JSON.stringify({
  type: 'im.message.receive_v1',
  message_id: 'om_bot',
  chat_id: 'oc_chat_1',
  chat_type: 'p2p',
  message_type: 'text',
  sender_id: 'ou_bot',
  sender_type: 'bot',
  content: 'echo',
})

const NESTED_EVENT = JSON.stringify({
  schema: '2.0',
  header: { event_type: 'im.message.receive_v1' },
  event: {
    sender: { sender_id: { open_id: 'ou_nested' }, sender_type: 'user' },
    message: { message_id: 'om_nested', chat_id: 'oc_chat_2', chat_type: 'p2p', message_type: 'text', content: 'hi' },
  },
})

function captureOptions(overrides: Partial<Parameters<typeof captureOneMessage>[0]> = {}) {
  const logger = createLogger()
  return {
    bin: fixture,
    eventKey: 'im.message.receive_v1',
    identity: 'bot' as const,
    timeoutMs: 5_000,
    logger,
    ...overrides,
  }
}

describe('extractMessage', () => {
  it('parses the flattened CLI event shape', () => {
    expect(extractMessage(JSON.parse(HUMAN_EVENT))).toEqual({
      chatId: 'oc_chat_1',
      chatType: 'p2p',
      senderId: 'ou_sender',
      senderType: 'user',
      messageId: 'om_human',
      text: 'hello bot',
    })
  })

  it('parses the nested V2 envelope shape', () => {
    expect(extractMessage(JSON.parse(NESTED_EVENT))).toMatchObject({
      chatId: 'oc_chat_2',
      senderId: 'ou_nested',
      messageId: 'om_nested',
    })
  })

  it('rejects malformed records', () => {
    expect(extractMessage(null)).toBeUndefined()
    expect(extractMessage({})).toBeUndefined()
    expect(extractMessage({ message_id: 'om_x' })).toBeUndefined()
    expect(extractMessage({ chat_id: 'not-a-chat', message_id: 'om_x', sender_id: 'ou_x', sender_type: 'user' })).toBeUndefined()
  })
})

describe('captureOneMessage', () => {
  it('captures the first human message and reports the ready marker', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', HUMAN_EVENT)
    const ready = vi.fn()
    const result = await captureOneMessage(captureOptions({ onReady: ready }))
    vi.unstubAllEnvs()
    expect(ready).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ chatId: 'oc_chat_1', senderId: 'ou_sender', text: 'hello bot' })
  })

  it('skips bot messages and keeps waiting (resolves undefined on timeout)', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', BOT_EVENT)
    const logger = createLogger()
    const result = await captureOneMessage(captureOptions({ timeoutMs: 900, logger }))
    vi.unstubAllEnvs()
    expect(result).toBeUndefined()
    expect(logger.calls.some(call => call.message.includes('timed out'))).toBe(true)
  })

  it('resolves undefined when the child exits without a message', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'fail') // exits 3 immediately
    const result = await captureOneMessage(captureOptions())
    vi.unstubAllEnvs()
    expect(result).toBeUndefined()
  })

  it('aborts promptly when the signal fires', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', '')
    const controller = new AbortController()
    const started = Date.now()
    const pending = captureOneMessage(captureOptions({ signal: controller.signal, timeoutMs: 30_000 }))
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    vi.unstubAllEnvs()
    expect(result).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
