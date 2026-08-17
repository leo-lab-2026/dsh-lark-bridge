/**
 * Plugin configuration (Schemastery schema). Every tunable has a default so
 * the bundle patch (`cordis.patch.yml`) can stay neutral; users override the
 * whole row by `id` in their own profile `cordis.patch.yml`. Invalid values
 * fail loudly at load time (Cordis config validation).
 *
 * Template variables (per category, see docs/09 for the full table):
 *   common:          {sessionId} {sessionTitle} {workspace} {workspaceTitle}
 *                    {workspacePath} {cwd} {webUrl} {time}
 *   permission:      {tool} {reason}
 *   question:        {header} {question} {options} {questions} {number}
 *   error:           {errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}
 *   complete:        {turn}
 *   stop:blocked:    {turn} {reason}
 *   stop:max-tokens: {turn}
 *   stop:aborted:    {turn} {cancelCause}
 *   stop:interrupted:{turn}
 *   retry:           {retry} {maxRetries} {maxRetriesLabel} {delaySec} {provider}
 *                    {mode} {errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}
 *   stall:           {stalledMin}
 *   goodbye:         {time}
 *
 * Workspace variables resolve from the DSH workspace registry (when present)
 * and fall back to the session's working directory (header.cwd basename):
 *   {workspace}       = {workspaceTitle} (friendly project name)
 *   {workspaceTitle}  = workspace registry title → basename(cwd)
 *   {workspacePath}   = workspace registry path → cwd
 *   {cwd}             = session header working directory
 *
 * Routing (`config.routing`): optional per-workspace target overrides. Each
 * entry binds a workspace (by title + path) to a dedicated chatId/userId.
 * Matching prefers the exact title, then falls back to the path (stable
 * across renames). A workspace with no route falls back to `target`.
 * @module dsh-lark-bridge/config
 */

import z from '@deepseek-ai/schemastery'
import type { RoutingEntry } from './routing.js'

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

/**
 * complete category: task-finished notification. Triggered by the Phase 2A
 * idle model (`agent/status` → `idle` persisting past `idleGraceMs` while the
 * last `turn/end` is `completed`), throttled per session.
 */
export interface CompleteCategoryConfig extends CategoryConfig {
  /** Idle grace window (ms): the agent must stay idle this long (filtering goal auto-rounds) before notifying. */
  idleGraceMs: number
  /** Per-session throttle (ms) between consecutive completion notifications. */
  throttleMs: number
}

/** stop category family member (blocked / max-tokens / aborted / interrupted). */
export interface StopCategoryConfig extends CategoryConfig {
  /** Per-session throttle (ms) between consecutive notifications of this kind. */
  throttleMs: number
}

/** retry category: request-backoff notifications with an attempt threshold and interval throttle. */
export interface RetryCategoryConfig extends CategoryConfig {
  /** Minimum `llm/retry` attempt number that triggers a notification. */
  retryThreshold: number
  /** Per-session interval (ms) between consecutive retry reminders. */
  intervalMs: number
}

/** stall category: no-progress scanning while the agent stays running. */
export interface StallCategoryConfig extends CategoryConfig {
  /** Milliseconds of zero session activity while running that count as a stall. */
  stallMs: number
  /** Repeat-reminder window (ms) while the stall persists. */
  repeatMs: number
}

/** Normal-exit farewell notification sent from the plugin dispose hook. */
export interface GoodbyeConfig {
  enabled: boolean
  template: string
}

/** Process-death watchdog: in-process heartbeat file for an external supervisor. */
export interface WatchdogConfig {
  enabled: boolean
  /** Heartbeat file path (touched every `intervalMs`); empty = watchdog off. */
  heartbeatFile: string
  intervalMs: number
}

/** Complete validated plugin configuration. */
export interface Config {
  target: NotificationTarget
  /** Per-workspace routing overrides (deployment default; users edit via settings panel). */
  routing: RoutingEntry[]
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
  /** Normal-exit farewell notification (skipped on plugin reload/HMR). */
  goodbye: GoodbyeConfig
  /** Process-death watchdog heartbeat writer. */
  watchdog: WatchdogConfig
  categories: {
    permission: CategoryConfig
    question: QuestionCategoryConfig
    error: ErrorCategoryConfig
    complete: CompleteCategoryConfig
    'stop:blocked': StopCategoryConfig
    'stop:max-tokens': StopCategoryConfig
    'stop:aborted': StopCategoryConfig
    'stop:interrupted': StopCategoryConfig
    retry: RetryCategoryConfig
    stall: StallCategoryConfig
  }
}

