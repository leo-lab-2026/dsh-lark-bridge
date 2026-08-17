# 10 · 发布手册（维护者 checklist）

> 本文件是 `dsh-lark-bridge` 的完整发布方案。背景调研见 [03-development-workflow.md](./03-development-workflow.md) §⑦ 与
> DSH 官方文档《[打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)》。

## 1. 渠道决策（事实依据）

- **DSH 没有自有插件市场。** `dsh plugin --profile <name> <args>` 只是 pnpm 转发器：在 `$DSH_HOME/profiles/<name>` 里执行 pnpm，可装 registry 包、git 源、tarball、本地目录。装完后凡声明 `dsh.bundle.patch` 的包自动进入 `dsh.profile.bundles` 层栈。
- **主渠道 = npmjs（无 scope 的 `dsh-lark-bridge`）**：官方文档明确推荐「发布预构建 `lib/` 的 npm 包」，用户 `dsh plugin --profile <name> add dsh-lark-bridge` 即装即用，无需 `allowBuilds` 授权。
- **辅助渠道**：GitHub Release 附 tarball 资产（支持 `github:leo-lab-2026/dsh-lark-bridge#<tag>` 与内网/离线分发）。
- **发现性**：靠 npm `keywords`（`dsh-plugin`、`deepseek-harness`）+ README，DSH 无官方插件目录；npmjs 上已有 `dsh-remote`、`dsh-clawrouter` 等同类先例。
- **不要做**：不自建市场、不申请 `@deepseek-ai` scope、不向 npmmirror（只读镜像）发布。

## 2. 一次性准备（Phase 0）

```sh
# 1. npmjs 账号 + 2FA；CI 用 granular automation token（仅本包 publish 权限）→ GitHub Secrets `NPM_TOKEN`
# 2. 本机登录（必须显式指向官方源，本机默认 registry 可能是只读镜像）
npm login --registry=https://registry.npmjs.org/
# 3. 名称可用性确认（应 404）
npm view dsh-lark-bridge --registry=https://registry.npmjs.org/
```

## 3. 每次发布流程

### 3.1 发布前门禁（Phase 1，必须全绿）

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build     # test 全绿（含真实子进程 fixture）
npm pack --dry-run                            # 核对白名单：lib/、cordis.patch.yml、
                                              #   README.md、LICENSE、CHANGELOG.md、package.json
                                              #   绝无 src/、tests/、密钥、*.tgz
```

干净环境彩排（不依赖本仓 `link:` devDeps，模拟真实用户）：

```sh
DSH_HOME=$(mktemp -d) dsh plugin --profile demo add ./dsh-lark-bridge-<ver>.tgz
dsh --profile demo --dump-config              # 必须出现 dsh-lark-notify 行
dsh --profile demo                            # 能启动；/lark-notify status 正常
```

### 3.2 发布到 npmjs（Phase 2）

**发布 = 推 tag（全自动，无需任何 npm token）**。发布权已通过 npm trusted publishing
（GitHub OIDC）委托给 `.github/workflows/publish.yml`：推 `v*` tag 触发，自动跑门禁后
`npm publish --provenance --access public`，SLSA 构建溯源随版本发布。规则：

- 预发布 tag（`v*-beta.*`/`v*-rc.*`/`v*-pre.*`/`v*-dev.*`）自动走 `next` dist-tag；`latest` 只收稳定版；
- 版本已存在时幂等跳过发布（仍会刷新 GitHub Release 资产）；
- 若 workflow 改名或迁移仓库，需重新执行 `npm trust github dsh-lark-bridge --file publish.yml --repository <owner>/<repo> --allow-publish --registry https://registry.npmjs.org/`（该操作要求 2FA，绕过 2FA 的 granular token 会被 npm 拒绝）。

**手动兜底**（仅当 CI 不可用时；本机 `npm login` 后执行）：

```sh
npm publish --registry=https://registry.npmjs.org/ --access public
```

发布后验证：`npm view dsh-lark-bridge`（latest、README/LICENSE/keywords 齐全，`provenance` 字段存在）→ 用 registry 包名再做一遍 3.1 彩排。

### 3.3 GitHub Release 与源码安装路径（Phase 3）

```sh
git tag -a v0.1.0 -m "dsh-lark-bridge 0.1.0" && git push origin v0.1.0
# publish.yml 自动创建 Release（附 pnpm pack tarball 资产），无需手工操作
```

验证辅助渠道：`dsh plugin --profile demo add github:leo-lab-2026/dsh-lark-bridge#v0.1.0`，
首次会因 pnpm ≥10.26 的构建拦截失败——按提示把 `allowBuilds: dsh-lark-bridge: true` 写进 profile 的
`pnpm-workspace.yaml` 后重跑。

