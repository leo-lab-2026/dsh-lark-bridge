# 09 · dsh-lark-bridge：DSH 停顿飞书通知插件（实现设计）

> 本文是 dsh-lark-bridge 插件 V1 的实现设计文档：停顿检测模型、架构、配置 schema、模板变量、调试指南与路线图（Phase 2A ✅ / 2B / 2C）。调研背景见 [01–08](./README.md)。

## 1. 目标与非目标

**目标**：DSH 会话因等待使用者交互而停顿时（权限申请、向用户提问、致命错误），实时（≤ 1s 级别）通过 lark-cli 发送飞书通知，提醒用户回到 DSH Web 处理。Phase 2A 已把覆盖扩展到全部停机原因（complete/stop 族/retry/stall/goodbye/watchdog，见 §7.1），形成「DSH 停止工作 = 必收到通知」的完整覆盖。

**非目标**：飞书侧交互（在飞书里直接答复/审批）、lark→DSH 消息桥、飞书能力工具（doc 08 方案 A/B）——均为 Phase 2B；node-sdk/sidecar 传输与 monorepo 拆分——Phase 2C。设计定位说明：V1 只通知「需要用户回来操作」的停顿；「任务顺利完成」也是 DSH 停止工作的形态（用户同样需要及时知道），由 Phase 2A 的 `complete` 类别补齐。

## 2. 停顿检测模型（全部对 DSH 源码核实）

两个只读数据源（全部对 DSH 源码核实）：
1. **`session/event` 持久事件流**（全局 Cordis 事件，`ctx.on('session/event', (session, event) => …)`）——V1 的唯一数据源，也是 retry/stall/stop 归因细节的来源；
2. **`agent/status`**（Phase 2A 停机检测的第二数据源：`ctx.on('agent/status', ({ agent, status }) => …)`，scope 分发对 root 监听者全局可见）——complete/stop 族的 idle 检测模型与 stall 的 running 判定。

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
- 瞬时错误的重试退避是**自愈型停顿**：由 Phase 2A `retry` 类别通知（`llm/retry` 事件、attempt 阈值、重复提醒节流，§7.1）。

### grace 窗口（去噪关键）

`approval/asked`/`tool/call` 到达后先挂 `graceMs`（默认 500ms）定时器；结束事件先到则取消发送。它过滤三类"秒答"噪音：ACP 机器决策、`never` 策略确定性拒绝、子代理提问的 `DELEGATED_CALLER` 即时失败。人类应答必然长于 grace，真实停顿不受影响。

## 3. 架构

```
src/
├── index.ts            # apply()：装配 settings + transport + engine + setup + 调试命令
│                       #   + goodbye 告别通知（dispose 钩子）+ watchdog 心跳；export Config
├── config.ts           # Config 接口 + Schemastery schema + 默认模板（cordis.yml 部署层）
├── settings.ts         # `lark-notify` settings 命名空间：Web 设置面板可填、settings.yaml 持久化、
│                       #   解析优先级（用户设置 > YAML base > schema 默认）+ watch 热更新
├── engine.ts           # PauseEngine：session/event + agent/status 双监听、idle 宽限竞态、
│                       #   grace 竞态、防抖、节流、周期性 tick（stall 扫描）、
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
├── categories/
│   ├── types.ts        # Category / CategoryEngine / SessionRef / TurnEndSummary（类别接缝，
│   │                   #   Phase 2A 扩展：handle?/agentStatus?/onIdleSettle?/tick?）
│   ├── permission.ts   # approval/asked ↔ approval/decided
│   ├── question.ts     # ask_user_question tool/call ↔ tool/result；宽容解析 questions
│   ├── error.ts        # turn/end reason.kind==='error'（立即通知 + 按会话节流）
│   ├── complete.ts     # idle 宽限结算 + turn/end completed 归因（每会话 30min 节流）
│   ├── stop.ts         # stop:blocked / stop:max-tokens / stop:aborted / stop:interrupted
│   │                   #   （blocked 归因最近 update_goal 的 blocked_reason；aborted 抑制 user/parent）
│   ├── retry.ts        # llm/retry 达到 retryThreshold 起通知（intervalMs 间隔节流）
│   └── stall.ts        # 每会话上次活动 + running 状态；tick 扫描 stallMs/repeatMs
└── scripts/
    └── lark-watchdog.mjs # 进程外监督者：心跳文件超时 → lark-cli 直发「DSH 进程死亡」通知
```

