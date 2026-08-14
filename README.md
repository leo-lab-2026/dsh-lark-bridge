# dsh-lark-bridge

DeepSeek Harness 插件：当 DSH 会话因**等待使用者交互**而停顿时，实时调用 [lark-cli](https://github.com/larksuite/cli) 发送飞书/Lark 通知，提醒你回到 DSH 继续处理。

## 功能

| 类别 | 触发 | 通知时机 |
|---|---|---|
| 权限申请 | 工具申请审批（如沙箱升级） | 等待审批期间（约 0.5s 宽限期内被秒批则不打扰） |
| 向用户提问 | 模型调用 `ask_user_question`（含 plan mode 计划评审） | 等待回答期间 |
| 错误致停 | 轮次以致命错误结束（模型 400/401/403/配额/重试耗尽等 4xx-5xx） | 立即（每会话 5 分钟节流） |

插件是纯只读观察者：只监听 DSH 持久事件流，不拦截任何执行链、不代答任何审批/提问；lark-cli 缺失或发送失败时 fail-soft（只告警、绝不影响 DSH）。

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
- `/lark-notify status` → 一键诊断：通知目标、lark-cli 存在性与认证状态、发送统计、setup 进度与可执行提示；
- 真实触发：让模型执行一个需要审批的操作 / 调用 `ask_user_question` / 制造一次模型错误，飞书应收到对应通知。

## 配置参考

完整配置项、模板变量、每类别开关见 [docs/09-notify-plugin.md](./docs/09-notify-plugin.md)。

模板变量：公共 `{sessionId} {sessionTitle} {webUrl} {time}`；permission `{tool} {reason}`；question `{header} {question} {options} {questions} {number}`；error `{errorLabel} {errorCode} {errorStatus} {errorMessage} {turn}`。当 `{options}` 为空时，仅由 `Options: {options}` 构成的整行自动省略。

## 常见问题

| 现象 | 处理 |
|---|---|
| `status` 显示「无法执行 lark-cli」 | `npx @larksuite/cli@latest install`；若二进制不在 PATH，在 config 里设置 `bin` 绝对路径 |
| `status` 显示 bot 不可用 | `lark-cli config init` 重新配置应用凭据（App ID/Secret） |
| setup 窗口内没捕获到消息 | 确认开发者后台已开通 `im.message.receive_v1` 事件订阅，且已授予 `im:message.p2p_msg:readonly`；再给机器人发一次消息重试 |
| 发送失败（`status` 的最近错误） | 错误信息含飞书 error 信封与 hint：常见为缺 scope（`im:message`/`im:message:send_as_bot`）或机器人不在会话中 |
| 飞书提示「Bot can NOT be out of the chat」 | 该 chat_id 不属于机器人可发送的会话；用方式 A/B 重新获取正确的 p2p chat_id |

## 发布与安装说明（维护者）

- **npm 发布**：`pnpm build && pnpm publish`——包内含预构建的 `lib/`，用户安装时不会执行构建；
- **GitHub 源码安装**：`prepare` 脚本负责转译；用户需按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 中授权 `allowBuilds`（参见 DSH 官方插件分发文档）；
- **锁定 lark-cli 版本**：输出/错误契约随 lark-cli 迭代，README 建议用户锁定 `@larksuite/cli` 版本；
- **本地开发**：devDependencies 通过 `link:` 指向同机的 `deepseek-harness` checkout（需位于 `../deepseek-harness` 且已构建）；`pnpm test`（88 用例，含真实子进程 fixture）、`pnpm typecheck`、`pnpm build`。

## 开发

架构与设计（停顿检测模型、grace 竞态、Category/Notifier 两条接缝、Phase 2 路线图、安全）见 [docs/09-notify-plugin.md](./docs/09-notify-plugin.md)；DSH/Lark 调研背景见 [docs/README.md](./docs/README.md)。
