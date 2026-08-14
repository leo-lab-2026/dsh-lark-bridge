# 06 · lark-cli 详解（官方 CLI：功能 / Skills / 事件 / 嵌入）

> 调研源：[github.com/larksuite/cli](https://github.com/larksuite/cli)（本地 clone，npm `@larksuite/cli` v1.0.87，Go ≥1.23 构建；pkg.go.dev `github.com/larksuite/cli` v1.0.27）。这是官方为"人和 AI Agent"设计的飞书/Lark CLI——**Agent-Native** 是其第一设计目标，与 DSH 插件场景天然契合。

## 1. 定位与规模

- 覆盖 **18 个业务域、200+ 命令、26 个 AI Agent Skills**（`skills/` 目录实际 27 个）。
- 所有命令经真实 Agent 测试：精简参数、智能默认值、结构化输出，最大化 Agent 调用成功率。
- 三层命令体系（见 §3）；开源 MIT；`npm install` 即用。

## 2. 安装与认证

```bash
# 安装（npm 方式，推荐）
npx @larksuite/cli@latest install
# 源码方式（需 Go ≥1.23 与 Python3）
git clone https://github.com/larksuite/cli.git && cd cli && make install
npx skills add larksuite/cli -y -g        # 安装配套 SKILL（可选但推荐）

# 三步上手
lark-cli config init                      # 一次性配置应用凭据（交互引导）
lark-cli config init --new                # 生成授权链接（Agent 模式：后台运行，提取 URL 给用户）
lark-cli auth login --recommend           # OAuth 登录，自动选择常用 scope
lark-cli auth login --domain calendar,task --no-wait --json   # 指定域/scope，立即返回授权 URL
lark-cli auth status --json --verify      # 检查登录态/token 有效性
lark-cli auth check <scope>               # 校验某 scope（exit 0=ok, 1=缺失）
```

- **`auth qrcode`** 把授权 URL 转二维码（`--output` 出 PNG）——面向用户的授权流程必须生成二维码。
- **身份切换**：`--as user`（`user_access_token`）/ `--as bot`（`tenant_access_token`），每条命令可带；`lark-cli whoami` 看当前生效身份。
- 环境变量开关：`LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1`（机器读取 JSON 时减少 `_notice` 干扰）。

## 3. 三层命令体系

```bash
# 1) Shortcuts（+前缀）：人机友好、智能默认值、表格输出、--dry-run 预览
lark-cli calendar +agenda
lark-cli im +messages-send --chat-id "oc_xxx" --text "Hello" --as bot
lark-cli docs +create --doc-format markdown --content $'<title>Weekly</title>\n# Progress\n- …'

# 2) API Commands：由 OAPI 元数据生成、经评测筛选的 100+ 命令（1:1 映射平台端点）
lark-cli calendar events instance_view --params '{"calendar_id":"primary","start_time":"1700000000","end_time":"1700086400"}'
lark-cli im messages get --params '{"message_id":"om_xxx"}'

# 3) Raw API：直接打任意 Open Platform 端点（覆盖 2500+ API）
lark-cli api GET  /open-apis/calendar/v4/calendars
lark-cli api POST /open-apis/im/v1/messages --params '{"receive_id_type":"chat_id"}' \
  --data '{"receive_id":"oc_xxx","msg_type":"text","content":"{\"text\":\"Hello\"}"}'
```

### 通用输出契约（Agent 编程的关键）

- `--format json`（默认）：成功 → **stdout** `{"ok":true,"identity":"user|bot","data":...,"meta":{...}}`，exit 0；失败 → **stderr** `{"ok":false,"error":{"type","subtype","code","message","hint"}}`，exit 非 0。
- **判成功用 `ok == true`（或 exit code），不要找 `code == 0`**——CLI 的成功信封没有 `code` 字段（`code` 只出现在 `error` 里，是上游 OpenAPI 码）。
- 其他格式：`--format pretty|table|ndjson|csv`；`--page-all`/`--page-limit N`/`--page-delay MS`（自动翻页）；`--dry-run`（副作用命令预览）。
- **Schema 内省**：`lark-cli schema im.messages.delete` —— 调任何 API 前先查参数结构，不要猜字段。

## 4. 错误契约

错误信封在 stderr，结构化：`error.type`/`error.subtype`（如 `missing_scope` 带 `missing_scopes` 列表）/`error.param`（出错 flag）/`error.hint`（补救动作）。**程序应解析这些字段分支，而不是正则匹配消息文本**。完整分类见仓库 `errs/ERROR_CONTRACT.md`。

## 5. AI Agent Skills（26 个）——可直接喂给 Agent 的能力包

`skills/<name>/` = `SKILL.md`（YAML frontmatter + 正文）+ `references/*.md`（按需读取的深度参考）：

```yaml
---
name: lark-im
version: 1.0.0
description: "飞书即时通讯：收发消息和管理群聊。……"
metadata:
  requires:
    bins: ["lark-cli"]
  cliHelp: "lark-cli im --help"
---
# im (v1)
**CRITICAL — 开始前 MUST 先用 Read 工具读取 ../lark-shared/SKILL.md（认证、权限处理）**
## Core Concepts
…（概念、资源关系图、Identity/Token 映射、注意事项）
## Shortcuts（推荐优先使用）
| Shortcut | 说明 |（每项链到 references/*.md）
## API Resources
lark-cli schema im.<resource>.<method>   # 调用 API 前必须先查看参数结构
…（按资源列出方法、身份限制、须知）
## 权限表
| 方法 | 所需 scope |
```

Skill 清单：`lark-shared`（认证/身份/安全，**被所有 skill 自动前置**）、`lark-im`、`lark-event`（事件订阅）、`lark-calendar`、`lark-doc`、`lark-drive`、`lark-markdown`、`lark-sheets`、`lark-slides`、`lark-base`、`lark-task`、`lark-mail`、`lark-contact`、`lark-wiki`、`lark-vc`、`lark-vc-agent`、`lark-whiteboard`、`lark-minutes`、`lark-attendance`、`lark-approval`、`lark-okr`、`lark-apps`、`lark-note`、`lark-openapi-explorer`（探索底层 API）、`lark-skill-maker`（自定义 skill 框架）、`lark-workflow-meeting-summary`、`lark-workflow-standup-report`。

**与 DSH 的兼容性**（重要，已核实）：DSH `skill-filesystem` provider 识别 `<name>/SKILL.md`（kebab-case 名称 + 必填 `name`/`description` frontmatter，`metadata` 可选，`references/` 作为 bundle 资源允许）。lark skill 目录满足此格式（`lark-im` 等均为 kebab-case）→ **可直接 vendor 到 DSH skill 根目录**（如 `<project>/.dsh/skills/`），由 `tool-skill` 把目录暴露给模型。见 08 §3 方案 B。

## 6. 事件订阅（lark-event）——桥接收消息的核心

基于 WebSocket 长连接 + 本地 bus daemon（Unix Domain Socket 多进程共享一个连接）：

```bash
lark-cli event list [--json]                 # 全部可订阅 EventKey（权威目录）
lark-cli event list --domain im --json       # 按域过滤
lark-cli event schema <EventKey> --json      # 参数/输出 schema + jq_root_path
lark-cli event consume <EventKey> [flags]    # 阻塞消费，事件 → stdout NDJSON
lark-cli event status [--fail-on-orphan]     # bus daemon 状态
lark-cli event stop [--all] [--force]        # 停 daemon
```

常用 flag：`--param k=v`（业务参数）、`--jq '<expr>'`（过滤/投影，空输出跳过该事件）、`--max-events N`、`--timeout D`（先到先退）、`--output-dir <dir>`（每条事件落一个文件）、`--quiet`（**AI 不要用**——会去掉就绪/完整性信号）、`--as user|bot|auto`。

### 子进程契约（为 Agent 子进程调用设计）

1. **就绪标记**：stderr 固定行 `[event] ready event_key=<key>`——父进程**阻塞等这行出现再读 stdout**，不要 sleep。
2. **stdin EOF = 优雅退出**：无界运行时 `< /dev/null`/`nohup` 会立即退出；保活用 `< <(tail -f /dev/null)` 或改有界运行（`--max-events`/`--timeout` 时 stdin EOF 被忽略）。
3. **退出码**：0 = `limit`/`timeout`/`signal`（业务完成）；1 = 预消费阶段 API 业务失败；2 = 校验失败（未知 EventKey/坏参数/已有连接）；3 = 认证失败（缺 token/scope）；4/5 = 网络/内部失败。最后一行 stderr：`[event] exited — received N event(s) in Xs (reason: ...)`。
4. **永远不要 `kill -9`** 那些 PreConsume 会注册/注销服务端订阅的键（minutes/vc/board）——会泄漏服务端订阅（症状：重启报 "subscription already exists"、重复投递）。SIGTERM 或关 stdin 才是正确停法。
5. **一个进程只消费一个 EventKey**：多 key = 多子进程（故意设计：每进程一种输出形状、故障隔离、每 key 独立 `--as`/`--jq`/界值；共享一个 bus daemon，开销小）。
6. 写 `--jq` 前先看 `event schema <key> --json` 的 `jq_root_path`（V1 事件在顶层，V2 在 `.event` 下）。

### IM 事件输出（扁平化，AI 友好）

`im.message.receive_v1` 消费后输出 NDJSON，字段含：`type`、`event_id`（**勿用于去重**）、`message_id`（`om_`，推荐幂等键）、`chat_id`（`oc_`）、`chat_type`（p2p/group）、`message_type`、`sender_id`（`ou_`）、`sender_type`、`content`（多数类型已预渲染为人类可读文本）、`mentions[]`（@提及）、`root_id`/`thread_id`/`reply_to`（回复/话题上下文）、`create_time`/`update_time`。interactive 卡片消息会转成紧凑文本，卡片回调另有 `card.action.trigger`（含 `token`、`action`、`card_content`）。

## 7. 安全设计（Agent 场景必读）

- **默认多级防护**：输入注入防护、终端输出清洗、OS 原生 keychain 存凭据。
- **风控信号**：向官方 HTTPS 域名请求时携带最小风控信号（OS 类型、硬件型号），帮助识别异常 API 活动；`lark-cli config risk-control off|on|default` 可关。
- **官方风险提示**：Agent 在被授权后会以用户身份在授权范围内行动，存在幻觉/越权/敏感数据泄露风险；建议 bot 只做**私人会话助手**，不要加群、不要让其他用户交互；不要主动放宽默认安全设置。
- **企业嵌入**（`extension/`）：不改 CLI 源码，写一个 Go wrapper main 即可替换凭据源（`credential/`：DB/Vault/配置中心）、拦截全部 HTTP（`transport/`：加头/改目标/审计）、限制命令面与洋葱中间件（`platform/`：允许/拒绝规则、审计钩子、审批门、限流）、内容安全（`contentsafety/`）、文件 IO（`fileio/`）。官方指南：[Embed lark-cli in your Agent](https://open.larksuite.com/document/mcp_open_tools/feishu-cli/embed-feishu-cli-in-agent)。
- **Sidecar 代理**（`sidecar/`）：CLI 跑在沙箱内、凭据留在受信环境——HTTP 代理协议 v1（HMAC-SHA256 签名 + 时间戳防重放 + 目标主机/身份/体摘要头，默认 `127.0.0.1:16384`），`sidecar/server-demo` 给了完整示例（allowlist/audit/forward）。适合 DSH 沙箱 + 集中凭据的部署。

## 8. 其他值得注意的点

- `affordance/`：每个域一份 Markdown，注入 `--help` 与 `schema` 输出（何时用/何时不用/前置条件/技巧/示例），Agent 查帮助即可获得用法指南。
- 发消息快捷方式支持 `--text`/`--markdown`/`--post`/`--file`/`--image`/`--audio`（仅 Opus）/`--msg-type interactive`（卡片须按 `references/card/lark-im-card-create.md` 工作流生成，不要手写）；`--reply`/`--thread-id` 支持回复与话题；幂等键 `--uuid`。
- 文档内容转发：用 `--doc-format im-markdown` 取文档再 `--markdown` 发出，保留 cite tag。
- 身份与 token 映射、发送者名字解析（读接口直接带 `sender_name`/`sender_i18n_names`，无需 contact scope）等细节见 `skills/lark-im/SKILL.md` 与 references。
