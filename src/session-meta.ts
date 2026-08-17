/**
 * Session metadata cache: folds the durable `session/title` events into the
 * latest title per session, and remembers each session's working directory
 * (`header.cwd`) and — when the DSH workspace registry is available — its
 * owning workspace (title + path). Titles and workspaces only decorate
 * notification text: missing data falls back gracefully (title → session id,
 * workspace → basename of cwd).
 * @module dsh-lark-bridge/session-meta
 */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** A session's owning workspace (resolved from the DSH workspace registry). */
export interface SessionWorkspace {
  /** Display title of the workspace (user-renameable; defaults to basename(path)). */
  title: string
  /** Canonical directory path of the workspace. */
  path: string
}

export class SessionMeta {
  private readonly titles = new Map<string, string>()
  private readonly cwds = new Map<string, string>()
  private readonly workspaces = new Map<string, SessionWorkspace>()

  /** Fold one live session event (no-op unless it is a title event). */
  observe(sessionId: SessionId, event: SessionEvent): void {
    if (event.type !== 'session/title') return
    const title = event.data.title.trim()
    if (title === '') return
    this.titles.set(String(sessionId), title)
  }

  /** Remember a session's header facts (working directory). */
  observeHeader(sessionId: SessionId, header: { cwd?: string } | undefined): void {
    const cwd = header?.cwd
    if (cwd === undefined || cwd.trim() === '') return
    this.cwds.set(String(sessionId), cwd)
  }

  /** Record the workspace owning a session (from the DSH workspace registry). */
  setWorkspace(sessionId: SessionId, workspace: SessionWorkspace): void {
    if (workspace.title.trim() === '' && workspace.path.trim() === '') return
    this.workspaces.set(String(sessionId), workspace)
  }

  /** Latest known title for a session, or undefined. */
  titleOf(sessionId: SessionId): string | undefined {
    return this.titles.get(String(sessionId))
  }

  /** The session's header working directory, or undefined. */
  cwdOf(sessionId: SessionId): string | undefined {
    return this.cwds.get(String(sessionId))
  }

  /** The workspace owning a session, or undefined. */
  workspaceOf(sessionId: SessionId): SessionWorkspace | undefined {
    return this.workspaces.get(String(sessionId))
  }

  /** Number of sessions with a cached title (diagnostics). */
  size(): number {
    return this.titles.size
  }

  /** Number of sessions with a cached workspace (diagnostics). */
  workspaceCount(): number {
    return this.workspaces.size
  }
}
