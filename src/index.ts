/**
 * dsh-lark-bridge — DeepSeek Harness plugin that sends real-time Feishu/Lark
 * notifications when a DSH session stops working or pauses for human input:
 *
 * V1 categories (pause detection):
 * - permission — an approval question is pending (`approval/asked`)
 * - question   — the model awaits an ask_user_question answer (`tool/call`)
 * - error      — a turn ended fatally (`turn/end` reason error), including
 *                non-retryable 400-500 model failures
 *
 * Phase 2A categories (complete "DSH stopped = always notified"):
 * - complete   — the agent went idle after a `completed` turn (idle grace
 *                window filters goal auto-rounds and /loop followups)
 * - stop:blocked / stop:max-tokens / stop:aborted / stop:interrupted —
 *                the remaining turn-end reasons, each with its own switch
 * - retry      — provider backoff (`llm/retry`) from the attempt threshold
 * - stall      — a running agent stopped producing events (periodic scan)
 * - goodbye    — "DSH exited normally" farewell from the dispose hook
 * - watchdog   — in-process heartbeat file for an external process-death
 *                supervisor (`scripts/lark-watchdog.mjs`)
 *
 * Notification target configuration (public-user friendly):
 *  1. `/lark-notify setup` — guided: listens for one message to the bot and
 *     persists the discovered chat_id (recommended);
 *  2. DSH Web settings panel — the plugin registers the `lark-notify`
 *     settings namespace (chatId/userId/dryRun, persisted in settings.yaml);
 *  3. cordis.yml `config.target` — deployment defaults for CI/power users.
 * Precedence: user settings > cordis.yml config.
 *
 * Pure read-only observation of the durable session event stream and the
 * live `agent/status` lifecycle: the plugin never intercepts waterfalls,
 * never answers approvals/questions, and never affects harness behavior.
 * Delivery goes through the official lark-cli
 * (`lark-cli im +messages-send … --as bot`), whose credentials are managed
 * by lark-cli itself; every failure is fail-soft.
 *
 * Bundle row id: `dsh-lark-notify` (see cordis.patch.yml).
 * @module dsh-lark-bridge
 */

import { writeFile } from 'node:fs/promises'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import { registerDebugCommand } from './command.js'
import type { Config as PluginConfig } from './config.js'
import { PauseEngine } from './engine.js'
import { renderTemplate } from './render.js'
import { matchRoute, upsertRoute, type SessionWorkspaceInfo } from './routing.js'
import { installUserSettings } from './settings.js'
import { SetupController } from './setup.js'
import { LarkCliTransport, makeIdempotencyKey } from './transport/lark-cli.js'

export * from './config.js'
export type { Notifier, NotificationMessage, NotifierStatus } from './transport/types.js'

export const name = 'dsh-lark-notify'

/** Hard dependency: the timer service (base bundle) supplies effect-bound timers. */
export const inject = ['timer']

/**
 * `@deepseek-ai/cordis` declares `FiberState` as a const enum — it has no
 * runtime export, so this numeric mirror is the only inlinable way to test
 * the root fiber's lifecycle state (see cordis `FiberState.ACTIVE` = 2).
 */
const FIBER_STATE_ACTIVE = 2 satisfies FiberState