## 4. 版本与回滚政策

- `latest` **只指向稳定版**；预发布 `0.x.0-beta.N` 必须 `--tag next`（教训：`@cxyhhhhh/dsh-qqbot` 把 dev 版放进了 latest）。
- 语义化：patch=bug 修复；minor=新功能/新通知类别；0.x 阶段 breaking 可进 minor。
- **应急回滚：永不 `npm unpublish`**，只用 `npm deprecate dsh-lark-bridge@<坏版本> "upgrade to <新版本>"` + 立刻发补丁版；
  用户侧恢复：同 semver 范围内 `dsh plugin --profile <name> update dsh-lark-bridge`，跨版本则
  `dsh plugin --profile <name> add dsh-lark-bridge@<新版本>`（`update` 不会跨越安装时声明的版本范围）——完整用户指引见 README「更新插件」。

## 5. 发布安全清单（每版人工核对）

- [ ] `npm pack --dry-run` 内容复核：无 `src/`、`tests/`、`*.tgz`、密钥/凭据、本地路径残留
- [ ] `lib/` 内无对 `@deepseek-ai/dsh-*` 的运行时 import（类型导入已被擦除；`grep -r "from '@deepseek-ai/dsh" lib/` 应为空）
- [ ] `cordis.patch.yml` 默认值安全（无通知目标、`dryRun: false`）
- [ ] CHANGELOG 已写本版条目；tag 与版本号一致
- [ ] 干净环境彩排通过（3.1 末尾）

## 6. 验收标准（发布完成 = 全部为真）

1. `npm view dsh-lark-bridge`：latest 为本次版本，README/LICENSE/keywords 齐全，可被 `npm search dsh-plugin` 找到；
2. `DSH_HOME=$(mktemp -d)` 下 `dsh plugin --profile demo add dsh-lark-bridge` 成功，`--dump-config` 出现 `dsh-lark-notify`，
   配置目标后 `/lark-notify test` 收到真实飞书消息；
3. `github:leo-lab-2026/dsh-lark-bridge#v<ver>` 安装路径可用（allowBuilds 后）；
4. CI 从 tag 一键发布且带 provenance；`latest` 永不指向预发布版。

## 7. 发布记录

| 版本 | 日期 | 方式 | 备注 |
|---|---|---|---|
| 0.1.0 | 2026-08-14 | 手动 `npm publish --registry=https://registry.npmjs.org/`（账号 `leo-lab-2026`） | registry 名干净安装彩排通过；`publish.yml` 对已发布版本幂等跳过，推 `v0.1.0` tag 仅创建 GitHub Release |
| 0.1.1-beta.1 | 2026-08-14 | **CI 全自动（trusted publishing）**：推 `v0.1.1-beta.1` tag | OIDC + SLSA provenance 验证通过（attestations API 可查）；`next` 指向该版，`latest` 仍为 0.1.0；仓库无任何 npm token/secret |
| 0.2.0-beta.1 | 2026-08-17 | **CI 全自动（trusted publishing）**：推 `v0.2.0-beta.1` tag | Phase 2A 单向通知补齐（complete/stop 族/retry/stall/goodbye/watchdog）；预发布走 `next`，`latest` 保持 0.1.0 |
| 0.3.0-beta.0 | 2026-08-17 | **CI 全自动（trusted publishing）**：推 `v0.3.0-beta.0` tag | 工作区信息 + 按工作区路由（新功能，minor）；预发布走 `next`，`latest` 保持 0.1.0 |

**从 0.1.1-beta.1 起发布已全自动化**：bump `package.json` 版本 + 写 CHANGELOG + 推 `v*` tag 即完成发布（含 provenance 与 GitHub Release）。预发布 tag 自动走 `next`，稳定版 tag 走 `latest`。手动兜底仍可用（§3.2）。

CI 注意事项：两个 workflow 都**钉住**了 harness 提交（`47f943859b`，发布时的公开 master HEAD）。本地 `../deepseek-harness` checkout 升级后，需同步 bump 两处 `ref:` 并重跑本地门禁。

**OIDC 硬性要求（踩过的坑）**：publish workflow 必须跑 **Node 24**（自带 npm ≥ 11.5.1，OIDC 才生效；Node 22 自带 npm 10，会退回 token 认证并 404）；且 `actions/setup-node` **不要配置 `registry-url`**——无真实 `NODE_AUTH_TOKEN` 时 setup-node 会写入占位 token，令 OIDC 失效、发布 404。