**两条接缝**（后续扩展点）：
1. `Category`（categories/types.ts）：新停顿类型 = 新模块 + 在 engine 的列表登记。Phase 2A 的 `retry`/`stall`/`complete`/`stop` 即此形态——接缝在 2A 中扩展了三个**可选**回调而不改 V1 契约：`agentStatus`（第二数据源）、`onIdleSettle`（idle 宽限结算）、`tick`（周期扫描）；`handle` 亦变为可选。
2. `Notifier`（transport/types.ts）：新传输 = 新实现。候选：node-sdk 直连（`@larksuiteoapi/node-sdk`）、sidecar 代理集中凭据（doc 06 §7）。

**数据流**：
```
session/event ─▶ PauseEngine（只观察）
  ├ session/title ─▶ 标题缓存
  ├ approval/asked ─▶ permission.beginPause(key=approval:<id>) ─ctx.timeout(graceMs)─▶ emit()
  │   approval/decided(同 id) ─▶ settlePause（取消）
  ├ tool/call(ask_user_question) ─▶ question.beginPause(key=question:<callId>) ─▶ …
  │   tool/result(同 toolCallId) ─▶ settlePause
  ├ turn/end ─▶ 记入 lastTurnEnd（idle 归因事实）；reason=error ─▶ error.notifyNow（无 grace；throttle 节流）
  ├ tool/call(update_goal action=blocked) ─▶ stop 族 blocked 归因缓存
  └ llm/retry ─▶ retry.handle（retry≥阈值 ─▶ notifyNow，interval 节流）
agent/status ─▶ PauseEngine（只观察）
  ├ running ─▶ 取消该会话 idle 宽限计时器（goal 自动续轮/loop followup 去噪）
  └ idle ─▶ 挂 idle 宽限计时器（默认 5s）── 超时仍 idle ─▶ settleIdle(lastTurnEnd) ─▶
            complete/stop 族各自归因 ─▶ notifyNow（per-session 节流）
ctx.interval(tick) ─▶ stall.tick：running 且 stallMs 无事件 ─▶ notify（repeatMs 重复提醒）
dispose（根 fiber 卸载） ─▶ goodbye「DSH 已正常退出」；watchdog 心跳文件供进程外监督者
emit() ─▶ enabled? → debounce(会话×类别) → make()渲染(包容) → logger.info → notifier.send
LarkCliTransport ─▶ 串行队列 ─▶ spawn lark-cli（成功信封 ok=true 才算送达；失败告警计数）
```

**失败包容**：事件监听回调、类别 handle、渲染 make 全部 try/catch，异常只进 `ctx.logger`；`notifier.send` 自身绝不 reject。lark-cli 缺失（ENOENT）→ warn + 计数，插件继续运转。

**卸载/HMR**：`ctx.on`/`ctx.timeout`/`ctx.commands.register` 均为可逆注册，插件卸载自动回收；in-flight 子进程由 spawn 的超时/AbortSignal 保证收敛（进程组 SIGTERM，禁 kill -9）。

## 4. 配置（三层：settings 用户层 > cordis.yml 部署层 > 默认值）

