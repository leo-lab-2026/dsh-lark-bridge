import { describe, expect, it, vi } from 'vitest'
import { createLogger } from './helpers.js'
import { LarkCliTransport, makeIdempotencyKey } from '../src/transport/lark-cli.js'
import { ProcessError } from '../src/transport/spawn.js'
import type { ProcessResult, RunProcessOptions } from '../src/transport/spawn.js'
import type { NotificationMessage } from '../src/transport/types.js'

function makeTransport(overrides: Partial<ConstructorParameters<typeof LarkCliTransport>[0]> = {}) {
  const logger = createLogger()
  const runner = vi.fn(async (_options: RunProcessOptions): Promise<ProcessResult> => ({
    exitCode: 0,
    signal: null,
    stdout: '{"ok":true,"identity":"bot"}',
    stderr: '',
  }))
  const state = {
    target: { chatId: 'oc_1', userId: '' },
    dryRun: false,
  }
  const transport = new LarkCliTransport({
    bin: 'lark-cli',
    identity: 'bot',
    timeoutMs: 30_000,
    target: () => state.target,
    dryRun: () => state.dryRun,
    logger,
    runner,
    ...overrides,
  })
  return { transport, logger, runner, state }
}

const message: NotificationMessage = {
  text: 'hello 飞书',
  idempotencyKey: 'dsh-abcdef',
}

describe('LarkCliTransport.send', () => {
  it('invokes lark-cli with the documented argument shape', async () => {
    const { transport, runner } = makeTransport()
    await expect(transport.send(message)).resolves.toBe(true)
    expect(runner).toHaveBeenCalledOnce()
    const options = runner.mock.calls[0]![0]
    expect(options.bin).toBe('lark-cli')
    expect(options.args).toEqual([
      'im', '+messages-send',
      '--chat-id', 'oc_1',
      '--as', 'bot',
      '--text', 'hello 飞书',
      '--format', 'json',
      '--idempotency-key', 'dsh-abcdef',
    ])
    expect(options.env).toMatchObject({
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    })
    expect(transport.status()).toMatchObject({ sent: 1, failed: 0 })
    expect(transport.currentTarget()).toEqual({ chatId: 'oc_1', userId: '' })
  })

  it('uses --user-id when the configured target has no chatId', async () => {
    const { transport, runner } = makeTransport({
      target: () => ({ chatId: '', userId: 'ou_9' }),
    })
    await expect(transport.send(message)).resolves.toBe(true)
    const args = runner.mock.calls[0]![0].args as string[]
    expect(args).toContain('--user-id')
    expect(args).toContain('ou_9')
    expect(args).not.toContain('--chat-id')
  })

  it('reads the target live: a later update changes the next send', async () => {
    const { transport, runner, state } = makeTransport()
    await transport.send(message)
    state.target = { chatId: '', userId: 'ou_9' }
    await transport.send(message)
    const first = runner.mock.calls[0]![0].args as string[]
    const second = runner.mock.calls[1]![0].args as string[]
    expect(first).toContain('oc_1')
    expect(second).toContain('--user-id')
    expect(second).toContain('ou_9')
  })

  it('a per-message target override wins over the configured target', async () => {
    const { transport, runner } = makeTransport()
    await transport.send({ ...message, target: { chatId: 'oc_override', userId: '' } })
    const args = runner.mock.calls[0]![0].args as string[]
    expect(args).toContain('oc_override')
  })

  it('reads dryRun live', async () => {
    const { transport, runner, logger, state } = makeTransport()
    await transport.send(message)
    expect(runner).toHaveBeenCalledTimes(1)
    state.dryRun = true
    await expect(transport.send(message)).resolves.toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(transport.isDryRun()).toBe(true)
    expect(logger.calls.some(call => call.level === 'info' && call.message.includes('hello 飞书'))).toBe(true)
  })

  it('treats a structured failure envelope as a failed send (never throws)', async () => {
    const { transport, logger } = makeTransport({
      runner: vi.fn(async (_options: RunProcessOptions): Promise<ProcessResult> => ({
        exitCode: 3,
        signal: null,
        stdout: '',
        stderr: '{"ok":false,"error":{"type":"api","subtype":"missing_scope","code":999,"message":"no scope","hint":"run auth login"}}',
      })),
    })
    await expect(transport.send(message)).resolves.toBe(false)
    expect(transport.status()).toMatchObject({ sent: 0, failed: 1 })
    expect(transport.status().lastError).toContain('api.missing_scope')
    expect(transport.status().lastError).toContain('hint')
    expect(logger.calls.some(call => call.level === 'warn')).toBe(true)
  })

  it('treats exit 0 without a success envelope as a failure', async () => {
    const { transport } = makeTransport({
      runner: vi.fn(async (_options: RunProcessOptions): Promise<ProcessResult> => ({
        exitCode: 0,
        signal: null,
        stdout: 'unexpected garbage',
        stderr: '',
      })),
    })
    await expect(transport.send(message)).resolves.toBe(false)
  })

  it('fails soft when the binary is missing (spawn error)', async () => {
    const { transport, logger } = makeTransport({
      runner: vi.fn(async (_options: RunProcessOptions): Promise<ProcessResult> => {
        throw new ProcessError('failed to spawn "lark-cli": ENOENT')
      }),
    })
    await expect(transport.send(message)).resolves.toBe(false)
    expect(transport.status().failed).toBe(1)
    expect(logger.calls.some(call => call.level === 'warn' && call.message.includes('ENOENT'))).toBe(true)
  })

  it('serializes concurrent sends through the internal queue', async () => {
    const order: string[] = []
    let releaseFirst = (): void => {}
    const runner = vi.fn(async (options: RunProcessOptions): Promise<ProcessResult> => {
      if (options.args.includes('first')) {
        await new Promise<void>(resolve => { releaseFirst = resolve })
      }
      order.push(options.args.join(' '))
      return { exitCode: 0, signal: null, stdout: '{"ok":true}', stderr: '' }
    })
    const { transport } = makeTransport({ runner })
    const first = transport.send({ text: 'first', idempotencyKey: 'k1' })
    const second = transport.send({ text: 'second', idempotencyKey: 'k2' })
    await Promise.resolve()
    expect(runner).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(runner).toHaveBeenCalledTimes(2)
    expect(order).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
    ])
  })

  it('truncates idempotency keys to 50 characters', async () => {
    const { transport, runner } = makeTransport()
    await expect(transport.send({ ...message, idempotencyKey: 'x'.repeat(80) })).resolves.toBe(true)
    const args = runner.mock.calls[0]![0].args as string[]
    const index = args.indexOf('--idempotency-key')
    expect(args[index + 1]!.length).toBeLessThanOrEqual(50)
  })
})

describe('makeIdempotencyKey', () => {
  it('is stable, short, and prefix-consistent', () => {
    const a = makeIdempotencyKey(['permission', 's1', 'r1'])
    const b = makeIdempotencyKey(['permission', 's1', 'r1'])
    const c = makeIdempotencyKey(['permission', 's1', 'r2'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('dsh-')).toBe(true)
    expect(a.length).toBeLessThanOrEqual(50)
  })
})
