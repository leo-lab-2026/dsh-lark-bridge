/**
 * Per-workspace routing: maps a session's owning workspace to a dedicated
 * notification target (typically one Feishu group per project), so the user
 * can keep project notifications in separate chats.
 *
 * Routing is configured per workspace, either through `/lark-notify route`
 * (guided: capture the group's chat_id by messaging the bot from that group)
 * or through the DSH Web settings panel. Every route entry records BOTH the
 * workspace title (user-facing, matches the registry title) and its path
 * (the stable key that survives renames). Matching prefers the exact title
 * and falls back to the path — a renamed workspace keeps routing by path.
 *
 * A workspace with no matching route falls back to the global default target
 * (the plugin's existing `target`), so notifications are never dropped.
 * @module dsh-lark-bridge/routing
 */

/** One workspace → notification-target binding. */
export interface RoutingEntry {
  /** Workspace title at bind time (also the display name in the settings panel). */
  title: string
  /** Workspace canonical path at bind time — the stable key surviving renames. */
  path: string
  /** Destination chat (group p2p chat id) for this workspace. */
  chatId: string
  /** Destination user (open_id) for this workspace. */
  userId: string
}

/** The resolved workspace identity of one session (title + path). */
export interface SessionWorkspaceInfo {
  title: string
  path: string
}

/**
 * Resolve the effective target for a session's workspace from the routing
 * table. Title match wins (exact, non-empty); a path match is the fallback
 * that keeps routing stable across workspace renames. Returns undefined when
 * no route matches — the caller falls back to the global default target.
 */
export function matchRoute(
  routes: readonly RoutingEntry[],
  workspace: SessionWorkspaceInfo | undefined,
): { chatId?: string; userId?: string } | undefined {
  if (workspace === undefined) return undefined
  if (workspace.title !== '') {
    const byTitle = routes.find(route => route.title !== '' && route.title === workspace.title)
    if (byTitle !== undefined && targetSet(byTitle)) return targetOf(byTitle)
  }
  if (workspace.path !== '') {
    const byPath = routes.find(route => route.path !== '' && route.path === workspace.path)
    if (byPath !== undefined && targetSet(byPath)) return targetOf(byPath)
  }
  return undefined
}

/** True when an entry carries at least one usable target id. */
function targetSet(route: RoutingEntry): boolean {
  return route.chatId.trim() !== '' || route.userId.trim() !== ''
}

function targetOf(route: RoutingEntry): { chatId?: string; userId?: string } {
  return {
    ...(route.chatId.trim() !== '' ? { chatId: route.chatId } : {}),
    ...(route.userId.trim() !== '' ? { userId: route.userId } : {}),
  }
}

/**
 * Upsert a routing entry keyed by path (and, failing that, title): replaces
 * an existing entry for the same workspace path or title, appends otherwise.
 * Used by `/lark-notify route` and the settings-panel write path.
 */
export function upsertRoute(
  routes: readonly RoutingEntry[],
  entry: RoutingEntry,
): RoutingEntry[] {
  const rest = routes.filter(route =>
    route.path !== entry.path && route.title !== entry.title,
  )
  return [...rest, entry]
}