面向公众发布后，通知目标的配置走 **DSH settings 命名空间** `lark-notify`（用户层）。**默认契约：插件安装后通知目标为空**——chat_id/open_id 属于用户个人数据，不随插件携带、也不应硬编码进部署配置；首次使用由 `/lark-notify setup` 或设置面板指定一次，写入 `settings.yaml` 持久生效，cordis.yml 的 `config.target` 仅作 CI/批量部署的可选默认值。
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
  goodbye: { enabled: boolean; template: string }  // 默认开；dispose 告别通知（仅整树卸载，HMR 不误报）
  watchdog: { enabled: boolean; heartbeatFile: string; intervalMs: number }
                                                 // 默认关；心跳文件供 scripts/lark-watchdog.mjs
  categories: {
    permission: { enabled: boolean; template: string }        // 默认开
    question:   { enabled: boolean; template: string;
                  templateMultiple: string; itemTemplate: string }  // 默认开
    error:      { enabled: boolean; template: string; throttleMs: number } // 默认开，节流 300000
    complete:   { enabled: boolean; template: string;
                  idleGraceMs: number; throttleMs: number }    // 默认开，宽限 5000，节流 1800000
    'stop:blocked':      { enabled: boolean; template: string; throttleMs: number } // 默认开，节流 300000
    'stop:max-tokens':   { enabled: boolean; template: string; throttleMs: number } // 同上
    'stop:aborted':      { enabled: boolean; template: string; throttleMs: number } // 同上（user/parent 抑制）
    'stop:interrupted':  { enabled: boolean; template: string; throttleMs: number } // 同上
    retry:      { enabled: boolean; template: string;
                  retryThreshold: number; intervalMs: number } // 默认开，阈值 2，间隔 300000
    stall:      { enabled: boolean; template: string;
                  stallMs: number; repeatMs: number }          // 默认开，停滞 600000，重复 3600000
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
| complete | `{turn}` |
| stop:blocked | `{turn}` `{reason}`（最近 `update_goal` 的 `blocked_reason`；缺失时回退为通用文本） |
| stop:max-tokens | `{turn}` |
| stop:aborted | `{turn}` `{cancelCause}`（`hook (原因)` / `disposed` / `legacy`；`user`/`parent` 不发） |
| stop:interrupted | `{turn}` |
| retry | `{retry}`（第几次） `{maxRetries}`（`always` 模式为空） `{maxRetriesLabel}`（`/4` 或空） `{delaySec}` `{provider}` `{mode}` `{errorLabel}` `{errorCode}` `{errorStatus}` `{errorMessage}` `{turn}` |
| stall | `{stalledMin}`（停滞整分钟数） |
| goodbye | `{time}` |

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
- [ ] `/lark-notify status`：目标、lark-cli 认证、发送统计、启用的通知类别、setup 状态与可执行提示
- [ ] `/lark-notify setup` + 给机器人发消息 → 设置面板出现 chatId、飞书收到「配置成功」测试通知
- [ ] `/lark-notify test` 收到测试消息
- [ ] 权限申请（如让模型执行需 sandbox 升级的操作）→ 飞书 ~1s 内收到 `🔔 DSH 权限申请`
- [ ] 让模型调用 `ask_user_question` → 收到含问题与选项的 `❓` 通知；秒答（ACP/`never` 策略）无通知
- [ ] 制造致命模型错误（如临时改错模型名）→ 收到 `⚠️` 通知且含错误 code/HTTP status
- [ ] 完成任务后保持 idle → ~5s 内收到 `✅ DSH 任务完成`；goal 自动续轮（idle→running）不误报
- [ ] goal 阻塞（`update_goal action:blocked`）→ 收到 `🚫 DSH 目标阻塞` 且含 `blocked_reason`
- [ ] 输出触顶（小 `maxTokens`）→ 收到 `✂️` 通知；用户中止不通知（`stop:aborted` user/parent 抑制）
- [ ] 连续制造模型 5xx → 第 2 次重试起收到 `🔁` 退避通知（含重试次数/退避秒数）
- [ ] 让模型执行一个长时间无输出的工具调用 → `stallMs` 后收到 `⏳` 停滞通知
- [ ] 开启 watchdog + `scripts/lark-watchdog.mjs --once`：DSH 运行时不发，`kill -9` DSH 后心跳超时收到 `💀 DSH 进程死亡`
- [ ] 正常退出 DSH → 收到 `👋 DSH 已正常退出`；插件 HMR/重载不误报
- [ ] 移除 PATH 中的 lark-cli → DSH 正常、日志告警、无崩溃；插件热重载/退出无孤儿进程（setup 监听被 SIGTERM 中止）

## 7. 路线图（Phase 2A ✅ / 2B / 2C，架构已预留）

原「Phase 2」按交付面拆为三个阶段：**Phase 2A（优先开发）单向通知补齐**、**Phase 2B 双向交互**（飞书 ↔ DSH 对话/审批/操作闭环）、**Phase 2C 基础设施与仓库演进**（殿后）。拆分依据：2A 只涉及「DSH → 飞书」单向通知、不依赖 2B/2C 即可交付；2B 依赖 2A 的通知传输与配置面（sidecar 可选）；2C 是传输实现替换与工程化演进，功能增量最小、改动风险最高，故放最后。

### 7.1 Phase 2A：单向通知补齐（✅ 已实现）

**目标**：让「DSH 停止工作 = 必收到飞书通知」完整成立，覆盖下方矩阵的全部停机原因；全部经现有 `Category` 接缝实现（接缝扩展三个可选回调：`agentStatus?`/`onIdleSettle?`/`tick?`，`handle` 变可选；V1 契约不变）。

**统一检测模型**：DSH「停止工作」的权威信号是 **`agent/status` → `idle`**（`dsh-agent` 事件：`idle` 表示"无 driver 仍被调度或活动"，`running` 为其对偶）；`turn/end` 的 `reason` 只负责归因。注意：`turn/end` 后若 `inbox.nextStep` 仍有输入，loop 会**自动开下一轮**（goal 自动续轮、`/loop` 的 `followup`），因此不能只看 `turn/end`——在 `agent/status` 变为 `idle` 时挂 **idle 宽限窗口**（默认 5s，沿用现有 grace 竞态机制），窗口内回到 `running` 则取消，仍 `idle` 才按该会话最后一次 `turn/end.reason` 归因发送。`TurnEndReasonMap` 全覆盖矩阵（信号与发射方均对 `dsh-session`/`dsh-agent-loop` 源码核实）：

| 停止原因 | 信号 | 通知类别 | 实现状态 |
|---|---|---|---|
| 致命错误 | `turn/end {kind:'error'}`（不可重试/重试耗尽） | `error` | V1 已实现 |
| 任务完成 | `turn/end {kind:'completed'}` + idle 超宽限 | `complete`（下述 1） | ✅ 宽限窗口过滤自动续轮 |
| 目标阻塞 | `turn/end {kind:'blocked'}`（`dsh-agent-loop` 预步骤拒绝 / goal 阻塞，`GoalPhase='blocked'`） | `stop:blocked`（下述 2） | ✅ detail 取最近 `update_goal` 的 `blocked_reason` |
| 输出令牌上限 | `turn/end {kind:'max-tokens'}`（步骤触顶被截断） | `stop:max-tokens`（下述 2） | ✅ |
| 被取消 | `turn/end {kind:'aborted'}` + `TurnEndCancelCause` | `stop:aborted`（下述 2） | ✅ `user`/`parent` 抑制；`hook`/`disposed`/`legacy` 通知 |
| 崩溃孤儿轮 | `turn/end {kind:'interrupted'}`（持久化后端重载修复闭合） | `stop:interrupted`（下述 2） | ✅ 类别已实现；该事件在会话加载（seed）期生成、不进 live 广播，进程内未必可见——异常死亡的实际兜底是下述 5 的看门狗 |
| 重试退避 | `llm/retry`（自愈型停顿） | `retry`（下述 3） | ✅ |
| 无进展停滞 | 无事件 → 定时扫描上次活动 | `stall`（下述 4） | ✅ |
| 进程死亡（OOM/崩溃/断电/误杀） | 进程内无事件可发 | `watchdog`（下述 5） | ✅ 心跳文件 + `scripts/lark-watchdog.mjs` 进程外监督者 |

> 补充：goal `paused`（`GoalPhase='paused'`）在 `TurnEndReasonMap` 中**没有独立 kind**，其当前轮以既有 kind（`completed`/`aborted`）收尾，通知由相应类别承载，无需单独规划。

1. **complete 类别（任务完成通知）**：目标场景——任务完成后 DSH 停止工作，用户需要及时知道（不等轮询）。触发：`agent/status` → `idle` 且该会话最近 `turn/end` 为 `{kind:'completed'}`，idle 宽限窗口（默认 5s，过滤 goal 自动续轮/`/loop`）超时后发送。节流：每会话默认 30min（连续自动任务只提醒关键节点，不逐轮刷屏）。模板变量：公共 + `{turn}`。默认开启。配置：`categories.complete {enabled, template, idleGraceMs, throttleMs}`（`idleGraceMs` 是 complete/stop 族共用的 idle 宽限单一旋钮）。
2. **stop 类别族（停机原因全覆盖）**：与 complete 共用 idle 检测模型，按 `turn/end.reason` 归因，逐 kind 独立开关与模板：
   - `stop:blocked`：goal 阻塞（目标轮连续 N 轮同因阻塞）或预步骤拒绝。通知「目标阻塞」；detail 解析最近一次 `tool/call name==='update_goal'`（`action:'blocked'`）的 `blocked_reason`（arguments 原始 JSON，宽容解析）；无 detail 时回退为通用文本。
   - `stop:max-tokens`：输出令牌上限截断。通知含 `{turn}`，提示用户续写或调整上限。
   - `stop:aborted`：`reason.kind==='user'/'parent'` 抑制（用户本人在场，属噪音）；`hook`（含 `reason`）/`disposed`/`legacy` 通知「轮次被外部中止」。
   - `stop:interrupted`：崩溃孤儿轮在重载修复时闭合。该事件在会话加载（seed）期生成、不进入 live 广播，插件随进程重启后未必能看到；类别仍实现（若事件以 live 形态到达即可通知），异常死亡场景由下述 5 的看门狗兜底。
   - 配置：`categories['stop:<kind>'] {enabled, template, throttleMs}`（节流默认 300000，引擎按类别命名空间隔离节流键）。
3. **retry 类别**：`llm/retry` 事件（delayMs/retry/maxRetries/mode/failure，live 广播）达到 `retryThreshold`（默认 2）起通知，`intervalMs`（默认 300000）间隔节流。`mode:'always'` 时 `{maxRetries}` 为空、默认模板用 `{maxRetriesLabel}` 适配。配置：`categories.retry {enabled, template, retryThreshold, intervalMs}`。
4. **stall 类别**：引擎 `ctx.interval` 周期扫描（间隔 = min(stallMs/4, 60s)）+ 每会话上次活动时间与 `running` 状态；`stallMs`（默认 10min）判定、`repeatMs`（默认 60min）重复提醒。任何 session/event 或重新进入 running 都会重置停滞时钟；idle 会话不扫。配置：`categories.stall {enabled, template, stallMs, repeatMs}`。
5. **进程死亡看门狗（进程内观察者盲区）**：插件随 DSH 进程死亡后无事件可发，OOM/崩溃/断电/误杀属于进程内无法自通知的场景。已落地：a) 正常退出——`dispose` 钩子发「DSH 正常退出」告别通知，仅当**根 fiber** 卸载（`ctx.root.fiber.state !== ACTIVE`）时发送，插件级 HMR/重载不误报；b) 异常死亡——插件按 `watchdog.intervalMs` 更新心跳文件（`watchdog.heartbeatFile`，默认关），进程外监督者 `scripts/lark-watchdog.mjs`（常驻循环或 `--once` + cron/systemd timer）检测心跳超时后经 lark-cli 直发「DSH 进程死亡」通知（`--repeat-ms` 去重、`--once` 退出码 0/2/3）。sidecar 形态仍与 Phase 2C 第 1 项共建。

