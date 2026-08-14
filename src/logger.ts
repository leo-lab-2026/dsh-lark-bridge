/**
 * Minimal structural logger the plugin consumes. The cordis `Logger` returned
 * by `ctx.logger(name)` satisfies it, and tests can pass plain stubs.
 * @module dsh-lark-bridge/logger
 */

export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Logger that discards everything — used when no logger is supplied. */
export const silentLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
