/**
 * Workspace resolution: builds a session → workspace index from the DSH
 * workspace registry (`ctx.workspaceRegistry`, provided by the standard
 * web-app bundle) so notifications can carry the owning project/workspace.
 *
 * The registry is optional and best-effort:
 * - When absent (custom minimal profiles without `@deepseek-ai/dsh-workspace`),
 *   resolution falls back to the session's header `cwd` (basename), which
 *   every session created in a directory carries.
 * - When present but not yet initialized, reads are guarded (list() throws
 *   before `Service.init` settles) and simply yield no workspace yet; the
 *   index is rebuilt on the engine's periodic tick.
 *
 * The plugin never depends on `@deepseek-ai/dsh-workspace` at the type level
 * (it is not a dependency of this package) — the registry is consumed through
 * a structural read of `ctx.get('workspaceRegistry')`.
 * @module dsh-lark-bridge/workspace
 */

/** The minimal structural shape of one registry workspace the plugin reads. */
export interface RegistryWorkspaceLike {
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** The minimal structural shape of `ctx.workspaceRegistry` the plugin reads. */
export interface WorkspaceRegistryLike {
  list(): readonly RegistryWorkspaceLike[]
}

/** Structural reader so the plugin needs no dependency on dsh-workspace types. */
export type WorkspaceRegistryProvider = () => WorkspaceRegistryLike | undefined

/**
 * Incremental session → workspace index. `refresh()` resyncs from the
 * registry's `list()` (cheap: an in-memory projection), `workspaceOf` answers
 * a session's owning workspace.
 */
export class WorkspaceIndex {
  private readonly bySession = new Map<string, RegistryWorkspaceLike>()

  /** Rebuild the index from the registry's current projection (no-op when absent). */
  refresh(provider: WorkspaceRegistryProvider): void {
    let registry: WorkspaceRegistryLike | undefined
    try {
      registry = provider()
    } catch {
      return // registry not (yet) initialized — keep the previous index
    }
    if (registry === undefined) return
    const next = new Map<string, RegistryWorkspaceLike>()
    for (const workspace of registry.list()) {
      for (const sessionId of workspace.sessionIds) {
        const key = String(sessionId)
        // First workspace claiming a session wins (a session belongs to one
        // workspace; duplicates in list() would indicate a registry invariant
        // violation we must not crash on).
        if (!next.has(key)) next.set(key, workspace)
      }
    }
    this.bySession.clear()
    for (const [key, workspace] of next) this.bySession.set(key, workspace)
  }

  /** The workspace owning a session, or undefined. */
  workspaceOf(sessionId: string): RegistryWorkspaceLike | undefined {
    return this.bySession.get(sessionId)
  }

  /** Number of indexed sessions (diagnostics). */
  size(): number {
    return this.bySession.size
  }
}