**实现备注**：idle 宽限结算、节流、tick 均由引擎统一承载；`notifyNow` 的节流键按 `类别:会话` 命名空间隔离（避免 complete/stop/error/retry 互相压掉）；stall/stop 状态经工厂创建（`createStallCategory()`/`createStopCategories()`），插件重载不残留旧会话状态；complete/stop 族按会话 `header.origin === 'subagent'`（或 `agent.session` 同源）跳过子代理子会话——子代理完成任务是常规运转，不代表「DSH 停止工作」。

### 7.2 Phase 2B：飞书 ↔ DSH 双向交互

**目标**：从「通知」走向「交互闭环」——飞书里应答审批/提问、飞书消息驱动 DSH、模型主动操作飞书。依赖 7.1 的通知传输与配置面。

1. **消息桥（lark→DSH）**：`lark-cli event consume im.message.receive_v1` 子进程契约（就绪标记+NDJSON+退出码）→ `agent.followup` 路由 + 会话映射持久化（doc 08 方案 A）。
2. **飞书侧交互（卡片应答）**：interactive card 按钮远程应答审批/提问——依赖消息桥（前述 1），`card.action.trigger` + `card/update`。
3. **能力工具（DSH→lark）**：vendor 官方 skills + 通用 `lark` 工具（doc 08 方案 B）。相对独立，可与 1/2 并行推进。

