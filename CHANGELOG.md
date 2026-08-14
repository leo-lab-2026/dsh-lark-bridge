# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).
While the major version is `0`, breaking changes may land in minor releases.

## [Unreleased]

## [0.1.1-beta.0] - 2026-08-14

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

[Unreleased]: https://github.com/leo-lab-2026/dsh-lark-bridge/compare/v0.1.1-beta.0...main
[0.1.1-beta.0]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.1.1-beta.0
[0.1.0]: https://github.com/leo-lab-2026/dsh-lark-bridge/releases/tag/v0.1.0
