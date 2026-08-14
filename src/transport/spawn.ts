/**
 * Small child-process runner around `node:child_process` spawn with the
 * guarantees the transport needs: output capture (capped), a hard timeout,
 * cancellation, and SIGTERM-only termination (never kill -9 — see the
 * lark-cli event-consumer contract; sending is stateless but SIGTERM is the
 * uniform graceful stop).
 * @module dsh-lark-bridge/transport/spawn
 */

import { spawn } from 'node:child_process'

/** Settled result of one process run. */
export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Inputs for one process run. */
export interface RunProcessOptions {
  bin: string
  args: readonly string[]
  timeoutMs: number
  env?: Record<string, string>
  signal?: AbortSignal
  /** Cap on captured stdout+stderr bytes (default 1 MiB); capture stops, draining continues. */
  maxOutputBytes?: number
}

/** Rejection for spawn-level failures (e.g. ENOENT when lark-cli is missing). */
export class ProcessError extends Error {
  override readonly name = 'ProcessError'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Run one child process to completion (or timeout/abort) and capture its output. */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const maxBytes = options.maxOutputBytes ?? 1_048_576
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(options.bin, [...options.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
      // Own process group: stopping the whole group also reaps grandchildren
      // (e.g. a CLI wrapper that execs helpers), which would otherwise keep
      // the pipe FDs open and delay the 'close' event indefinitely.
      detached: true,
    })

    const finish = (result: ProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const stop = (): void => {
      // SIGTERM only: the graceful stop every lark-cli surface supports.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Group already gone — fall back to a plain kill, ignoring ESRCH.
        try {
          child.kill('SIGTERM')
        } catch {
          // Nothing left to signal.
        }
      }
    }
    const onAbort = (): void => { stop() }

    if (options.signal !== undefined) {
      if (options.signal.aborted) stop()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timer = setTimeout(stop, options.timeoutMs)
    timer.unref?.()

    const collect = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const budget = maxBytes - stdout.length - stderr.length
      if (budget <= 0) return
      const text = chunk.toString('utf8')
      if (target === 'stdout') stdout += text.length > budget ? text.slice(0, budget) : text
      else stderr += text.length > budget ? text.slice(0, budget) : text
    }

    child.stdout.on('data', (chunk: Buffer) => { collect(chunk, 'stdout') })
    child.stderr.on('data', (chunk: Buffer) => { collect(chunk, 'stderr') })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      reject(new ProcessError(`failed to spawn "${options.bin}": ${error.message}`, { cause: error }))
    })

    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, stdout, stderr })
    })
  })
}
