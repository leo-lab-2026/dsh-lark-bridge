/**
 * Transport seam: one notification ready for delivery, plus the `Notifier`
 * interface every transport implementation satisfies. The V1 implementation
 * is `LarkCliTransport` (lark-cli subprocess); future transports (node-sdk
 * direct API, sidecar proxy, …) only implement this interface.
 * @module dsh-lark-bridge/transport/types
 */

/** One notification ready to be delivered. */
export interface NotificationMessage {
  /** Plain-text body (sent as a Feishu text message). */
  text: string
  /** Short idempotency key forwarded to lark-cli (dedupes retried sends, ≤50 chars). */
  idempotencyKey: string
  /**
   * Optional per-message target override (setup/test flows deliver to a
   * freshly discovered chat); absent → the transport's configured target.
   */
  target?: { chatId?: string; userId?: string }
}

/** Diagnostics snapshot for `/lark-notify status`. */
export interface NotifierStatus {
  sent: number
  failed: number
  lastError?: string
}

/**
 * Send one notification. Implementations must NEVER throw: failures are
 * reported through the logger and counted in {@link Notifier.status}.
 */
export interface Notifier {
  /** @returns true when the notification was delivered (or simulated in dry-run). */
  send(message: NotificationMessage): Promise<boolean>
  status(): NotifierStatus
}
