/**
 * Plugin configuration (Schemastery schema). Every tunable has a default so
 * the bundle patch (`cordis.patch.yml`) can stay neutral; users override the
 * whole row by `id` in their own profile `cordis.patch.yml`. Invalid values
 * fail loudly at load time (Cordis config validation).
 *
 * Template variables (per category, see docs/09 for the full table):
 *   common:       {sessionId} {sessionTitle} {webUrl} {time}
 *   permission:   {tool} {reason}
 *   question:     {header} {question} {options} {questions} {number}
 *   error:        {errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}
 * @module dsh-lark-bridge/config
 */

import z from '@deepseek-ai/schemastery'

/** Notification destination: a p2p chat_id (recommended) or a user open_id. */
export interface NotificationTarget {
  /** Empty string = not configured (plugin degrades to a safe no-op). */
  chatId: string
  userId: string
}

/** Base per-category config shared by every notification category. */
export interface CategoryConfig {
  enabled: boolean
  template: string
}

/** question category extras: multi-question frame and per-item templates. */
export interface QuestionCategoryConfig extends CategoryConfig {
  templateMultiple: string
  itemTemplate: string
}

/** error category extra: per-session repeat-notification throttle window. */
export interface ErrorCategoryConfig extends CategoryConfig {
  throttleMs: number
}

/** Complete validated plugin configuration. */
export interface Config {
  target: NotificationTarget
  /** Base URL of the DSH Web GUI shown in notifications. */
  webUrl: string
  /** lark-cli `--as` identity used for sends. */
  identity: 'bot' | 'user'
  /** lark-cli executable (PATH-resolved by default). */
  bin: string
  /** Per-send hard timeout (ms). */
  timeoutMs: number
  /** Grace window (ms): a pause resolved within it sends no notification. */
  graceMs: number
  /** Debounce window (ms): one notification per session per category within it. */
  debounceMs: number
  /** Log would-be messages instead of invoking lark-cli (debugging). */
  dryRun: boolean
  /** `/lark-notify setup` listen window (ms) for capturing the user's first message. */
  setupTimeoutMs: number
  categories: {
    permission: CategoryConfig
    question: QuestionCategoryConfig
    error: ErrorCategoryConfig
  }
}

export const DEFAULT_PERMISSION_TEMPLATE = '🔔 DSH 权限申请\n会话: {sessionTitle} ({sessionId})\n工具: {tool}\n原因: {reason}\n→ {webUrl}'
export const DEFAULT_QUESTION_TEMPLATE = '❓ DSH 正在等待你的回答\n会话: {sessionTitle} ({sessionId})\n{header}\n{question}\nOptions: {options}\n→ {webUrl}'
export const DEFAULT_QUESTION_TEMPLATE_MULTIPLE = '❓ DSH 正在等待你的回答\n会话: {sessionTitle} ({sessionId})\n\n{questions}\n→ {webUrl}'
export const DEFAULT_QUESTION_ITEM_TEMPLATE = '{number}. {header}\n   {question}\n   Options: {options}'
export const DEFAULT_ERROR_TEMPLATE = '⚠️ DSH 会话出错停止\n会话: {sessionTitle} ({sessionId})\n错误: [{errorLabel}]\n详情: {errorMessage}\n→ {webUrl}'

/** Runtime schema; Cordis validates `config` against it before `apply()`. */
export const Config: z<Config> = z.object({
  target: z.object({
    chatId: z.string().default(''),
    userId: z.string().default(''),
  }),
  webUrl: z.string().default('http://127.0.0.1:3080'),
  identity: z.union(['bot', 'user'] as const).default('bot'),
  bin: z.string().default('lark-cli'),
  timeoutMs: z.number().default(30_000),
  graceMs: z.number().default(500),
  debounceMs: z.number().default(3_000),
  dryRun: z.boolean().default(false),
  setupTimeoutMs: z.number().default(180_000),
  categories: z.object({
    permission: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_PERMISSION_TEMPLATE),
    }),
    question: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_QUESTION_TEMPLATE),
      templateMultiple: z.string().default(DEFAULT_QUESTION_TEMPLATE_MULTIPLE),
      itemTemplate: z.string().default(DEFAULT_QUESTION_ITEM_TEMPLATE),
    }),
    error: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_ERROR_TEMPLATE),
      throttleMs: z.number().default(300_000),
    }),
  }),
})
