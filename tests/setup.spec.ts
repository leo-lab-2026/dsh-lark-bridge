import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from './helpers.js'
import { SetupController, SETUP_FAILURE_HINTS } from '../src/setup.js'
import type { CapturedMessage } from '../src/transport/event-consume.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-lark-cli.sh', import.meta.url))

const HUMAN_EVENT = JSON.stringify({
  type: 'im.message.receive_v1',
  message_id: 'om_human',
  chat_id: 'oc_chat_1',
  chat_type: 'p2p',
  message_type: 'text',
  sender_id: 'ou_sender',
  sender_type: 'user',
  content: 'hello',
})

function makeController(overrides: Partial<ConstructorParameters<typeof SetupController>[0]> = {}) {
  const logger = createLogger()
  const controller = new SetupController({
    bin: fixture,
    identity: 'bot',
    captureTimeoutMs: 5_000,
    logger,
    ...overrides,
  })
  return { controller, logger }
}

describe('SetupController', () => {
  it('captures a message and hands it to onCaptured with a success result', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', HUMAN_EVENT)
    const onCaptured = vi.fn(async (_message: CapturedMessage) => {})
    const { controller } = makeController({ onCaptured })
    const outcome = await controller.run()
    vi.unstubAllEnvs()
    expect(outcome.ok).toBe(true)
    expect(outcome.message).toContain('oc_chat_1')
    expect(onCaptured).toHaveBeenCalledOnce()
    expect(onCaptured.mock.calls[0]![0]).toMatchObject({ chatId: 'oc_chat_1', senderId: 'ou_sender' })
    expect(controller.status()).toMatchObject({ state: 'success', chatId: 'oc_chat_1' })
  })

  it('reports the actionable failure hint when nothing arrives', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', '')
    const { controller } = makeController({ captureTimeoutMs: 900 })
    const outcome = await controller.run()
    vi.unstubAllEnvs()
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe(SETUP_FAILURE_HINTS.empty)
    expect(controller.status()).toMatchObject({ state: 'failed' })
  })

  it('reports a failed state when onCaptured throws', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', HUMAN_EVENT)
    const { controller } = makeController({
      onCaptured: async () => { throw new Error('settings write failed') },
    })
    const outcome = await controller.run()
    vi.unstubAllEnvs()
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('settings write failed')
    expect(controller.status()).toMatchObject({ state: 'failed', chatId: 'oc_chat_1' })
  })

  it('stop() cancels an in-flight run', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', '')
    const { controller } = makeController({ captureTimeoutMs: 30_000 })
    const pending = controller.run()
    setTimeout(() => controller.stop(), 200)
    const outcome = await pending
    vi.unstubAllEnvs()
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('取消')
    expect(controller.status()).toMatchObject({ state: 'idle' })
  })

  it('refuses a second run while one is active', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', '')
    const { controller } = makeController({ captureTimeoutMs: 30_000 })
    const first = controller.run()
    await new Promise(resolve => setTimeout(resolve, 150))
    const second = await controller.run()
    controller.stop()
    await first
    vi.unstubAllEnvs()
    expect(second.ok).toBe(false)
    expect(second.message).toContain('已在监听中')
  })
})
