import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { registerDebugCommand } from '../src/command.js'
import type { PauseEngine } from '../src/engine.js'
import { SetupController } from '../src/setup.js'
import { LarkCliTransport } from '../src/transport/lark-cli.js'
import type { ProcessResult, RunProcessOptions } from '../src/transport/spawn.js'
import { createLogger, testConfig } from './helpers.js'

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

interface Runtime {
  definition: CommandDefinition
  handler: (rawInput: string, agent?: unknown) => Promise<{ kind: 'success' | 'error'; text?: string }>
  ctx: Context
  setup: SetupController
  routeSetup: SetupController
  routeBind: { workspace: { title: string; path: string } | undefined }
  state: { target: { chatId: string; userId: string }; dryRun: boolean }
}

async function createRuntime(options: { targetChatId?: string; dryRun?: boolean } = {}): Promise<Runtime> {
  const ctx = new Context()
  const logger = createLogger()
  const state = {
    target: { chatId: options.targetChatId ?? 'oc_t', userId: '' },
    dryRun: options.dryRun ?? false,
  }
  const transport = new LarkCliTransport({
    bin: fixture,
    identity: 'bot',
    timeoutMs: 30_000,
    target: () => state.target,
    dryRun: () => state.dryRun,
    logger,
    runner: async (_options: RunProcessOptions): Promise<ProcessResult> => ({
      exitCode: 0,
      signal: null,
      stdout: '{"ok":true,"identity":"bot"}',
      stderr: '',
    }),
  })
  const engine = {
    pendingCount: () => 0,
    watchedSessionCount: () => 0,
    idleWaitCount: () => 0,
    trackedSessionCount: () => 0,
    workspaceCount: () => 0,
    workspaceInfoOf: () => ({ title: 'Alpha', path: '/home/u/alpha' }),
    enabled: () => true,
  } as unknown as PauseEngine
  const onCaptured = vi.fn(async (_message: unknown) => {})
  const setup = new SetupController({
    bin: fixture,
    identity: 'bot',
    captureTimeoutMs: 10_000,
    logger,
    onCaptured,
  })
  const routeSetup = new SetupController({
    bin: fixture,
    identity: 'bot',
    captureTimeoutMs: 10_000,
    logger,
    onCaptured,
  })
  const routeBind = { workspace: undefined as { title: string; path: string } | undefined }
  const config = testConfig({ bin: fixture })
  const registered: CommandDefinition[] = []
  ctx.provide('commands', {
    register: (definition: CommandDefinition) => {
      registered.push(definition)
      return () => {}
    },
  })
  registerDebugCommand(ctx, { config, engine, notifier: transport, transport, setup, routeSetup, routeBind, logger })
  const definition = registered.find(item => item.name === 'lark-notify')!
  const handler = async (rawInput: string, agent: unknown = {}) => {
    const invocation = { rawInput, agent, signal: new AbortController().signal } as unknown as CommandInvocation
    return await definition.handler(invocation) as { kind: 'success' | 'error'; text?: string }
  }
  return { definition, handler, ctx, setup, routeSetup, routeBind, state }
}

describe('/lark-notify status', () => {
  it('reports target, auth readiness, dryRun and stats', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'auth-status')
    const { handler } = await createRuntime()
    const result = await handler('status')
    vi.unstubAllEnvs()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('chat oc_t')
    expect(result.text).toContain('bot identity: ready')
    expect(result.text).toContain('dryRun: false')
    expect(result.text).toContain('发送统计: 0 成功 / 0 失败')
  })

  it('shows an actionable hint when the target is unset', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'auth-status')
    const { handler } = await createRuntime({ targetChatId: '' })
    const result = await handler('status')
    vi.unstubAllEnvs()
    expect(result.text).toContain('(未配置)')
    expect(result.text).toContain('/lark-notify setup')
  })

  it('shows the auth hint when the bot identity is not ready', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'auth-status-bad')
    const { handler } = await createRuntime()
    const result = await handler('status')
    vi.unstubAllEnvs()
    expect(result.text).toContain('Bot identity: missing')
    expect(result.text).toContain('config init')
  })
})

describe('/lark-notify setup', () => {
  it('refuses to start when the bot identity is not ready', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'auth-status-bad')
    const { handler } = await createRuntime()
    const result = await handler('setup')
    vi.unstubAllEnvs()
    expect(result.kind).toBe('error')
    expect(result.text).toContain('config init')
  })

  it('starts a background capture, dedupes a second call, and completes via onCaptured', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', HUMAN_EVENT)
    const { handler, setup } = await createRuntime()
    const started = await handler('setup')
    expect(started.kind).toBe('success')
    expect(started.text).toContain('已开始监听')

    const again = await handler('setup')
    expect(again.text).toContain('已在监听中')

    // Wait for the background capture to settle.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && setup.status().state === 'listening') {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    vi.unstubAllEnvs()
    expect(setup.status()).toMatchObject({ state: 'success', chatId: 'oc_chat_1' })
    const status = await handler('status')
    expect(status.text).toContain('已完成')
  })
})

describe('/lark-notify route', () => {
  it('refuses when the current session resolves to no workspace', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'auth-status')
    const { definition, ctx } = await createRuntime()
    // Override engine.workspaceInfoOf via a wrapper is awkward here; instead
    // call with an agent whose session is absent → command cannot resolve.
    const invocation = {
      rawInput: 'route',
      agent: { session: undefined },
      signal: new AbortController().signal,
    } as unknown as CommandInvocation
    const result = await definition.handler(invocation) as { kind: 'success' | 'error'; text?: string }
    vi.unstubAllEnvs()
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法确定当前会话')
    await ctx.fiber.dispose()
  })

  it('starts a background capture and binds the workspace on completion', async () => {
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'consume')
    vi.stubEnv('FAKE_LARK_EVENT', HUMAN_EVENT)
    const { handler, routeSetup, routeBind } = await createRuntime()
    const agent = { session: { id: 's1', header: { cwd: '/home/u/alpha' } } }
    const started = await handler('route', agent)
    expect(started.kind).toBe('success')
    expect(started.text).toContain('Alpha')
    expect(routeBind.workspace).toEqual({ title: 'Alpha', path: '/home/u/alpha' })

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && routeSetup.status().state === 'listening') {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    vi.unstubAllEnvs()
    expect(routeSetup.status()).toMatchObject({ state: 'success', chatId: 'oc_chat_1' })
  })
})
