# 08 · Lark → DeepSeek Harness 插件集成方案

> 本文把 [01–04（DSH 插件开发）](./README.md) 与 [05–07（Lark 平台/CLI/SDK）](./README.md) 合流，给出把 Lark 能力接入 DSH 的候选方案、推荐组合与落地步骤。目标产物：`dsh-lark-bridge` 插件。

## 1. 目标场景

1. **消息桥（bridge）**：飞书用户给 bot 发消息 → DSH agent 处理 → 结果回复到同一会话（可能多轮、多会话并行）。
2. **飞书操作（capability）**：让 DSH agent 主动操作飞书——发消息、查日历、读写云文档/表格、查审批等（200+ 命令的能力面）。
3. 可选：卡片交互（审批按钮）、群聊白名单、企业集中凭据。

## 2. 接入方案对比与推荐

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. lark-cli 子进程桥** | DSH host 插件用子进程跑 `lark-cli`：`event consume` 收消息 + 命令执行发消息/操作 | 事件订阅子进程契约、输出契约、错误信封全为 Agent 设计；零 SDK 维护；功能面最大 | 依赖外部 Go 二进制；子进程管理 |
| **B. Skills vendor + lark 工具** | 把 `skills/*` 目录 vendor 进 DSH skill 根目录（格式兼容已核实，06 §5）；注册一个 `lark` 工具执行任意 lark-cli 命令 | 模型获得 26 个技能包 + 按需深度参考；工作量最小 | 纯操作能力，不含收消息 |
| **C. node-sdk 原生 TS** | `@larksuiteoapi/node-sdk` websocket 客户端 + 语义化 API 工具集 | 无外部二进制；类型完备；深度定制 | 自维护 token/重连/事件装配；工作量大 |
| **D. lark-mcp** | `@larksuiteoapi/lark-mcp` 作为 MCP 服务器（DSH：每服务器一个插件，`ctx.tools.register` 其 schema） | 最快验证 | Beta；user 身份 headless 麻烦 |
| **E. sidecar 企业模式** | CLI 跑沙箱内 + sidecar 代理集中凭据 + extension 定制二进制 | 集中凭据/审计/命令面限制 | 需要 Go 包装构建 |

**推荐路线：B + A 组合**（B 出能力面，A 出消息桥），C 作为深度集成路线，D 用于快速演示，E 留给企业部署。

- 为什么首选 lark-cli 而不是 node-sdk：CLI 的 skills、`--dry-run`、`schema` 内省、身份 `--as` 切换、`{ok,error}` 信封与 `event consume` 的"就绪标记 + NDJSON + 退出码"子进程契约，都是官方**为 AI Agent 子进程调用**设计的，DSH 工具层只需薄封装。
- 为什么收消息不用 webhook：webhook 需要公网 URL + 验签/解密；`event consume` 走 WebSocket 长连接，本机/内网即可跑。

## 3. 方案 B 落地：Skills vendor + lark 工具

### 3.1 安装 lark-cli 并 vendor skills

```sh
npx @larksuite/cli@latest install           # 装二进制（PATH 可及）
lark-cli config init && lark-cli auth login --recommend   # 一次性交互配置
# vendor 官方 skill 目录到 DSH 项目 skill 根（格式兼容已核实）
git clone --depth 1 https://github.com/larksuite/cli.git /tmp/larksuite-cli
mkdir -p .dsh/skills
cp -r /tmp/larksuite-cli/skills/lark-im .dsh/skills/
cp -r /tmp/larksuite-cli/skills/lark-event .dsh/skills/
cp -r /tmp/larksuite-cli/skills/lark-shared .dsh/skills/   # 认证共享规则，必须一起放
# 需要更多域就整目录复制（27 个 skill，含 calendar/docs/base/task/mail…）
```

DSH `skill-filesystem` provider 会扫描 `<projectRoot>/.dsh/skills` 并解析 `SKILL.md` frontmatter（要求 kebab-case `name` + `description`；lark skill 还带 `version`/`metadata`，属可选字段，被接受）；`tool-skill` 把目录暴露给模型，正文里的 `references/` 相对引用按需加载。lark-shared 里"必须先用 Read 读取 ../lark-shared/SKILL.md"的约定正好对应 DSH skill 加载器的目录语义。

### 3.2 `lark` 命令工具（通用能力出口）

一个薄封装工具，把任意 lark-cli 命令变成模型可调用的能力（执行经 `ctx.subprocess` 或 `node:child_process`，把 JSON 结果作为规范值返回）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'

