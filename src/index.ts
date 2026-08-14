/**
 * dsh-lark-bridge — DeepSeek Harness plugin that sends real-time Feishu/Lark
 * notifications when a session pauses for human interaction:
 *
 * - permission — an approval question is pending (`approval/asked`)
 * - question   — the model awaits an ask_user_question answer (`tool/call`)
 * - error      — a turn ended fatally (`turn/end` reason error), including
 *                non-retryable 400-500 model failures
 *
 * Notification target configuration (public-user friendly):
 *  1. `/lark-notify setup` — guided: listens for one message to the bot and
 *     persists the discovered chat_id (recommended);
 *  2. DSH Web settings panel — the plugin registers the `lark-notify`
 *     settings namespace (chatId/userId/dryRun, persisted in settings.yaml);
 *  3. cordis.yml `config.target` — deployment defaults for CI/power users.
 * Precedence: user settings > cordis.yml config.
 *
 * Pure read-only observation of the durable session event stream: the plugin
 * never intercepts waterfalls, never answers approvals/questions, and never
 * affects harness behavior. Delivery goes through the official lark-cli
 * (`lark-cli im +messages-send … --as bot`), whose credentials are managed
 * by lark-cli itself; every failure is fail-soft.
 *
 * Bundle row id: `dsh-lark-notify` (see cordis.patch.yml).
 * @module dsh-lark-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-user-approval'
import { registerDebugCommand } from './command.js'
import type { Config as PluginConfig } from './config.js'
import { PauseEngine } from './engine.js'
import { installUserSettings } from './settings.js'
import { SetupController } from './setup.js'
import { LarkCliTransport, makeIdempotencyKey } from './transport/lark-cli.js'

export * from './config.js'
export type { Notifier, NotificationMessage, NotifierStatus } from './transport/types.js'

export const name = 'dsh-lark-notify'

/** Hard dependency: the timer service (base bundle) supplies effect-bound timers. */
export const inject = ['timer']

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
  })
  engine.install(ctx)

  const setup = new SetupController({
    bin: config.bin,
    identity: config.identity,
    captureTimeoutMs: config.setupTimeoutMs,
    logger,
    onCaptured: async (message) => {
      await userSettings.scope?.update({ chatId: message.chatId, userId: message.senderId })
      await transport.send({
        text: '✅ dsh-lark-bridge 配置成功！之后 DSH 会话停顿时（权限申请/提问/出错）会在这里提醒你。',
        idempotencyKey: makeIdempotencyKey(['setup', message.chatId, String(Date.now())]),
        target: { chatId: message.chatId, userId: '' },
      })
    },
  })
  // Plugin unload cancels any in-flight capture (SIGTERM, no orphans).
  ctx.effect(() => () => setup.stop())

  registerDebugCommand(ctx, { config, engine, notifier: transport, transport, setup, logger })

  logger.info(
    `[dsh-lark-notify] loaded (target: ${targetConfigured ? 'configured' : 'none'}, `
    + `identity: ${config.identity}${currentSettings().dryRun ? ', dry-run' : ''})`,
  )
}
