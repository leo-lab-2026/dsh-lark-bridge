/**
 * Debug command `/lark-notify` (registered when a commands service exists):
 *
 *   /lark-notify setup [text]  — guided target discovery: listens for one
 *                                message to the bot, persists the captured
 *                                chat_id, sends a test notification
 *   /lark-notify test [text]   — deliver a test notification now
 *   /lark-notify status        — configuration + transport + auth diagnostics
 *
 * status/setup surface actionable hints for first-time (public) users:
 * missing binary, unauthenticated bot, unset target, closed event
 * subscription — every failure path is explainable from the command output.
 * @module dsh-lark-bridge/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { Config } from './config.js'
import type { PauseEngine } from './engine.js'
import { checkLarkAuth } from './health.js'
import type { PluginLogger } from './logger.js'
import type { SessionWorkspaceInfo } from './routing.js'
import type { SetupController, SetupStatus } from './setup.js'
import { makeIdempotencyKey, type LarkCliTransport } from './transport/lark-cli.js'
import type { Notifier } from './transport/types.js'

export interface DebugCommandDeps {
  config: Config
  engine: PauseEngine
  notifier: Notifier
  transport: LarkCliTransport
  setup: SetupController
  /** Route-binding capture (binds the current workspace to the captured chat). */
  routeSetup: SetupController
  /** Mutable workspace context set by /lark-notify route before capture starts. */
  routeBind: { workspace: SessionWorkspaceInfo | undefined }
  logger: PluginLogger
}

const AUTH_CHECK_TIMEOUT_MS = 15_000

function describeSetup(status: SetupStatus): string {
  switch (status.state) {
    case 'idle': return '未运行'
    case 'listening': return '正在监听消息（等待你给机器人发消息）'
    case 'success': return `已完成（chat ${status.chatId ?? '?'}）`
    case 'failed': return status.error !== undefined ? `失败：${status.error}` : '失败'
  }
}

export function registerDebugCommand(ctx: Context, deps: DebugCommandDeps): void {
  const commands = ctx.get('commands')
  if (commands === undefined) {
    deps.logger.debug('[dsh-lark-notify] commands service unavailable — /lark-notify not registered')
    return
  }
  commands.register({
    name: 'lark-notify',
    description: 'Lark 通知桥：setup 自动配置通知目标 / route 按工作区路由 / test 发送测试通知 / status 诊断。',
    input: { hint: 'setup | route | test [text] | status' },
    recordInput: false,
    handler: async (invocation) => {
      const input = invocation.rawInput.trim()
      if (input === '' || input === 'status') return runStatus(deps)
      if (input === 'setup' || input.startsWith('setup ')) return runSetup(deps)
      if (input === 'route' || input.startsWith('route ')) return runRoute(deps, invocation)
      if (input === 'test' || input.startsWith('test ')) {
        const text = input.slice('test'.length).trim() || 'dsh-lark-bridge test message'
        const ok = await deps.notifier.send({
          text,
          idempotencyKey: makeIdempotencyKey(['test', String(Date.now())]),
        })
        return ok
          ? { kind: 'success', text: '测试通知已发送 — 去飞书确认' }
          : { kind: 'error', text: '发送失败 — 运行 /lark-notify status 查看原因' }
      }
      return { kind: 'error', text: '用法: /lark-notify setup | route | test [text] | status' }
    },
  })
}