export const name = 'tool-lark'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'lark',
    description: 'Run a lark-cli command (Feishu/Lark operations) and return its JSON result. '
      + 'Examples: ["im","+messages-send","--chat-id","oc_xxx","--text","hi"], '
      + '["calendar","+agenda"], ["schema","im.messages.send"]. '
      + 'Use lark-cli schema <resource> before calling raw APIs. Prefer skills (lark-*) for workflows.',
    parameters: {
      args: { type: 'array', items: { type: 'string' }, required: true,
              description: 'lark-cli argv without the binary name' },
      as: { type: 'string', enum: ['bot', 'user'] },
      dry_run: { type: 'boolean' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const argv = ['lark-cli', '--format', 'json']
        .concat(args.as ? ['--as', args.as] : [])
        .concat(args.dry_run ? ['--dry-run'] : [])
        .concat(args.args)
      const out = await runSubprocess(argv, exec.signal)   // stdout/stderr 捕获
      return JSON.stringify(out)                           // 含 ok/data/error 信封
    },
  }))
}
```

要点：

- **成功/失败都返回**（`ok:false` 信封是重要信息），让模型读懂错误 `hint` 并自纠；也可抛错走 DSH 工具 `isError` 路径。
- 响应 `exec.signal` 取消；长命令（导出表格等）考虑 `run_in_background` + `ctx.jobs`。
- 可选细化：为高频操作单独注册工具（`lark_send_message`、`lark_search_messages`…）以获得更好的 schema 与卡片；通用 `lark` 工具兜底长尾。

## 4. 方案 A 落地：消息桥插件（收 → 处理 → 回）

### 4.1 收消息：`event consume` 子进程

DSH host 插件在 `apply` 中启动 `lark-cli event consume`，按 06 §6 的子进程契约工作：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

export const name = 'lark-bridge'
export const inject = ['agents', 'sessions']   // 以各子系统 cordis-surface 为准

export function apply(ctx: Context) {
  ctx.effect(() => {                            // 卸载时自动 SIGTERM 子进程
    const child = spawn('lark-cli',
      ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], { stdio: ['pipe','pipe','pipe'] })
    const abort = new AbortController()

    // 1) 阻塞等 stderr 就绪标记（契约，勿 sleep）
    const rlErr = readline.createInterface({ input: child.stderr })
    rlErr.on('line', (line) => {
      if (line.startsWith('[event] ready')) startReading()   // 2) 之后才开始读 stdout
      console.error('[lark-bridge]', line)
    })

    function startReading() {
      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => handle(JSON.parse(line)))
    }

    async function handle(ev: LarkMessageEvent) {
      if (ev.sender_type === 'bot') return            // 防自循环
      if (!isAllowedChat(ev.chat_id, ev.chat_type)) return   // 白名单/群聊策略
      if (!dedupe(ev.message_id)) return              // message_id 幂等，勿用 event_id
      // 3) 路由到会话并唤醒 agent：chat_id → SessionId（映射持久化）
      const sessionId = await sessionForChat(ev.chat_id)
      const agent = ctx.agents.get(sessionId)
      await agent?.followup(createUserMessage({
        content: [{ type: 'text', text: ev.content }],
        source: { kind: 'lark', chatId: ev.chat_id, messageId: ev.message_id },  // 自定义 source 需扩展类型
      }))
    }

    child.on('exit', (code) => { /* reason 已在 stderr；按契约区分重试/退出 */ })
    return () => { child.kill('SIGTERM'); abort.abort() }   // 禁 kill -9（06 §6）
  })
}
```

对应 lark 侧准备：开发者后台开启事件订阅（`im.message.receive_v1`）与回调配置；bot scope 开通 `im:message:readonly`（p2p 需 `im:message.p2p_msg:readonly`）；`auth login`/`auth status --verify` 通过。

### 4.2 回复：发送工具 + 会话绑定

- **每 chat 一个 DSH 会话**：`chat_id ↔ SessionId` 映射持久化（`ctx.storage`/`storageDomain`），多会话并行天然成立；DSH 会话自带轮次/历史，模型能看到上下文。
- **回复工具**：`lark_reply`（`im +messages-reply` / `+messages-send --as bot`）。让模型拿到 `chat_id` 的两种方式：
  1. 简单：把 `chat_id` 写进 `followup` 的用户消息前缀（"在飞书会话 oc_xxx 中回复…"）；或
  2. 规范：工具默认回复"当前会话绑定的 chat_id"（插件持有 `session→chat` 映射，`exec.agent` 可查到当前 agent/session），模型无需自己传 id。
- **流式体验**（可选）：监听 `session/event` 的 `assistant/chunk` 增量更新飞书消息（发一条占位消息再反复 edit），或仅"完成一回合发一条"（推荐先做后者）。

