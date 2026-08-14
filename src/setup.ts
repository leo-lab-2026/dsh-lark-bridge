/**
 * Setup flow: guided discovery of the notification target for public users.
 *
 * `/lark-notify setup` returns immediately ("please message the bot"), then
 * listens in the background through `lark-cli event consume
 * im.message.receive_v1 --max-events 1 --timeout 180s`. The first human
 * message yields BOTH the p2p chat_id and the sender's open_id; the captured
 * target is written into the plugin's settings namespace (persisted in
 * settings.yaml, visible in the Web settings panel) and a test notification
 * is delivered to the discovered chat.
 *
 * The run is abortable (plugin unload / a second setup cancels it) and every
 * failure lands in {@link SetupController.status} + the log — never a throw.
 * @module dsh-lark-bridge/setup
 */

import { captureOneMessage, type CapturedMessage } from './transport/event-consume.js'
import type { PluginLogger } from './logger.js'

export type SetupState = 'idle' | 'listening' | 'success' | 'failed'

export interface SetupStatus {
  state: SetupState
  /** Epoch ms the current/last run started. */
  since?: number
  /** Failure explanation (state === 'failed'). */
  error?: string
  /** Captured chat id (state === 'success'). */
  chatId?: string
}

export interface SetupControllerOptions {
  bin: string
  identity: 'bot' | 'user'
  /** Listen window forwarded to event consume and the local deadline. */
  captureTimeoutMs: number
  logger: PluginLogger
  /** Persist the captured target + send the confirmation (may throw → failed state). */
  onCaptured?: (message: CapturedMessage) => Promise<void> | void
}

export const SETUP_FAILURE_HINTS = {
  empty: '没有在窗口内收到消息。请确认：开发者后台已开通事件订阅 im.message.receive_v1，'
    + '应用已授予接收单聊消息权限（im:message.p2p_msg:readonly），且机器人已收到你的消息。',
} as const

export class SetupController {
  private current: SetupStatus = { state: 'idle' }
  private controller: AbortController | undefined

  constructor(private readonly options: SetupControllerOptions) {}

  status(): SetupStatus {
    return { ...this.current }
  }

  isActive(): boolean {
    return this.current.state === 'listening'
  }

  /** Cancel an in-flight capture (plugin unload). */
  stop(): void {
    this.controller?.abort()
  }

  /**
   * Start (or report an active) capture run. Resolves with the outcome text;
   * the capture itself continues in the background of the caller's tick.
   */
  async run(): Promise<{ ok: boolean; message: string }> {
    if (this.isActive()) {
      return { ok: false, message: '已在监听中：现在给机器人发送任意一条消息即可（窗口内会一直等待）。' }
    }
    this.controller = new AbortController()
    const since = Date.now()
    this.current = { state: 'listening', since }
    const { logger } = this.options

    const captured = await captureOneMessage({
      bin: this.options.bin,
      eventKey: 'im.message.receive_v1',
      identity: this.options.identity,
      timeoutMs: this.options.captureTimeoutMs,
      logger,
      signal: this.controller.signal,
      onReady: () => {
        logger.info('[dsh-lark-notify] setup 已开始监听 — 现在去飞书给机器人发送任意一条消息')
      },
    })

    if (captured === undefined) {
      if (this.controller.signal.aborted) {
        this.current = { state: 'idle' }
        return { ok: false, message: '监听已取消。' }
      }
      this.current = { state: 'failed', since, error: SETUP_FAILURE_HINTS.empty }
      return { ok: false, message: SETUP_FAILURE_HINTS.empty }
    }

    this.current = { state: 'success', since, chatId: captured.chatId }
    try {
      await this.options.onCaptured?.(captured)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.current = { state: 'failed', since, chatId: captured.chatId, error: message }
      return { ok: false, message: `已捕获会话 ${captured.chatId}，但保存/测试发送失败：${message}` }
    }
    return {
      ok: true,
      message: `已捕获会话 ${captured.chatId}（发送者 ${captured.senderId}）并写入设置；测试通知已发送，去飞书确认。`,
    }
  }
}
