#!/usr/bin/env node
/**
 * lark-watchdog — process-external supervisor for dsh-lark-bridge.
 *
 * DSH writes a heartbeat file while it runs (`config.watchdog.heartbeatFile`,
 * updated every `intervalMs`). When DSH dies (OOM / crash / power loss /
 * kill), the heartbeat stops. This script detects a stale heartbeat and
 * sends a Feishu/Lark notification through lark-cli — the same channel the
 * plugin uses, but from OUTSIDE the process (an in-process observer cannot
 * report its own death).
 *
 * Usage:
 *   node scripts/lark-watchdog.mjs \
 *     --heartbeat-file /path/to/heartbeat \
 *     --stale-ms 60000 \
 *     --chat-id oc_xxx \
 *     [--text 'DSH 进程死亡：{time}'] \
 *     [--repeat-ms 3600000] [--once]
 *
 * Modes:
 *   loop (default) — checks every --interval-ms (default staleMs/4) forever.
 *   --once         — one check, for cron / systemd timers. Exit codes:
 *                    0 = heartbeat fresh (or alert suppressed by repeat window)
 *                    2 = heartbeat stale, alert SENT
 *                    3 = heartbeat stale, send FAILED
 * Repeated alerts are deduped per --repeat-ms via a state file
 * (default: <heartbeat-file>.alerted).
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function usageError(message) {
  console.error(`lark-watchdog: ${message}\n\nUsage:\n  node scripts/lark-watchdog.mjs --heartbeat-file <path> --stale-ms <ms> (--chat-id <id> | --user-id <id>) [--as bot|user] [--bin lark-cli] [--text <template>] [--repeat-ms <ms>] [--interval-ms <ms>] [--once]`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {
    heartbeatFile: undefined,
    staleMs: 60_000,
    chatId: undefined,
    userId: undefined,
    as: 'bot',
    bin: 'lark-cli',
    text: '💀 DSH 进程死亡\n时间: {time}\n心跳丢失超过 {staleMin} 分钟',
    repeatMs: 3_600_000,
    intervalMs: undefined,
    once: false,
  }
  const take = (index, name) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) usageError(`--${name} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    switch (flag) {
      case '--heartbeat-file': args.heartbeatFile = resolve(take(index, 'heartbeat-file')); index += 1; break
      case '--stale-ms': args.staleMs = Number(take(index, 'stale-ms')); index += 1; break
      case '--chat-id': args.chatId = take(index, 'chat-id'); index += 1; break
      case '--user-id': args.userId = take(index, 'user-id'); index += 1; break
      case '--as': args.as = take(index, 'as'); index += 1; break
      case '--bin': args.bin = take(index, 'bin'); index += 1; break
      case '--text': args.text = take(index, 'text'); index += 1; break
      case '--repeat-ms': args.repeatMs = Number(take(index, 'repeat-ms')); index += 1; break
      case '--interval-ms': args.intervalMs = Number(take(index, 'interval-ms')); index += 1; break
      case '--once': args.once = true; break
      default: usageError(`unknown flag ${flag}`)
    }
  }
  if (args.heartbeatFile === undefined) usageError('--heartbeat-file is required')
  if (args.chatId === undefined && args.userId === undefined) usageError('--chat-id or --user-id is required')
  if (!Number.isFinite(args.staleMs) || args.staleMs <= 0) usageError('--stale-ms must be a positive number')
  return args
}

function heartbeatAgeMs(file) {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}

const stateFileFor = (args) => args.heartbeatFile + '.alerted'

function lastAlertedMs(args) {
  try {
    return Number(readFileSync(stateFileFor(args), 'utf8'))
  } catch {
    return 0
  }
}

function rememberAlert(args, now) {
  try {
    writeFileSync(stateFileFor(args), String(now))
  } catch (error) {
    console.error(`lark-watchdog: cannot write state file: ${error.message}`)
  }
}

function sendAlert(args, staleForMs) {
  const targetArgs = args.chatId !== undefined
    ? ['--chat-id', args.chatId]
    : ['--user-id', args.userId]
  const text = args.text
    .replaceAll('{time}', new Date().toTimeString().slice(0, 8))
    .replaceAll('{staleMin}', String(Math.max(1, Math.round(staleForMs / 60_000))))
  const childArgs = [
    'im', '+messages-send',
    ...targetArgs,
    '--as', args.as,
    '--text', text,
    '--format', 'json',
  ]
  return new Promise((resolvePromise) => {
    const child = spawn(args.bin, childArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      console.error(`lark-watchdog: cannot run ${args.bin}: ${error.message}`)
      resolvePromise(false)
    })
    child.on('close', (code) => {
      const ok = code === 0 && stdout.includes('"ok":true')
      if (!ok) {
        console.error(`lark-watchdog: lark-cli exited ${code}: ${stderr.trim().slice(0, 300)}`)
      }
      resolvePromise(ok)
    })
  })
}

async function check(args) {
  const now = Date.now()
  const staleFor = heartbeatAgeMs(args.heartbeatFile) - args.staleMs
  if (staleFor <= 0) return 0
  if (now - lastAlertedMs(args) < args.repeatMs) return 0
  const ok = await sendAlert(args, staleFor)
  if (!ok) return 3
  rememberAlert(args, now)
  return 2
}

const args = parseArgs(process.argv.slice(2))
const intervalMs = args.intervalMs ?? Math.max(1_000, Math.round(args.staleMs / 4))

if (args.once) {
  if (!existsSync(args.heartbeatFile)) {
    console.error(`lark-watchdog: heartbeat file ${args.heartbeatFile} does not exist (has DSH started with watchdog.enabled?)`)
  }
  const code = await check(args)
  process.exit(code)
} else {
  setInterval(() => { void check(args) }, intervalMs)
  void check(args)
}
