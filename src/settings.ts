/**
 * User-settings layer: registers the `lark-notify` settings namespace so the
 * notification target (chatId/userId) and the dry-run switch are editable in
 * the DSH Web settings panel and persisted in `settings.yaml` — public users
 * never have to edit cordis YAML.
 *
 * Resolution order (DSH settings contract): schema defaults → composition
 * `base` (the cordis.yml config of this plugin) → user layer (settings.yaml).
 * A live runtime object re-resolves on every user change (`applies: 'live'`),
 * so the transport picks up the new target without a restart.
 * @module dsh-lark-bridge/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Config } from './config.js'
import type { PluginLogger } from './logger.js'

// Parity copy of the upstream `settingsNamespace()` helper
// (@deepseek-ai/dsh-settings): branding a namespace string is a two-line
// validation, and inlining it keeps `dsh-settings` out of this package's
// runtime dependencies — the plugin only ever needs the branded TYPE from
// the seam package (a type-only import, erased at build time).
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/** Brand a raw string as a settings namespace (lowercase kebab-case). */
function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

export const LARK_NOTIFY_SETTINGS_NAMESPACE = settingsNamespace('lark-notify')

/** User-editable subset of the plugin runtime configuration. */
export interface LarkNotifyUserSettings {
  chatId: string
  userId: string
  dryRun: boolean
}

/** Schema rendered by the Web settings panel and validated on every write. */
export const LarkNotifyUserSettingsSchema: z<LarkNotifyUserSettings> = z.object({
  chatId: z.string().default(''),
  userId: z.string().default(''),
  dryRun: z.boolean().default(false),
})

/** Live runtime facts the settings layer resolves (base + user). */
export interface LarkNotifyRuntimeSettings {
  target: { chatId: string; userId: string }
  dryRun: boolean
}

export interface InstalledUserSettings {
  /** The settings scope when a settings provider exists; undefined otherwise. */
  readonly scope: SettingsScope<LarkNotifyUserSettings> | undefined
  /** Resolved runtime settings right now (mutated in place on user changes). */
  current: () => LarkNotifyRuntimeSettings
}

/**
 * Register the settings namespace (when a settings provider exists) and
 * return the live runtime view. Without a settings provider the plugin
 * degrades to config-only behavior (custom minimal profiles).
 */
export function installUserSettings(
  ctx: Context,
  config: Config,
  logger: PluginLogger,
): InstalledUserSettings {
  const runtime: LarkNotifyRuntimeSettings = {
    target: { chatId: config.target.chatId, userId: config.target.userId },
    dryRun: config.dryRun,
  }
  // Mutable holder: the inject callback runs asynchronously after this
  // function returns, so a plain captured variable would freeze at undefined.
  const holder: { scope: SettingsScope<LarkNotifyUserSettings> | undefined } = { scope: undefined }

  const applyResolved = (resolved: LarkNotifyUserSettings): void => {
    runtime.target = { chatId: resolved.chatId, userId: resolved.userId }
    runtime.dryRun = resolved.dryRun
  }

  ctx.inject(['settings'], (settingsCtx) => {
    holder.scope = settingsCtx.settings.register(
      LARK_NOTIFY_SETTINGS_NAMESPACE,
      LarkNotifyUserSettingsSchema,
      {
        base: {
          chatId: config.target.chatId,
          userId: config.target.userId,
          dryRun: config.dryRun,
        },
        applies: 'live',
      },
    )
    applyResolved(holder.scope.get())
    holder.scope.watch((next) => {
      applyResolved(next)
      const targetText = next.chatId !== '' ? `chatId=${next.chatId}`
        : next.userId !== '' ? `userId=${next.userId}`
          : 'target cleared'
      logger.info(`[dsh-lark-notify] settings updated: ${targetText}${next.dryRun ? ' [dry-run]' : ''}`)
    })
  })

  return {
    get scope(): SettingsScope<LarkNotifyUserSettings> | undefined {
      return holder.scope
    },
    current: () => runtime,
  }
}
