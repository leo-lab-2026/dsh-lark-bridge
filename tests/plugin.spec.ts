import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import {
  approvalAskedEvent,
  approvalDecidedEvent,
  emitAgentStatus,
  MemorySettingsProvider,
  sessionId,
  sessionTitleEvent,
  testConfig,
  turnEndCompletedEvent,
  turnEndErrorEvent,
} from './helpers.js'

const fixtureOk = fileURLToPath(new URL('./fixtures/fake-lark-cli.sh', import.meta.url))

function tempLogPath(): string {
  return join(tmpdir(), `dsh-lark-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
}

function pluginConfig(): ReturnType<typeof testConfig> {
  return testConfig({
    bin: fixtureOk,
    target: { chatId: 'oc_test', userId: '' },
    graceMs: 500,
    debounceMs: 0,
  })
}

async function waitForLog(logPath: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      content = readFileSync(logPath, 'utf8')
      if (content.includes(needle)) return content
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`fixture log ${logPath} never contained ${JSON.stringify(needle)}; content: ${content}`)
}

async function createRuntime(logPath: string) {
  vi.stubEnv('FAKE_LARK_LOG', logPath)
  vi.stubEnv('FAKE_LARK_CLI_MODE', 'log')
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(plugin, pluginConfig())
  const session = { id: sessionId('s1') } as Session
  return { ctx, session }
}

beforeEach(() => {
  MemorySettingsProvider.initialDocument = {}
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('dsh-lark-bridge plugin wiring', () => {
  it('notifies a pending approval end-to-end through the fixture lark-cli', async () => {
    const logPath = tempLogPath()
    const { ctx, session } = await createRuntime(logPath)
    ctx.emit('session/event', session, sessionTitleEvent('Fix the failing build'))
    ctx.emit('session/event', session, approvalAskedEvent('req-1', 'bash', 'writes outside the workspace'))
    await vi.advanceTimersByTimeAsync(600)
    vi.useRealTimers()
    const content = await waitForLog(logPath, 'oc_test')
    expect(content).toContain('--chat-id')
    expect(content).toContain('--as')
    expect(content).toContain('bot')
    expect(content).toContain('bash')
    expect(content).toContain('Fix the failing build')
    expect(content).toContain('权限申请')
    await ctx.fiber.dispose()
  })

  it('stays silent when the approval is answered within the grace window', async () => {
    const logPath = tempLogPath()
    const { ctx, session } = await createRuntime(logPath)
    ctx.emit('session/event', session, approvalAskedEvent('req-1'))
    await vi.advanceTimersByTimeAsync(200)
    ctx.emit('session/event', session, approvalDecidedEvent('req-1'))
    await vi.advanceTimersByTimeAsync(400)
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(logPath)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('notifies a fatal turn error immediately (no grace window)', async () => {
    const logPath = tempLogPath()
    const { ctx, session } = await createRuntime(logPath)
    ctx.emit('session/event', session, turnEndErrorEvent(1, { code: 'RATE_LIMIT', status: 429, message: 'too fast' }))
    vi.useRealTimers()
    const content = await waitForLog(logPath, 'RATE_LIMIT (HTTP 429)')
    expect(content).toContain('too fast')
    await ctx.fiber.dispose()
  })

  it('prefers a seeded user-settings layer over the cordis config target', async () => {
    const logPath = tempLogPath()
    MemorySettingsProvider.initialDocument = {
      'lark-notify': { chatId: 'oc_seeded', userId: '', dryRun: false },
    }
    vi.stubEnv('FAKE_LARK_LOG', logPath)
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'log')
    const ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(MemorySettingsProvider)
    await ctx.plugin(plugin, pluginConfig()) // cordis config targets oc_test
    const session = { id: sessionId('s1') } as Session
    ctx.emit('session/event', session, approvalAskedEvent('req-1', 'bash'))
    await vi.advanceTimersByTimeAsync(600)
    vi.useRealTimers()
    const content = await waitForLog(logPath, 'oc_seeded')
    expect(content).toContain('--chat-id')
    expect(content).not.toContain('oc_test')
    await ctx.fiber.dispose()
  })

  it('registers the /lark-notify command when a commands service exists', async () => {
    const ctx = new Context()
    await ctx.plugin(TimerService)
    const registered: CommandDefinition[] = []
    ctx.provide('commands', {
      register: (definition: CommandDefinition) => {
        registered.push(definition)
        return () => {}
      },
    })
    await ctx.plugin(plugin, testConfig({ dryRun: true, bin: fixtureOk, target: { chatId: 'oc_test', userId: '' } }))

    const definition = registered.find(item => item.name === 'lark-notify')
    expect(definition).toBeDefined()
    expect(definition!.description).toContain('Lark')

    const invocation = (rawInput: string): CommandInvocation =>
      ({ rawInput, agent: {}, signal: new AbortController().signal }) as unknown as CommandInvocation

    const status = await definition!.handler(invocation('status'))
    expect(status).toMatchObject({ kind: 'success' })
    expect((status as { text?: string }).text).toContain('dryRun: true')
    expect((status as { text?: string }).text).toContain('oc_test')

    const testSend = await definition!.handler(invocation('test 你好'))
    expect(testSend).toMatchObject({ kind: 'success' })

    const usage = await definition!.handler(invocation('nonsense'))
    expect(usage).toMatchObject({ kind: 'error' })
    await ctx.fiber.dispose()
  })

  it('loads fail-soft without a commands service and without a target', async () => {
    const ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(plugin, testConfig({ bin: fixtureOk, dryRun: true }))
    // No commands service, empty target: apply() must not throw and must warn.
    await ctx.fiber.dispose()
  })

  it('notifies task completion end-to-end after the idle grace window', async () => {
    const logPath = tempLogPath()
    const { ctx, session } = await createRuntime(logPath)
    ctx.emit('session/event', session, turnEndCompletedEvent(2))
    emitAgentStatus(ctx, sessionId('s1'), 'idle')
    await vi.advanceTimersByTimeAsync(5_100)
    vi.useRealTimers()
    const content = await waitForLog(logPath, '任务完成')
    expect(content).toContain('oc_test')
    expect(content).toContain('s1')
    await ctx.fiber.dispose()
  })

  it('sends a farewell when the whole tree unloads, but not on a plugin-only reload', async () => {
    // Plugin-only unload (HMR): the root fiber stays ACTIVE → no farewell.
    const reloadLog = tempLogPath()
    vi.stubEnv('FAKE_LARK_LOG', reloadLog)
    vi.stubEnv('FAKE_LARK_CLI_MODE', 'log')
    const reloadCtx = new Context()
    await reloadCtx.plugin(TimerService)
    const reloadFiber = reloadCtx.plugin(plugin, pluginConfig())
    await reloadFiber
    await reloadFiber.dispose()
    vi.useRealTimers()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(reloadLog)).toBe(false)
    await reloadCtx.fiber.dispose()

    // Whole-tree shutdown: the farewell goes through the transport.
    vi.useFakeTimers()
    const shutdownLog = tempLogPath()
    vi.stubEnv('FAKE_LARK_LOG', shutdownLog)
    const ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(plugin, pluginConfig())
    await ctx.fiber.dispose()
    vi.useRealTimers()
    const content = await waitForLog(shutdownLog, '已正常退出')
    expect(content).toContain('oc_test')
  })

  it('writes the watchdog heartbeat file on the configured interval', async () => {
    const heartbeatFile = tempLogPath()
    const ctx = new Context()
    await ctx.plugin(TimerService)
    await ctx.plugin(plugin, testConfig({
      bin: fixtureOk,
      goodbye: { enabled: false, template: 'bye' },
      watchdog: { enabled: true, heartbeatFile, intervalMs: 5_000 },
    }))
    const read = (): string => existsSync(heartbeatFile) ? readFileSync(heartbeatFile, 'utf8') : ''
    await vi.waitFor(() => { expect(read()).not.toBe('') })
    const first = read()
    await vi.advanceTimersByTimeAsync(5_100)
    await vi.waitFor(() => { expect(read()).not.toBe(first) })
    await ctx.fiber.dispose()
  })
})
