# 09 · dsh-lark-bridge：DSH 停顿飞书通知插件（实现设计）

> 本文是 dsh-lark-bridge 插件 V1 的实现设计文档：停顿检测模型、架构、配置 schema、模板变量、调试指南与 Phase 2 路线图。调研背景见 [01–08](./README.md)。

## 1. 目标与非目标

**目标**：DSH 会话因等待使用者交互而停顿时（权限申请、向用户提问、致命错误），实时（≤ 1s 级别）通过 lark-cli 发送飞书通知，提醒用户回到 DSH Web 处理。

**非目标（V1）**：飞书侧交互（在飞书里直接答复/审批）、lark→DSH 消息桥、飞书能力工具（doc 08 方案 A/B）、自动重试退避通知（retry）、无进展停滞扫描（stall）——均为 Phase 2，架构已预留接缝。

## 2. 停顿检测模型（全部对 DSH 源码核实）

插件唯一的数据源是 **`session/event` 持久事件流**（全局 Cordis 事件，`ctx.on('session/event', (session, event) => …)`）：

- 只广播 live append（seed/replay 不发）→ 天然实时、无回放噪音；
- 事件是权威持久事实（"模型可见即已记录"），观察它不改变任何行为；
- 全局监听（root ctx）看到所有会话。

| 停顿 | 开始信号 | 结束信号 | 通知数据来源 |
|---|---|---|---|
| 权限申请 | `approval/asked` `{id, toolName, callId?, reason?}` | `approval/decided`（同 `id`） | `packages/interaction/user-approval` |
| 向用户提问 | `tool/call` `name==='ask_user_question'`（`arguments` 为 `{"questions":[...]}` 原始 JSON） | `tool/result`（`message.content[0].toolCallId` 同 callId） | `tool-ask-user` + 核心会话词汇 |
| 错误致停 | `turn/end` `reason.kind==='error'`，`reason.error: LlmFailure {message, code, status?(100-599), …}` | —（终态） | 核心会话词汇 + `dsh-llm` |

**为什么不用 provider 拦截提问**：`ctx.userQuestions` 只允许一个 active provider（重复注册抛 `DUPLICATE_PROVIDER`），观察 `tool/call`/`tool/result` 是唯一干净且不影响 UI 的接缝；plan-mode 的 plan-review 也走 `ask_user_question` 工具，自动覆盖。

**错误路径事实**（回答"400-500 会不会停顿"）：
- 模型请求错误 → stream finish `{kind:'error'}` → `agent/request-error` waterfall → `dsh-llm-retry` 按 provider `retryPolicy` 决定退避重试（追加 `llm/retry`，含 `delayMs`/`retry`/`maxRetries`）；
- 不可重试/重试耗尽 → `LlmError` → `turn/end {kind:'error'}` + `agent/error` → agent idle 等用户 → 本插件 `error` 类别通知；
- 瞬时错误的重试退避是**自愈型停顿**：Phase 2 `retry` 类别（`llm/retry` 事件、attempt 阈值、重复提醒节流）。

### grace 窗口（去噪关键）

`approval/asked`/`tool/call` 到达后先挂 `graceMs`（默认 500ms）定时器；结束事件先到则取消发送。它过滤三类"秒答"噪音：ACP 机器决策、`never` 策略确定性拒绝、子代理提问的 `DELEGATED_CALLER` 即时失败。人类应答必然长于 grace，真实停顿不受影响。

## 3. 架构

```
src/
├── index.ts            # apply()：装配 settings + transport + engine + setup + 调试命令；export Config
├── config.ts           # Config 接口 + Schemastery schema + 默认模板（cordis.yml 部署层）
├── settings.ts         # `lark-notify` settings 命名空间：Web 设置面板可填、settings.yaml 持久化、
│                       #   解析优先级（用户设置 > YAML base > schema 默认）+ watch 热更新
├── engine.ts           # PauseEngine：全局 session/event 监听、grace 竞态、防抖、节流、
│                       #   标题缓存、失败包容、发送调度（唯一动 timer 的地方）
├── session-meta.ts     # 从 session/title 折叠每会话最新标题
├── render.ts           # {var} 模板渲染 + Options 空行省略 + 选项列表渲染
├── logger.ts           # PluginLogger 结构类型（cordis Logger 天然满足）
├── health.ts           # lark-cli 存在性/认证状态检查（auth status 信封解析 + 可执行提示）
├── setup.ts            # SetupController：引导式目标发现（状态机：listening/success/failed，可中止）
├── command.ts          # /lark-notify setup | test [text] | status（诊断输出含新手可执行提示）
├── transport/
│   ├── types.ts        # Notifier 接口 / NotificationMessage（含 per-message target 覆盖）
│   ├── lark-cli.ts     # LarkCliTransport：串行队列 + im +messages-send 子进程（target/dryRun 实时读取）
│   ├── event-consume.ts# captureOneMessage：event consume 子进程契约消费者（setup 用）
│   ├── envelope.ts     # {ok,data}/{ok:false,error} 信封解析（成功只看 ok/退出码；auth 无包装形态兼容）
│   └── spawn.ts        # runProcess：输出捕获(封顶)、超时、AbortSignal、进程组 SIGTERM
└── categories/
    ├── types.ts        # Category / CategoryEngine / SessionRef（类别接缝）
    ├── permission.ts   # approval/asked ↔ approval/decided
    ├── question.ts     # ask_user_question tool/call ↔ tool/result；宽容解析 questions
    └── error.ts        # turn/end reason.kind==='error'（立即通知 + 按会话节流）
```