### 7.3 Phase 2C（最后批次）：基础设施与仓库演进

1. **传输替换**：`Notifier` 的 node-sdk 直连实现（类型完备、无外部二进制）与 sidecar 企业模式（集中凭据/审计；亦为 7.1 看门狗与企业部署的共建件）。
2. **仓库演进（monorepo 拆分）**：2B 功能落地时拆分为 pnpm monorepo——`src/transport/` → `packages/transport`，本插件 → `packages/dsh-lark-notify`，新增 `packages/dsh-lark-messaging`、`packages/dsh-lark-tools`、`skills/`（接口已按包边界隔离，拆分是纯移动）。

## 8. 安全与风险

| 风险 | 对策 |
|---|---|
| 通知内容注入（标题/问题文本被模型控制） | 文本是数据不是指令；飞书端仅展示；后续如需从飞书回话再做注入防护 |
| lark-cli 失败风暴 | 串行队列 + debounce/节流 + fail-soft 计数；status 可观测 |
| 重复通知 | grace 竞态 + debounce + `--idempotency-key` |
| CLI 升级破坏信封契约 | 按 `ok`/退出码判成功、信封解析容错（逐行扫描 JSON）；锁版本建议 |
| HMR 不监视仓库外文件 | dev 时以 `--patch` + 重启迭代；可选在 dev overlay 扩展 hmr root |
| 多会话并发 | engine 全部状态按 sessionId 键控 |
| 停机通知噪音（goal 自动续轮误报完成、连续任务逐轮刷屏） | `agent/status` idle 宽限窗口过滤自动续轮；complete 每会话节流 + 类别开关；aborted 的 user/parent 原因抑制 |
| 进程死亡无通知（进程内观察者盲区） | §7.1 第 5 项（进程死亡看门狗）：正常退出 `dispose` 告别通知；异常死亡依赖进程外心跳监督者（sidecar/systemd） |
| 新手配置摩擦（公开发布重点） | setup 引导命令 + settings 面板 + status 可执行提示三层兜底；setup 监听窗口可中止、失败提示覆盖常见坑（事件订阅/p2p scope） |
