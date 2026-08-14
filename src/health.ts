/**
 * Environment health checks for onboarding diagnostics: lark-cli presence
 * and bot-identity readiness (`lark-cli auth status --json --verify`).
 * Every check is fail-soft and returns actionable Chinese hints that the
 * `/lark-notify status` command surfaces verbatim.
 * @module dsh-lark-bridge/health
 */

import { runProcess, type ProcessResult } from './transport/spawn.js'
import { parseErrorEnvelope, parseFirstJson, describeError } from './transport/envelope.js'
import { QUIET_ENV } from './transport/lark-cli.js'
import type { PluginLogger } from './logger.js'

export interface AuthCheckResult {
  ok: boolean
  detail: string
  hint?: string
}

const BOT_READY_MSG = 'bot identity: ready'

/** Check lark-cli presence + bot identity readiness. Never throws. */
export async function checkLarkAuth(bin: string, timeoutMs: number, logger: PluginLogger): Promise<AuthCheckResult> {
  let result: ProcessResult
  try {
    result = await runProcess({
      bin,
      args: ['auth', 'status', '--json', '--verify'],
      timeoutMs,
      env: { ...QUIET_ENV },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`[dsh-lark-notify] auth check failed: ${message}`)
    return {
      ok: false,
      detail: `无法执行 lark-cli（${bin}）`,
      hint: '安装: npx @larksuite/cli@latest install，然后 lark-cli config init 配置应用凭据',
    }
  }
  if (result.exitCode === 0) {
    // `auth status` prints its facts WITHOUT the {ok} wrapper (verified
    // against lark-cli 1.0.81); tolerate both shapes via a generic parse.
    const root = (parseFirstJson(result.stdout) ?? {}) as Record<string, unknown>
    const data = (typeof root.data === 'object' && root.data !== null ? root.data : root) as Record<string, unknown>
    const identity = typeof root.identity === 'string' ? root.identity : 'unknown'
    const identities = (typeof data.identities === 'object' && data.identities !== null ? data.identities : {}) as Record<string, unknown>
    const bot = (typeof identities.bot === 'object' && identities.bot !== null ? identities.bot : {}) as Record<string, unknown>
    const ready = identity === 'bot' && bot.available === true
    if (ready) {
      const appId = typeof data.appId === 'string' ? data.appId : '(unknown)'
      return { ok: true, detail: `${BOT_READY_MSG} (app ${appId})` }
    }
    const message = typeof bot.message === 'string' && bot.message !== '' ? bot.message : 'bot identity 不可用'
    const hint = typeof bot.hint === 'string' ? bot.hint : undefined
    return { ok: false, detail: message, ...(hint !== undefined ? { hint } : {}) }
  }
  const envelope = parseErrorEnvelope(result.stderr)
  if (envelope !== undefined) {
    return { ok: false, detail: describeError(envelope), ...(envelope.error.hint !== undefined ? { hint: envelope.error.hint } : {}) }
  }
  return {
    ok: false,
    detail: `auth status 退出码 ${result.exitCode}${result.signal !== null ? ` (${result.signal})` : ''}`,
    hint: '运行 lark-cli auth status --json 查看详情',
  }
}

export { BOT_READY_MSG }