export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger('dsh-lark-notify')

  // Settings layer resolves target/dryRun (user settings > cordis.yml base)
  // and re-resolves live on every Web-settings change.
  const userSettings = installUserSettings(ctx, config, logger)
  const currentSettings = userSettings.current

  const target = currentSettings().target
  const targetConfigured = target.chatId !== '' || target.userId !== ''
  if (!targetConfigured) {
    logger.warn(
      '[dsh-lark-notify] 通知目标未配置。运行 /lark-notify setup 自动获取 chat_id，'
      + '或在 DSH 设置面板的「lark-notify」分节填写。',
    )
  }

  const transport = new LarkCliTransport({
    bin: config.bin,
    identity: config.identity,
    timeoutMs: config.timeoutMs,
    target: () => ({ chatId: currentSettings().target.chatId, userId: currentSettings().target.userId }),
    dryRun: () => currentSettings().dryRun,
    logger,
  })

  const engine = new PauseEngine({
    config,
    notifier: transport,
    logger,
    timeout: (callback, delay) => ctx.timeout(callback, delay),
    interval: (callback, delay) => ctx.interval(callback, delay),
    // Per-workspace routing: resolve from live settings each emit.
    routeResolver: (workspace) => matchRoute(currentSettings().routing, workspace),
  })
  engine.install(ctx)

  // Normal-exit farewell: fire only when the WHOLE application tree unloads
  // (root fiber leaving ACTIVE). Plugin reload/HMR unloads just this fiber,
  // so the root stays ACTIVE and no spurious "DSH exited" is sent.
  ctx.effect(() => () => {
    if (!config.goodbye.enabled) return
    if (ctx.root.fiber.state === FIBER_STATE_ACTIVE) return
    try {
      return transport.send({
        text: renderTemplate(config.goodbye.template, {
          time: new Date().toTimeString().slice(0, 8),
        }),
        idempotencyKey: makeIdempotencyKey(['goodbye', String(process.pid)]),
      }).then(() => undefined, (error: unknown) => {
        logger.warn('[dsh-lark-notify] goodbye send failed (contained)', error)
      })
    } catch (error) {
      logger.warn('[dsh-lark-notify] goodbye preparation failed (contained)', error)
    }
  })

  // Process-death watchdog heartbeat: an external supervisor
  // (scripts/lark-watchdog.mjs) alerts when the file stops updating.
  if (config.watchdog.enabled) {
    const heartbeatFile = config.watchdog.heartbeatFile.trim()
    if (heartbeatFile === '') {
      logger.warn('[dsh-lark-notify] watchdog enabled but heartbeatFile is empty — heartbeat disabled')
    } else {
      let warned = false
      const touch = (): void => {
        writeFile(heartbeatFile, String(Date.now())).catch((error: unknown) => {
          if (warned) return
          warned = true
          logger.warn(`[dsh-lark-notify] heartbeat write to ${heartbeatFile} failed (contained)`, error)
        })
      }
      touch()
      ctx.interval(touch, config.watchdog.intervalMs)
    }
  }

  const setup = new SetupController({
    bin: config.bin,
    identity: config.identity,
    captureTimeoutMs: config.setupTimeoutMs,
    logger,
    onCaptured: async (message) => {
      await userSettings.scope?.update({ chatId: message.chatId, userId: message.senderId })
      await transport.send({
        text: '✅ dsh-lark-bridge 配置成功！之后 DSH 会话停顿时（权限申请/提问/出错/完成/阻塞/重试/停滞）会在这里提醒你。',
        idempotencyKey: makeIdempotencyKey(['setup', message.chatId, String(Date.now())]),
        target: { chatId: message.chatId, userId: '' },
      })
    },
  })
  // Plugin unload cancels any in-flight capture (SIGTERM, no orphans).
  ctx.effect(() => () => setup.stop())

  // Per-workspace routing: `/lark-notify route` binds the current workspace
  // to the chat the user messages the bot from (typically a project group).
  // The bind context (workspace title + path) is set by the command before
  // the capture starts and read by the capture's onCaptured on completion.
  const routeBind: { workspace: SessionWorkspaceInfo | undefined } = { workspace: undefined }
  const routeSetup = new SetupController({
    bin: config.bin,
    identity: config.identity,
    captureTimeoutMs: config.setupTimeoutMs,
    logger,
    onCaptured: async (message) => {
      const workspace = routeBind.workspace
      if (workspace === undefined) {
        throw new Error('路由绑定的工作区上下文缺失（请重新运行 /lark-notify route）')
      }
      const routing = upsertRoute(currentSettings().routing, {
        title: workspace.title,
        path: workspace.path,
        chatId: message.chatId,
        userId: '',
      })
      await userSettings.scope?.update({ routing })
      await transport.send({
        text: `✅ 已绑定 工作区「${workspace.title}」→ 本会话。之后该工作区的 DSH 通知会发送到这里。`,
        idempotencyKey: makeIdempotencyKey(['route', workspace.path, message.chatId, String(Date.now())]),
        target: { chatId: message.chatId, userId: '' },
      })
    },
  })
  ctx.effect(() => () => routeSetup.stop())

  registerDebugCommand(ctx, {
    config,
    engine,
    notifier: transport,
    transport,
    setup,
    routeSetup,
    routeBind,
    logger,
  })

  logger.info(
    `[dsh-lark-notify] loaded (target: ${targetConfigured ? 'configured' : 'none'}, `
    + `identity: ${config.identity}${currentSettings().dryRun ? ', dry-run' : ''})`,
  )
}