async function runStatus(deps: DebugCommandDeps): Promise<{ kind: 'success'; text: string }> {
  const { config, engine, notifier, transport, setup, routeSetup, logger } = deps
  const target = transport.currentTarget()
  const auth = await checkLarkAuth(config.bin, AUTH_CHECK_TIMEOUT_MS, logger)
  const stats = notifier.status()
  const enabledCategories = [
    'permission', 'question', 'error',
    'complete', 'stop:blocked', 'stop:max-tokens', 'stop:aborted', 'stop:interrupted',
    'retry', 'stall',
  ].filter(id => engine.enabled(id))

  const lines = [
    `目标: ${target.chatId !== undefined && target.chatId !== '' ? `chat ${target.chatId}` : target.userId !== undefined && target.userId !== '' ? `user ${target.userId}` : '(未配置)'}`,
    `身份: ${config.identity}（lark-cli --as）`,
    `lark-cli: ${auth.detail}`,
    `dryRun: ${transport.isDryRun()}`,
    `发送统计: ${stats.sent} 成功 / ${stats.failed} 失败`,
    stats.lastError !== undefined ? `最近错误: ${stats.lastError}` : '',
    `setup: ${describeSetup(setup.status())}`,
    `route: ${describeSetup(routeSetup.status())}`,
    `通知类别: ${enabledCategories.join(', ')}`,
    `grace 中待发: ${engine.pendingCount()} | idle 宽限中: ${engine.idleWaitCount()} | 已跟踪会话: ${engine.trackedSessionCount()} | 已缓存标题会话: ${engine.watchedSessionCount()} | 已解析工作区: ${engine.workspaceCount()}`,
  ].filter(line => line !== '')

  const hints: string[] = []
  if (target.chatId === undefined || (target.chatId === '' && (target.userId === undefined || target.userId === ''))) {
    hints.push('运行 /lark-notify setup 自动获取 chat_id，或在 DSH 设置面板的「lark-notify」分节填写 chatId/userId')
  }
  if (!auth.ok && auth.hint !== undefined) hints.push(auth.hint)
  if (hints.length > 0) lines.push(`提示: ${hints.join('；')}`)

  return { kind: 'success', text: lines.join('\n') }
}

async function runSetup(deps: DebugCommandDeps): Promise<{ kind: 'success' | 'error'; text: string }> {
  const { config, setup, logger } = deps
  const auth = await checkLarkAuth(config.bin, AUTH_CHECK_TIMEOUT_MS, logger)
  if (!auth.ok) {
    return {
      kind: 'error',
      text: `无法开始：${auth.detail}${auth.hint !== undefined ? `\n${auth.hint}` : ''}`,
    }
  }
  if (setup.isActive()) {
    return { kind: 'success', text: '已在监听中：现在去飞书给机器人发送任意一条消息即可。' }
  }
  void setup.run().then(
    (outcome) => { logger.info(`[dsh-lark-notify] setup: ${outcome.message}`) },
  )
  const timeoutMinutes = Math.max(1, Math.round(config.setupTimeoutMs / 60_000))
  return {
    kind: 'success',
    text: `已开始监听（${timeoutMinutes} 分钟窗口）。现在去飞书给机器人发送任意一条消息；`
      + '捕获后会自动保存通知目标并发送一条测试通知。进度见 /lark-notify status。',
  }
}

/**
 * Bind the current workspace to the chat the user messages the bot from
 * (typically the project's Feishu group): captures one message, persists the
 * workspace → chat routing entry, sends a confirmation.
 */
async function runRoute(
  deps: DebugCommandDeps,
  invocation: { agent: { session?: { id: unknown; header?: { cwd?: string } } } },
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const { config, engine, routeSetup, routeBind, logger } = deps
  const sessionId = invocation.agent.session?.id
  if (sessionId === undefined) {
    return { kind: 'error', text: '无法确定当前会话 — 请在 DSH 会话内运行 /lark-notify route。' }
  }
  const workspace = engine.workspaceInfoOf(sessionId as never)
  if (workspace === undefined) {
    return { kind: 'error', text: '无法确定当前会话所属工作区/项目（既无工作区注册也无会话工作目录）。' }
  }
  const auth = await checkLarkAuth(config.bin, AUTH_CHECK_TIMEOUT_MS, logger)
  if (!auth.ok) {
    return {
      kind: 'error',
      text: `无法开始：${auth.detail}${auth.hint !== undefined ? `\n${auth.hint}` : ''}`,
    }
  }
  if (routeSetup.isActive()) {
    return { kind: 'success', text: '已在监听路由绑定中：现在去目标飞书群给机器人发送任意一条消息即可。' }
  }
  routeBind.workspace = workspace
  void routeSetup.run().then(
    (outcome) => { logger.info(`[dsh-lark-notify] route: ${outcome.message}`) },
  )
  const timeoutMinutes = Math.max(1, Math.round(config.setupTimeoutMs / 60_000))
  return {
    kind: 'success',
    text: `开始绑定 工作区「${workspace.title}」（${workspace.path}）。`
      + `请把机器人拉进目标飞书群，然后在群里给机器人发送任意一条消息（${timeoutMinutes} 分钟窗口）。`
      + '捕获后该工作区的所有 DSH 通知将发到该群；未绑定工作区仍走全局默认目标。进度见 /lark-notify status。',
  }
}