**两条接缝**（后续扩展点）：
1. `Category`（categories/types.ts）：新停顿类型 = 新模块 + 在 engine 的列表登记。Phase 2 的 `retry`/`stall` 即此形态（stall 用 `ctx.setInterval` 扫描 + 上次活动跟踪）。
2. `Notifier`（transport/types.ts）：新传输 = 新实现。候选：node-sdk 直连（`@larksuiteoapi/node-sdk`）、sidecar 代理集中凭据（doc 06 §7）。

**数据流**：
```
session/event ─▶ PauseEngine（只观察）
  ├ session/title ─▶ 标题缓存
  ├ approval/asked ─▶ permission.beginPause(key=approval:<id>) ─ctx.timeout(graceMs)─▶ emit()
  │   approval/decided(同 id) ─▶ settlePause（取消）
  ├ tool/call(ask_user_question) ─▶ question.beginPause(key=question:<callId>) ─▶ …
  │   tool/result(同 toolCallId) ─▶ settlePause
  └ turn/end(reason=error) ─▶ error.notifyNow（无 grace；throttle 节流）
emit() ─▶ enabled? → debounce(会话×类别) → make()渲染(包容) → logger.info → notifier.send
LarkCliTransport ─▶ 串行队列 ─▶ spawn lark-cli（成功信封 ok=true 才算送达；失败告警计数）
```

**失败包容**：事件监听回调、类别 handle、渲染 make 全部 try/catch，异常只进 `ctx.logger`；`notifier.send` 自身绝不 reject。lark-cli 缺失（ENOENT）→ warn + 计数，插件继续运转。

**卸载/HMR**：`ctx.on`/`ctx.timeout`/`ctx.commands.register` 均为可逆注册，插件卸载自动回收；in-flight 子进程由 spawn 的超时/AbortSignal 保证收敛（进程组 SIGTERM，禁 kill -9）。

## 4. 配置（三层：settings 用户层 > cordis.yml 部署层 > 默认值）

面向公众发布后，通知目标的配置走 **DSH settings 命名空间** `lark-notify`（用户层）：
- 插件注册 `lark-notify` 命名空间（schema：`chatId`/`userId`/`dryRun`），DSH Web 设置面板自动渲染表单；写入持久化到 `$DSH_HOME/settings.yaml`；
- 解析顺序：schema 默认 → cordis.yml `config` 作为 `base`（部署默认值，CI/高级用户）→ 用户层（设置面板 / `/lark-notify setup` 写入）；
- `applies: 'live'`：watch 每次变更即时重解析，transport 逐次发送读取最新 target/dryRun —— 改设置无需重启；
- `/lark-notify setup` 是零 YAML 的首选路径：后台跑 `lark-cli event consume im.message.receive_v1 --max-events 1 --timeout <setupTimeoutMs>`，捕获用户给机器人发的第一条消息 → 提取 `chat_id`（与 `sender_id` open_id）→ `scope.update()` 写回设置 → 向捕获到的会话发送测试通知。前置检查：lark-cli 存在 + bot 身份 ready（`auth status` 信封）；失败提示覆盖「未开通事件订阅 / 缺 p2p 读取 scope」等新手坑。

### cordis.yml Config（部署层，Schemastery）

```ts
interface Config {
  target: { chatId: string; userId: string }     // 二选一；空 = fail-soft 不发送（默认空）
  webUrl: string                                 // 默认 'http://127.0.0.1:3080'
  identity: 'bot' | 'user'                       // 默认 'bot'（--as）
  bin: string                                    // 默认 'lark-cli'
  timeoutMs: number                              // 默认 30000（单次发送硬超时）
  graceMs: number                                // 默认 500（begin/settle 竞态窗口）
  debounceMs: number                             // 默认 3000（每会话×类别防抖）
  dryRun: boolean                                // 默认 false（只打日志不真发）
  setupTimeoutMs: number                         // 默认 180000（setup 监听窗口）
  categories: {
    permission: { enabled: boolean; template: string }        // 默认开
    question:   { enabled: boolean; template: string;
                  templateMultiple: string; itemTemplate: string }  // 默认开
    error:      { enabled: boolean; template: string; throttleMs: number } // 默认开，节流 300000
  }
}
```

Schemastery 对嵌套对象自动补字段默认值并响亮拒绝非法值（如 `identity: 'guest'` 加载即失败）。默认模板见 `src/config.ts` 导出的 `DEFAULT_*_TEMPLATE`。

### 模板变量

