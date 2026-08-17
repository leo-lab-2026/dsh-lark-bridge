# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).
While the major version is `0`, breaking changes may land in minor releases.

## [0.3.0-beta.0] - 2026-08-17

### Added
- Workspace/project info in every notification. The default templates now
  carry a `工作区: {workspace}` line (dropped when the workspace cannot be
  resolved, so no empty-label noise).
- New common template variables: `{workspace}`/`{workspaceTitle}`
  (workspace registry title, falling back to the session `header.cwd`
  basename), `{workspacePath}` (workspace path, falling back to `cwd`), and
  `{cwd}` (session working directory).
- `WorkspaceIndex` (`src/workspace.ts`): an optional, best-effort
  session → workspace index rebuilt from `ctx.workspaceRegistry.list()` on
  install and on the periodic engine tick (60s). When the registry is absent
  (minimal custom profiles), the plugin falls back to `header.cwd`; when both
  are missing the workspace line is omitted.
- `/lark-notify status` diagnostics gained the resolved-workspace count.
- Per-workspace routing (`src/routing.ts`): each workspace can bind its own
  notification target (one Feishu group per project) via `/lark-notify route`
  (guided capture: message the bot from the target group) or the `routing`
  list in the Web settings panel / `config.routing` YAML. Matching prefers the
  workspace title, then falls back to the path (renames don't break routing);
  unbound workspaces fall back to the global default target.

## [0.2.0-beta.1] - 2026-08-17

### Added
- Phase 2A: complete "DSH stopped working = always notified" coverage
  (roadmap docs/09 §7.1).
  - `complete` category: notifies when the agent goes idle after a
    `completed` turn, with an idle grace window (default 5s) that filters
    goal auto-continuation and `/loop` followups; throttled per session
    (default 30 min).
  - `stop` category family via the same idle model: `stop:blocked` (detail
    from the latest `update_goal` `blocked_reason`), `stop:max-tokens`,
    `stop:aborted` (`user`/`parent` causes suppressed), and
    `stop:interrupted`.
  - `retry` category: backoff notifications from `llm/retry` events with an
    attempt threshold (default 2) and per-session interval throttle.
  - `stall` category: periodic scan that notifies when a running agent
    produces no events for `stallMs` (default 10 min), with repeat reminders
    (default 60 min).
  - `goodbye` farewell notification on normal exit, sent only when the whole
    application tree unloads (plugin HMR/reload stays silent).
  - Process-death watchdog: in-process heartbeat file
    (`watchdog.heartbeatFile`) plus the external supervisor
    `scripts/lark-watchdog.mjs` (loop or `--once` cron mode) that alerts
    through lark-cli when the heartbeat goes stale.
- Engine now observes the second data source `agent/status` (idle grace race
  per session) and runs a periodic category tick; `notifyNow` throttle keys
  are namespaced per category.
- `/lark-notify status` now lists enabled notification categories and the
  idle/tracked-session diagnostics.
- New per-category config and templates for complete/stop/retry/stall plus
  `goodbye`/`watchdog` sections (all defaulted by the Schemastery schema).

### Changed
- `Category` seam extended with optional `agentStatus`/`onIdleSettle`/`tick`
  callbacks (V1 contract unchanged); stall/stop categories are factories so
  plugin reloads never share stale session state.
- The idle-model categories (complete/stop family) skip subagent child
  sessions (`header.origin === 'subagent'`): a subagent finishing is not
  "DSH stopped working".
- devDependencies: added `@deepseek-ai/dsh-agent`, `dsh-scope`,
  `dsh-llm-retry` and their type-only transitive links (all harness sources,
  type-level usage only).

## [0.1.1-beta.1] - 2026-08-14

### Changed
- Release pipeline only: npm trusted publishing (GitHub OIDC + SLSA
  provenance) and automatic `next` dist-tag for prerelease tags. No
  user-visible changes.

## [0.1.0] - 2026-08-14

### Added
- First release: real-time Feishu/Lark notifications when a DSH session pauses
  for user interaction.
- Three notification categories with per-category templates: permission asks
  (`permission`), model questions (`question`, including plan-mode reviews),
  and fatal turn errors (`error`, throttled to once per 5 minutes per session).
- Notification channels: p2p chat (`chatId`) and direct user (`userId`).
- `/lark-notify` command family: `setup` (interactive first-run capture of the
  bot's p2p chat), `test`, and `status` (one-shot diagnostics).
- DSH Web settings section `lark-notify` (chatId/userId/dryRun, live apply).
- `dryRun` mode and full template-variable support; fail-soft behavior when
  `lark-cli` is missing or delivery fails.

### Changed
- Declared no runtime dependency on `@deepseek-ai/dsh-settings`: the settings
  namespace brander is now an inlined parity copy of the upstream helper
  (the package remains a dev/type-only dependency).
- Added npm publish metadata (`keywords`, `repository`, `publishConfig`,
  `packageManager`), LICENSE, and release gates (`prepublishOnly`).

[Unreleased]: https://github.com/leo-lab-2026/dsh-lark-bridge/compare/v0.3.0-beta.0...main
[0.3.0-beta.0]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.3.0-beta.0
[0.2.0-beta.1]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.2.0-beta.1
[0.1.1-beta.1]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.1.1-beta.1
[0.1.0]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.1.0