export const DEFAULT_PERMISSION_TEMPLATE = '🔔 DSH 权限申请\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n工具: {tool}\n原因: {reason}\n→ {webUrl}'
export const DEFAULT_QUESTION_TEMPLATE = '❓ DSH 正在等待你的回答\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n{header}\n{question}\nOptions: {options}\n→ {webUrl}'
export const DEFAULT_QUESTION_TEMPLATE_MULTIPLE = '❓ DSH 正在等待你的回答\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n\n{questions}\n→ {webUrl}'
export const DEFAULT_QUESTION_ITEM_TEMPLATE = '{number}. {header}\n   {question}\n   Options: {options}'
export const DEFAULT_ERROR_TEMPLATE = '⚠️ DSH 会话出错停止\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n错误: [{errorLabel}]\n详情: {errorMessage}\n→ {webUrl}'
export const DEFAULT_COMPLETE_TEMPLATE = '✅ DSH 任务完成\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n轮次: {turn}\n→ {webUrl}'
export const DEFAULT_STOP_BLOCKED_TEMPLATE = '🚫 DSH 目标阻塞\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n原因: {reason}\n→ {webUrl}'
export const DEFAULT_STOP_MAX_TOKENS_TEMPLATE = '✂️ DSH 输出达到令牌上限\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n轮次: {turn}\n→ {webUrl}'
export const DEFAULT_STOP_ABORTED_TEMPLATE = '🛑 DSH 轮次被中止\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n原因: {cancelCause}\n→ {webUrl}'
export const DEFAULT_STOP_INTERRUPTED_TEMPLATE = '⚠️ DSH 异常中断的轮次已闭合\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n轮次: {turn}\n→ {webUrl}'
export const DEFAULT_RETRY_TEMPLATE = '🔁 DSH 正在重试模型请求\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n重试: {retry}{maxRetriesLabel}\n退避: {delaySec}s\n错误: [{errorLabel}]\n详情: {errorMessage}\n→ {webUrl}'
export const DEFAULT_STALL_TEMPLATE = '⏳ DSH 长时间无进展\n工作区: {workspace}\n会话: {sessionTitle} ({sessionId})\n停滞: {stalledMin} 分钟\n→ {webUrl}'
export const DEFAULT_GOODBYE_TEMPLATE = '👋 DSH 已正常退出\n时间: {time}'

/** Idle grace window applied to the complete/stop idle model (doc 09 §7.1). */
export const DEFAULT_IDLE_GRACE_MS = 5_000

/** Runtime schema; Cordis validates `config` against it before `apply()`. */
export const Config: z<Config> = z.object({
  target: z.object({
    chatId: z.string().default(''),
    userId: z.string().default(''),
  }),
  routing: z.array(z.object({
    title: z.string().default(''),
    path: z.string().default(''),
    chatId: z.string().default(''),
    userId: z.string().default(''),
  })).default([]),
  webUrl: z.string().default('http://127.0.0.1:3080'),
  identity: z.union(['bot', 'user'] as const).default('bot'),
  bin: z.string().default('lark-cli'),
  timeoutMs: z.number().default(30_000),
  graceMs: z.number().default(500),
  debounceMs: z.number().default(3_000),
  dryRun: z.boolean().default(false),
  setupTimeoutMs: z.number().default(180_000),
  goodbye: z.object({
    enabled: z.boolean().default(true),
    template: z.string().default(DEFAULT_GOODBYE_TEMPLATE),
  }),
  watchdog: z.object({
    enabled: z.boolean().default(false),
    heartbeatFile: z.string().default(''),
    intervalMs: z.number().default(5_000),
  }),
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
    complete: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_COMPLETE_TEMPLATE),
      idleGraceMs: z.number().default(DEFAULT_IDLE_GRACE_MS),
      throttleMs: z.number().default(1_800_000),
    }),
    'stop:blocked': z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_STOP_BLOCKED_TEMPLATE),
      throttleMs: z.number().default(300_000),
    }),
    'stop:max-tokens': z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_STOP_MAX_TOKENS_TEMPLATE),
      throttleMs: z.number().default(300_000),
    }),
    'stop:aborted': z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_STOP_ABORTED_TEMPLATE),
      throttleMs: z.number().default(300_000),
    }),
    'stop:interrupted': z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_STOP_INTERRUPTED_TEMPLATE),
      throttleMs: z.number().default(300_000),
    }),
    retry: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_RETRY_TEMPLATE),
      retryThreshold: z.number().default(2),
      intervalMs: z.number().default(300_000),
    }),
    stall: z.object({
      enabled: z.boolean().default(true),
      template: z.string().default(DEFAULT_STALL_TEMPLATE),
      stallMs: z.number().default(600_000),
      repeatMs: z.number().default(3_600_000),
    }),
  }),
})