| 类别 | 变量 |
|---|---|
| 公共 | `{sessionId}` `{sessionTitle}`（未缓存时=会话 id） `{webUrl}` `{time}` |
| permission | `{tool}`（工具名） `{reason}`（申请原因，可为空） |
| question | `{header}` `{question}` `{options}`（`  · label — description` 缩进列表）；多问题框架模板另含 `{questions}`（逐项渲染结果），逐项模板含 `{number}` |
| error | `{errorLabel}`（`code` 或 `code (HTTP status)`） `{errorCode}` `{errorStatus}` `{errorMessage}` `{turn}` |

渲染规则：未知 `{var}` → 空；当 `{options}` 为空时，仅由 `Options: {options}` 构成的整行自动省略（对齐 opencode-lark-bridge 约定）；行尾空白裁剪、连续空行折叠。

## 5. 发送通道（lark-cli 子进程）

```
lark-cli im +messages-send --chat-id <oc_…> --as bot --text "<消息>" \
          --format json --idempotency-key dsh-<sha256 前 16 位>
```

- 成功判定：退出码 0 且 stdout 含 `{"ok":true,…}`（成功信封没有 `code` 字段，勿按 `code==0` 判，doc 06 §3）；失败解析 stderr `{"ok":false,"error":{type,subtype,code,message,hint}}` 并透出 hint。
- `--idempotency-key`（≤50 字符）防重复投递；环境变量关闭 update/skills 提示噪音。
- 凭据完全由 lark-cli 自理（keychain/自身配置），插件不接触 App Secret。
- 串行队列防限流互踩；`dryRun` 跳过 spawn。

## 6. 调试与验证清单

- [ ] `lark-cli auth status --json --verify`：bot ready；`lark-cli im +messages-send --dry-run` 验证命令形态
- [ ] `dsh --profile <name> --dump-config`：`dsh-lark-notify` 行存在、config 生效
- [ ] `/lark-notify status`：目标、lark-cli 认证、发送统计、setup 状态与可执行提示
- [ ] `/lark-notify setup` + 给机器人发消息 → 设置面板出现 chatId、飞书收到「配置成功」测试通知
- [ ] `/lark-notify test` 收到测试消息
- [ ] 权限申请（如让模型执行需 sandbox 升级的操作）→ 飞书 ~1s 内收到 `🔔 DSH 权限申请`
- [ ] 让模型调用 `ask_user_question` → 收到含问题与选项的 `❓` 通知；秒答（ACP/`never` 策略）无通知
- [ ] 制造致命模型错误（如临时改错模型名）→ 收到 `⚠️` 通知且含错误 code/HTTP status
- [ ] 移除 PATH 中的 lark-cli → DSH 正常、日志告警、无崩溃；插件热重载/退出无孤儿进程（setup 监听被 SIGTERM 中止）

## 7. Phase 2 路线图（架构已预留）

1. **retry 类别**：`llm/retry` 事件（delayMs/attempt/maxRetries）→ attempt 阈值 + 间隔节流的退避通知。
2. **stall 类别**：`ctx.setInterval` 扫描 + 每会话上次活动时间；超时（默认 10min）与重复提醒（默认 60min）窗口。
3. **飞书侧交互**：interactive card 按钮远程应答审批/提问——依赖双向桥（下述 4），`card.action.trigger` + `card/update`。
4. **消息桥（lark→DSH）**：`lark-cli event consume im.message.receive_v1` 子进程契约（就绪标记+NDJSON+退出码）→ `agent.followup` 路由 + 会话映射持久化（doc 08 方案 A）。
5. **能力工具（DSH→lark）**：vendor 官方 skills + 通用 `lark` 工具（doc 08 方案 B）。
6. **仓库演进**：以上功能落地时拆分为 pnpm monorepo——`src/transport/` → `packages/transport`，本插件 → `packages/dsh-lark-notify`，新增 `packages/dsh-lark-messaging`、`packages/dsh-lark-tools`、`skills/`（接口已按包边界隔离，拆分是纯移动）。
7. **传输替换**：`Notifier` 的 node-sdk 直连实现（类型完备、无外部二进制）与 sidecar 企业模式（集中凭据/审计）。

## 8. 安全与风险

| 风险 | 对策 |
|---|---|
| 通知内容注入（标题/问题文本被模型控制） | 文本是数据不是指令；飞书端仅展示；后续如需从飞书回话再做注入防护 |
| lark-cli 失败风暴 | 串行队列 + debounce/节流 + fail-soft 计数；status 可观测 |
| 重复通知 | grace 竞态 + debounce + `--idempotency-key` |
| CLI 升级破坏信封契约 | 按 `ok`/退出码判成功、信封解析容错（逐行扫描 JSON）；锁版本建议 |
| HMR 不监视仓库外文件 | dev 时以 `--patch` + 重启迭代；可选在 dev overlay 扩展 hmr root |
| 多会话并发 | engine 全部状态按 sessionId 键控 |
| 新手配置摩擦（公开发布重点） | setup 引导命令 + settings 面板 + status 可执行提示三层兜底；setup 监听窗口可中止、失败提示覆盖常见坑（事件订阅/p2p scope） |
