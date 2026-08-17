# dsh-lark-bridge

[![npm version](https://img.shields.io/npm/v/dsh-lark-bridge?style=flat-square&label=npm)](https://www.npmjs.com/package/dsh-lark-bridge)
[![npm downloads](https://img.shields.io/npm/dm/dsh-lark-bridge?style=flat-square)](https://www.npmjs.com/package/dsh-lark-bridge)
[![license](https://img.shields.io/npm/l/dsh-lark-bridge?style=flat-square)](./LICENSE)

DeepSeek Harness 插件：当 DSH 会话**停止工作**——因等待使用者交互而停顿、任务完成、被阻塞/中止、请求退避、进程停滞，甚至进程死亡——都会实时调用 [lark-cli](https://github.com/larksuite/cli) 发送飞书/Lark 通知，实现「DSH 停止工作 = 必收到通知」的完整覆盖。

## 功能

| 类别 | 触发 | 通知时机 |
|---|---|---|
| 权限申请 | 工具申请审批（如沙箱升级） | 等待审批期间（约 0.5s 宽限期内被秒批则不打扰） |
| 向用户提问 | 模型调用 `ask_user_question`（含 plan mode 计划评审） | 等待回答期间 |
| 错误致停 | 轮次以致命错误结束（模型 400/401/403/配额/重试耗尽等 4xx-5xx） | 立即（每会话 5 分钟节流） |
| 任务完成 | 轮次 `completed` 结束且 agent 进入 idle（5s 宽限期过滤 goal 自动续轮/`/loop`） | idle 宽限后（每会话 30 分钟节流） |
| 目标阻塞 | `turn/end` `blocked`（goal 阻塞 / 预步骤拒绝；详情取最近 `update_goal` 的 `blocked_reason`） | idle 宽限后 |
| 令牌上限 | `turn/end` `max-tokens` | idle 宽限后 |
| 轮次被中止 | `turn/end` `aborted`（`user`/`parent` 抑制；`hook`/`disposed`/`legacy` 通知） | idle 宽限后 |
| 异常中断闭合 | `turn/end` `interrupted`（崩溃孤儿轮在重载时闭合） | idle 宽限后 |
| 请求退避 | `llm/retry` 事件达到重试阈值（默认第 2 次起） | 达到阈值即发（每会话 5 分钟节流） |
| 无进展停滞 | agent 保持 `running` 但长时间无任何事件（默认 10 分钟判定） | 判定即发（默认 60 分钟重复提醒） |
| 正常退出 | 插件 dispose（仅整个应用树卸载时，HMR/重载不误报） | 退出时告别通知 |
| 进程死亡 | 进程外监督者：插件写心跳文件，`scripts/lark-watchdog.mjs` 检测心跳丢失 | 心跳超时即发 |

插件是纯只读观察者：只监听 DSH 持久事件流与 `agent/status` 生命周期，不拦截任何执行链、不代答任何审批/提问；lark-cli 缺失或发送失败时 fail-soft（只告警、绝不影响 DSH）。所有类别独立开关，默认全部开启（噪音由宽限窗口与节流控制）。

## 安装

前置要求：Node `^22.19 || >=24`、pnpm、DeepSeek Harness（`dsh`）。

```sh
# 从 npm（发布后）
dsh plugin --profile <name> add dsh-lark-bridge

# 从 GitHub（源码安装；需要授权构建脚本，见下方「发布与安装说明」）
dsh plugin --profile <name> add github:<you>/dsh-lark-bridge#<sha>

# 本地 tarball / 目录
dsh plugin --profile <name> add ./dsh-lark-bridge-0.1.0.tgz
dsh plugin --profile <name> add link:/path/to/dsh-lark-bridge
```

验证安装：`dsh --profile <name> --dump-config` 应出现 `dsh-lark-notify` 行。重启 `dsh` 生效。

> **默认无通知目标**：插件安装后的目标为空（不携带任何聊天/用户 id——那是属于你的个人数据）。首次使用时通过下面的「方式 A（`/lark-notify setup`）」或「方式 B（设置面板）」指定一次，写入 `settings.yaml` 持久生效；之后换机器/换会话重新指定即可。

## 更新插件

插件作为 npm 依赖装在 profile 目录里（`$DSH_HOME/profiles/<name>/node_modules`），`dsh plugin` 是 pnpm 转发器；更新后**重启 `dsh`** 生效。

查看当前安装版本：

```sh
dsh plugin --profile <name> list dsh-lark-bridge
```

**① 小版本/补丁更新（同 semver 范围内）**：

```sh
dsh plugin --profile <name> update dsh-lark-bridge
```

`update` 只在安装时声明的版本范围（如 `^0.1.0`）内找新版本——不跨 minor、默认也不装预发布版。

**② 跨版本 / 预发布版升级（推荐，如 0.1.0 → 0.2.0-beta.1）**：

```sh
dsh plugin --profile <name> add dsh-lark-bridge@0.2.0-beta.1
```

`add` 带显式版本会**重写** profile 的依赖声明为该版本，一步完成升级（pnpm 会把它写入 profile 的 `minimumReleaseAgeExclude`，刚发布的新版本也立即生效）。已装 0.1.0 想升到 0.2.0-beta.1 就用这一条；直接跑 `update` 只会停在 0.1.x。

> 为什么不用 `add dsh-lark-bridge@next`：npm 的 `latest` 只指向稳定版，预发布版挂在 `next` 标签下；且 pnpm ≥ 11.21 的 `minimumReleaseAge` 保护会在标签解析时跳过刚发布的新版本（实测 `@next` 可能解析到更旧的 beta），显式版本号最可靠。

**③ 回滚到旧版**：同样用显式版本：

```sh
dsh plugin --profile <name> add dsh-lark-bridge@0.1.0
```

**更新后验证**：

```sh
dsh --profile <name> --dump-config   # 应出现 dsh-lark-notify 行
```

重启 `dsh` 后进入会话运行 `/lark-notify status`，核对启用的通知类别（0.2.0-beta.1 新增 complete/stop/retry/stall 等）与发送统计。

## 首次配置（三步，约 5 分钟）

### 1. 准备飞书应用与 lark-cli

1. 在[飞书开放平台](https://open.feishu.cn/app/)创建**企业自建应用**（或使用已有应用），拿到 **App ID** 与 **App Secret**；在「应用能力」里**启用机器人**；
2. 在「权限管理」开通发送消息权限（三选一即可）：**`im:message`**（获取与发送单聊、群组消息）或 **`im:message:send_as_bot`**（以应用的身份发消息）或 `im:message:send`（历史版本）——参考[官方发送消息文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create)；
3. 若想用 `setup` 自动配置：在「事件与回调」**开通 `im.message.receive_v1` 事件订阅**，并授予 `im:message:readonly` 与 **`im:message.p2p_msg:readonly`** 权限；
4. 安装并配置 lark-cli（凭据存于 lark-cli 自身，插件从不接触 App Secret）：
   ```sh
   npx @larksuite/cli@latest install
   lark-cli config init     # 交互输入 App ID / App Secret
   lark-cli auth status --json --verify   # 确认 bot identity: ready
   ```

### 2. 配置通知目标（三种方式任选）

**方式 A（推荐）：`/lark-notify setup` 自动配置** — 在 DSH Web 里输入：
```
/lark-notify setup
```
然后去飞书给机器人发**任意一条消息**（默认 3 分钟窗口）。插件会自动捕获你与机器人的会话 `chat_id` 并写入设置（持久化到 `settings.yaml`，无需改任何 YAML），同时发送一条测试通知确认链路。

**方式 B：DSH Web 设置面板手动填写** — 打开 DSH 设置 → 「lark-notify」分节 → 填入 `chatId`（`oc_` 开头）或 `userId`（`ou_` 开头），保存即生效（无需重启）。`chat_id` 可这样获取：
```sh
lark-cli event consume im.message.receive_v1 --max-events 1 --timeout 60s
# 与此同时给机器人发一条消息，输出 NDJSON 里的 chat_id (oc_...) 即目标
```

**方式 C：YAML（部署默认值 / CI / 高级用户）** — 在 profile 的 `cordis.patch.yml` 覆盖插件行（patch 按 `id` 整行替换 config）：
```yaml
- id: dsh-lark-notify
  name: 'dsh-lark-bridge'
  config:
    target:
      chatId: 'oc_xxxxxxxxxxxxxxxx'
    # dryRun: true              # 只打日志不真发（调试）
    # webUrl: 'http://127.0.0.1:3080'
    # bin: '/path/to/lark-cli'  # 不在 PATH 时指定绝对路径
```
优先级：**Web 设置面板（用户层）> YAML（部署层）> 默认值**。方式 A/B 写入的用户设置会覆盖方式 C 的部署默认值。

### 3. 验证

- `/lark-notify test 你好` → 飞书收到测试通知；
- `/lark-notify status` → 一键诊断：通知目标、lark-cli 存在性与认证状态、发送统计、启用的通知类别、setup 进度与可执行提示；
- 真实触发：让模型执行一个需要审批的操作 / 调用 `ask_user_question` / 制造一次模型错误 / 完成任务 / 制造重试退避，飞书应收到对应通知；
- 想一次触发全部场景（提问/权限/完成/停滞/中止反例等）：把 [docs/11-notify-test-script.md](./docs/11-notify-test-script.md) 的测试脚本粘贴给 DSH，按对照表逐条核对。

## 按工作区/项目路由通知（可选）

一个项目对应一个飞书群时，可以让**每个工作区的通知发到各自的群**，互不干扰。默认所有工作区共用全局通知目标（方式 A/B/C 配置的那个）；只有显式绑定了路由的工作区才走专属目标。

**绑定（推荐，零 YAML）**：在**目标工作区对应的 DSH 会话里**输入：

```
/lark-notify route
```

然后去**目标飞书群**给机器人发送任意一条消息（机器人需先被拉进该群；默认 3 分钟窗口）。插件捕获该群的 `chat_id`，自动绑定「当前工作区 → 该群」，并回发一条测试通知确认。多工作区各绑一次即可；重新绑定同一工作区即覆盖。

**管理**：打开 DSH 设置 → 「lark-notify」分节 → `routing` 列表可查看/增删改每条绑定（`title` 工作区名、`path` 路径、`chatId` 群 id）；`/lark-notify status` 显示 route 进度。

**YAML 部署层（CI/批量）**：在 `cordis.patch.yml` 写死映射：

```yaml
- id: dsh-lark-notify
  name: 'dsh-lark-bridge'
  config:
    routing:
      - title: '项目 A'          # 工作区显示名
        path: '/srv/projects/a'  # 工作区路径（重命名后仍按此匹配）
        chatId: 'oc_xxx_a'
        userId: ''
      - title: '项目 B'
        path: '/srv/projects/b'
        chatId: 'oc_xxx_b'
        userId: ''
```

**匹配规则**：按工作区标题精确匹配优先，标题对不上时回退按路径匹配——因此**重命名工作区不会断路由**（路径不变）；**删除工作区**后会话仍会通过 `cwd` 路径命中旧绑定，直到你手动清理。**未绑定目标的工作区走全局默认目标**，通知不丢失。

## 进程死亡看门狗（可选）

进程内观察者无法报告自己的死亡（OOM/崩溃/断电/误杀）。开启插件心跳 + 进程外监督者即可覆盖：

```yaml
# cordis.patch.yml（或作为部署层 config 覆盖）
config:
  watchdog:
    enabled: true
    heartbeatFile: '/tmp/dsh-heartbeat'   # 插件每 5s 更新一次
```

再任选一种方式运行监督者脚本：

```sh
# 常驻模式（默认每 staleMs/4 检查一次）
node scripts/lark-watchdog.mjs --heartbeat-file /tmp/dsh-heartbeat --stale-ms 60000 --chat-id oc_xxx

# 定时任务模式（cron / systemd timer 每 30s 跑一次）
node scripts/lark-watchdog.mjs --heartbeat-file /tmp/dsh-heartbeat --stale-ms 60000 --chat-id oc_xxx --once
```

心跳丢失超过 `stale-ms` 即发「DSH 进程死亡」通知；同一死亡事件按 `--repeat-ms`（默认 60 分钟）去重，状态记录在 `<heartbeat-file>.alerted`。`--once` 退出码：`0` 心跳正常（或重复窗口内抑制）、`2` 已发送告警、`3` 告警发送失败。

## 配置参考

完整配置项、模板变量、每类别开关见 [docs/09-notify-plugin.md](./docs/09-notify-plugin.md)。

模板变量：公共 `{sessionId} {sessionTitle} {workspace} {workspaceTitle} {workspacePath} {cwd} {webUrl} {time}`；permission `{tool} {reason}`；question `{header} {question} {options} {questions} {number}`；error `{errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}`；complete `{turn}`；stop:blocked `{turn} {reason}`；stop:max-tokens `{turn}`；stop:aborted `{turn} {cancelCause}`；stop:interrupted `{turn}`；retry `{retry} {maxRetries} {maxRetriesLabel} {delaySec} {provider} {mode} {errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}`；stall `{stalledMin}`；goodbye `{time}`。当 `{options}` 为空时，仅由 `Options: {options}` 构成的整行自动省略；`工作区: {workspace}` 在无法解析出工作区/项目时整行省略（避免空标签噪音）。

**工作区/项目信息**：通知首行默认显示 `工作区: {workspace}`（DSH 工作区名称，或回退为会话工作目录的目录名），帮助在多个工作区/项目并行工作时一眼分辨通知属于哪个项目。解析优先级：DSH 工作区注册表标题（`ctx.workspaceRegistry`，Web 版内置）→ 会话 `header.cwd` 的 basename → 无（该行省略）。`{workspaceTitle}` 与 `{workspace}` 相同，`{workspacePath}` 为工作区路径（或 cwd），`{cwd}` 为会话工作目录。

**按工作区路由**：`routing` 数组（每条含 `title`/`path`/`chatId`/`userId`）把指定工作区的通知定向到专属目标；按标题精确匹配、回退路径匹配；未命中走全局 `target`。用 `/lark-notify route` 或设置面板绑定，详见上文「按工作区/项目路由通知」。

## 常见问题

| 现象 | 处理 |
|---|---|
| `status` 显示「无法执行 lark-cli」 | `npx @larksuite/cli@latest install`；若二进制不在 PATH，在 config 里设置 `bin` 绝对路径 |
| `status` 显示 bot 不可用 | `lark-cli config init` 重新配置应用凭据（App ID/Secret） |
| setup 窗口内没捕获到消息 | 确认开发者后台已开通 `im.message.receive_v1` 事件订阅，且已授予 `im:message.p2p_msg:readonly`；再给机器人发一次消息重试 |
| `/lark-notify route` 群里发消息没反应 | 机器人需先被拉进该群；确认开发者后台事件订阅包含群消息（`im.message.receive_v1` 的群聊场景），且机器人具备在群内收发消息权限 |
| 发送失败（`status` 的最近错误） | 错误信息含飞书 error 信封与 hint：常见为缺 scope（`im:message`/`im:message:send_as_bot`）或机器人不在会话中 |
| 飞书提示「Bot can NOT be out of the chat」 | 该 chat_id 不属于机器人可发送的会话；用方式 A/B 重新获取正确的 p2p chat_id |

## 发布与安装说明（维护者）

完整发布方案（发布渠道决策、发布前门禁、npmjs 发布流程、dist-tag 政策、回滚预案、CI 自动化）见 [docs/10-publish-checklist.md](./docs/10-publish-checklist.md)。要点：

- **npm 发布**：`pnpm build && npm publish --registry=https://registry.npmjs.org/`（`prepublishOnly` 自动跑 typecheck+test，`prepack` 自动构建 `lib/`）；用户安装时不会执行构建；
- **GitHub 源码安装**：`prepare` 脚本负责转译；用户需按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 中授权 `allowBuilds`（参见 DSH 官方插件分发文档）；
- **锁定 lark-cli 版本**：输出/错误契约随 lark-cli 迭代，README 建议用户锁定 `@larksuite/cli` 版本；
- **本地开发**：devDependencies 通过 `link:` 指向同机的 `deepseek-harness` checkout（需位于 `../deepseek-harness` 且已构建）；`pnpm test`（含真实子进程 fixture）、`pnpm typecheck`、`pnpm build`。

## 开发

架构与设计（停顿检测模型、grace 竞态、Category/Notifier 两条接缝、Phase 2A/2B/2C 路线图、安全）见 [docs/09-notify-plugin.md](./docs/09-notify-plugin.md)；DSH/Lark 调研背景见 [docs/README.md](./docs/README.md)。