### 4.3 配置 schema（示例）

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  eventKeys: string[]          // 默认 ['im.message.receive_v1']
  identity: 'bot' | 'user'     // --as
  allowedChatIds: string[]     // 白名单；空 = 所有 p2p
  allowGroups: boolean         // 默认 false（官方安全建议：bot 不进群）
  replyByDefault: boolean
}
export const Config: Schema<Config> = Schema.object({
  eventKeys: Schema.array(Schema.string()).default(['im.message.receive_v1']),
  identity: Schema.union(['bot', 'user']).default('bot'),
  allowedChatIds: Schema.array(Schema.string()).default([]),
  allowGroups: Schema.boolean().default(false),
  replyByDefault: Schema.boolean().default(true),
})
```

## 5. 凭据、沙箱与安全

- **凭据**：lark-cli 用 keychain/登录流管理；headless/服务器部署改用 `extension/credential`（自建二进制）或环境变量注入；DSH 侧可用 `ctx.credentials` 存 App Secret，通过 `!!js` 表达式注入 config（见 DSH 02 §6/03 ⑥）。企业场景走 sidecar（06 §7）：CLI 在 DSH 沙箱内运行，token 由受信代理注入。
- **沙箱**：`workspace-write` 预设下网络不受限、进程可见性不受限——lark-cli 子进程可正常跑；若用远程/e2b provider，`ctx.subprocess` 会自动重定向。
- **审批**：如需"外发消息需人工确认"，给发送工具挂 `tools/pre-execute` 策略或 `ctx.approval`（DSH 02 §9 权限门禁范式）。
- **注入与滥用防护**（对齐官方警告，06 §7）：
  - 默认只接受 p2p（白名单 chat_id）；`allowGroups: true` 才处理群消息，且仅响应 `mentions` 中包含 bot 的消息；
  - 过滤 `sender_type === 'bot'` 防自循环；`message_id` 幂等去重；
  - 模型输出经发送工具发出，注意把"飞书消息内容"与"系统指令"边界写清（消息文本是数据不是指令）；
  - 不放松 CLI 默认安全设置（注入防护/输出清洗/风控信号）。

## 6. 打包与分发（对齐 DSH 03 §⑤–⑦）

```
dsh-lark-bridge/
├── package.json          # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml      # 插入 lark-bridge / tool-lark 行 + skill 目录配置行
├── index.js             # 插件入口（bridge + tools）
└── skills/lark-*/       # vendored 官方 skills（随包分发）
```

```yaml
# cordis.patch.yml（示意）
- insert:
    - id: lark-bridge
      name: 'dsh-lark-bridge'
      config:
        identity: bot
        allowedChatIds: []
        allowGroups: false
    - id: lark-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        customSkillDirs: ['{{packageRoot}}/skills']   # 指向包内 vendor 目录（路径机制以实际解析为准）
```

```sh
dsh plugin --profile demo add ./dsh-lark-bridge
dsh --profile demo --dump-config     # 验证层生效
dsh web --patch ...                  # 或并入 profile 启动
```

## 7. 开发路线图

1. **PoC（半天）**：手动 `lark-cli config init` + `auth login --recommend`；`event consume im.message.receive_v1 --max-events 1 --timeout 30s` 发条消息验证链路；`im +messages-send --dry-run` 验证发送。
2. **B 方案（能力面）**：vendor skills + `lark` 工具 → DSH 里让模型"给 xx 发条消息 / 看明天日程"。
3. **A 方案（消息桥）**：bridge 插件（就绪标记等待、NDJSON 解析、白名单、去重、followup 路由）→ 回复工具 → 多轮对话打通。
4. **加固**：配置 schema 完善、错误信封透传（`missing_scope` 提示用户）、断线重连（`exit code + reason` 分支重试）、会话映射持久化、`ctx.jobs` 托管长任务。
5. **可选进阶**：卡片交互（`card.action.trigger` + `card/update`）、群聊 @bot 模式、C 方案 native SDK 替换、E 方案 sidecar、消息编辑式流式回复。

## 8. 验证清单

- [ ] `lark-cli auth status --json --verify`：`verified:true`、scope 含 `im:message:readonly`（+p2p scope）
- [ ] 开发者后台：事件订阅开启 `im.message.receive_v1`；回调配置开启（卡片回调才需要）
- [ ] `event consume` 冒烟：ready 标记出现、消息 NDJSON 结构正确、退出码/reason 符合契约
- [ ] DSH 侧：插件 `inject` 服务就绪（无 PENDING 静默，02 §7 诊断）；`--dump-config` 层序正确
- [ ] 单聊往返、幂等（重复投递不重复回复）、bot 消息不触发、非白名单会话被忽略
- [ ] 卸载/热重载：子进程 SIGTERM 优雅退出（无孤儿进程/无订阅泄漏）

## 9. 风险与对策速查

| 风险 | 对策 |
|---|---|
| Prompt injection（消息内容诱导模型越权） | 消息是数据不是指令；白名单会话；敏感操作走审批 |
| token 泄露/被盗 | keychain/sidecar 集中凭据；不打印 token；风控信号默认开启 |
| 事件重复/丢事件 | `message_id` 幂等；`--quiet` 不用（保留完整性信号）；bus daemon 状态监控 |
| 断线 | 按退出码/reason 分支重试；指数退避；`event status` 检查 |
| 限流（发消息频率） | 排队/降速；`--page-delay`；错误信封里识别限流 code |
| bot 自循环 | 过滤 `sender_type === 'bot'`；回复工具不再触发接收事件 |
| CLI 升级破坏契约 | 锁定版本（`@larksuite/cli@<version>`）；输出契约/子进程契约变更看 CHANGELOG |
| 群聊滥用 | 默认禁群；@bot 才响应；官方建议 bot 只做私人助手 |
