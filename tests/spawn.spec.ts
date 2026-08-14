import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ProcessError, runProcess } from '../src/transport/spawn.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-lark-cli.sh', import.meta.url))

function fixtureEnv(mode: string, logPath?: string): Record<string, string> {
  return {
    FAKE_LARK_CLI_MODE: mode,
    ...(logPath !== undefined ? { FAKE_LARK_LOG: logPath } : {}),
  }
}

describe('runProcess', () => {
  it('captures stdout of a successful child (exit 0)', async () => {
    const result = await runProcess({
      bin: fixture,
      args: ['im', '+messages-send'],
      timeoutMs: 5_000,
      env: fixtureEnv('log', '/tmp/dsh-lark-spawn-ok.log'),
    })
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout).toContain('"ok":true')
  })

  it('captures stderr and the non-zero exit code of a failing child', async () => {
    const result = await runProcess({
      bin: fixture,
      args: [],
      timeoutMs: 5_000,
      env: fixtureEnv('fail'),
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('"ok":false')
  })

  it('SIGTERMs a child that exceeds the timeout and reports no exit code', async () => {
    const result = await runProcess({
      bin: fixture,
      args: [],
      timeoutMs: 300,
      env: fixtureEnv('slow'),
    })
    expect(result.signal).toBe('SIGTERM')
    expect(result.exitCode).toBeNull()
  })

  it('kills the child when the abort signal fires', async () => {
    const controller = new AbortController()
    const pending = runProcess({
      bin: fixture,
      args: [],
      timeoutMs: 30_000,
      env: fixtureEnv('slow'),
      signal: controller.signal,
    })
    // Give the child a moment to start, then abort.
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort()
    const result = await pending
    expect(result.signal).toBe('SIGTERM')
  })

  it('rejects with ProcessError when the binary cannot be spawned (ENOENT)', async () => {
    await expect(runProcess({
      bin: '/nonexistent/lark-cli-xyz',
      args: [],
      timeoutMs: 5_000,
    })).rejects.toBeInstanceOf(ProcessError)
  })

  it('caps captured output at maxOutputBytes while still draining the child', async () => {
    const capped = await runProcess({
      bin: fixture,
      args: [],
      timeoutMs: 10_000,
      env: fixtureEnv('noise'),
      maxOutputBytes: 1_000,
    })
    expect(capped.exitCode).toBe(0)
    expect(capped.stdout.length).toBeLessThanOrEqual(1_000)

    const uncapped = await runProcess({
      bin: fixture,
      args: [],
      timeoutMs: 10_000,
      env: fixtureEnv('noise'),
    })
    expect(uncapped.stdout.length).toBeGreaterThan(100_000)
  })
})
