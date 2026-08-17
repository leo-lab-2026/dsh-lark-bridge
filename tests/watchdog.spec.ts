import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/lark-watchdog.mjs', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/fake-lark-cli.sh', import.meta.url))

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-'))
  tempDirs.push(dir)
  return dir
}

function runWatchdog(args: string[], env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  })
  return { status: result.status, stderr: result.stderr }
}

describe('lark-watchdog script', () => {
  it('stays silent while the heartbeat is fresh and alerts when it goes stale', () => {
    const dir = createDir()
    const heartbeat = join(dir, 'heartbeat')
    const log = join(dir, 'log')
    const env = { FAKE_LARK_LOG: log, FAKE_LARK_CLI_MODE: 'log' }
    const base = ['--heartbeat-file', heartbeat, '--stale-ms', '60000', '--chat-id', 'oc_test', '--bin', fixture, '--once']

    writeFileSync(heartbeat, 'tick')
    const fresh = runWatchdog(base, env)
    expect(fresh.status).toBe(0)
    expect(existsSync(log)).toBe(false)

    // Age the heartbeat beyond the stale threshold.
    const old = new Date(Date.now() - 120_000)
    utimesSync(heartbeat, old, old)
    const stale = runWatchdog(base, env)
    expect(stale.status).toBe(2)
    const content = readFileSync(log, 'utf8')
    expect(content).toContain('--chat-id')
    expect(content).toContain('oc_test')
    expect(content).toContain('进程死亡')

    // The repeat window dedupes a second alert within --repeat-ms.
    const again = runWatchdog(base, env)
    expect(again.status).toBe(0)
  })

  it('treats a missing heartbeat file as dead', () => {
    const dir = createDir()
    const heartbeat = join(dir, 'missing-heartbeat')
    const log = join(dir, 'log')
    const env = { FAKE_LARK_LOG: log, FAKE_LARK_CLI_MODE: 'log' }
    const result = runWatchdog([
      '--heartbeat-file', heartbeat, '--stale-ms', '60000', '--user-id', 'ou_test', '--bin', fixture, '--once',
    ], env)
    expect(result.status).toBe(2)
    expect(readFileSync(log, 'utf8')).toContain('ou_test')
  })

  it('exits 3 when the alert send fails', () => {
    const dir = createDir()
    const heartbeat = join(dir, 'heartbeat')
    const log = join(dir, 'log')
    writeFileSync(heartbeat, 'tick')
    const old = new Date(Date.now() - 120_000)
    utimesSync(heartbeat, old, old)
    const result = runWatchdog([
      '--heartbeat-file', heartbeat, '--stale-ms', '60000', '--chat-id', 'oc_test', '--bin', fixture, '--once',
    ], { FAKE_LARK_LOG: log, FAKE_LARK_CLI_MODE: 'fail' })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('lark-cli exited')
  })

  it('rejects invalid invocations with a usage error', () => {
    const result = runWatchdog(['--stale-ms', '60000'], {})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--heartbeat-file is required')
  })
})
