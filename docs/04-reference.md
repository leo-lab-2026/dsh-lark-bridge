# 04 · 参考资源速查

> 在线参考站点：<https://deepseek-harness.github.io/deepseek-harness/reference/>。站点由仓库 `website/docs.ts` 把 `docs/**` 的 Markdown（中文侧取 `*.zh.md`）投影生成，以下路径可直接对照仓库源码。

## 1. 参考站点地图（/reference/ 路由）

| 站点路由 | 仓库源 | 内容 |
|---|---|---|
| `/reference/` | `docs/architecture.md` | **架构**：Cordis、profile/bundle、核心包、事件域、轮次流程、新行为归属表 |
| `/reference/cordis-primer` | `docs/cordis-primer.md` | **Cordis 入门**：五概念、分发模式、waterfall 语义、loader 配置 |
| `/reference/subsystems/*` | `docs/subsystems/*.md`（50+ 页） | **子系统参考**：core/agent、session、tools、approval、sandbox、fs、shell、skills、subagent、workflow……每页含生成的 `cordis-surface`（服务方法 + 事件签名 + 源码位置） |
| `/reference/capability-seams` | `docs/capability-seams.md` | **能力 seam 图与表**：每个 ctx 键的定义包/实现/消费方 |
| `/reference/agent-lifecycle` | `docs/agent-lifecycle.md` | Agent 生命周期时序 |
| `/reference/tool-execution-pipeline` | `docs/tool-execution-pipeline.md` | 工具执行流水线顺序图 |
| `/reference/config-catalog` | `docs/config-catalog.md` | **生成**：全部插件配置字段 |
| `/reference/tool-catalog` | `docs/tool-catalog.md` | **生成**：全部内置工具 schema |
| `/reference/persistence-catalog` | `docs/persistence-catalog.md` | **生成**：持久化会话事件词汇 |
| `/reference/cordis-api/*` | `docs/cordis-api/*.md` | **Cordis 核心 API**：context（extend/isolate/intercept）、events、fiber、inherited、registry、service |
| `/reference/cookbook/*` | `docs/cookbook/*.md` | **Cookbook**：extension-cookbook（功能→机制映射）、adding-a-tool（工具契约真源）、adding-an-llm-adapter、adding-a-package、adding-a-vendored-package、adding-a-conversation-node |
| 站外（仓库内、未上站） | `docs/cordis-tutorial/`、`docs/user/develop/`、`apps/cli/reference/README.zh.md` | 7 章动手教程、面向插件作者的分步指南、CLI 行为参考 |

## 2. 插件作者建议阅读顺序

1. `docs/cordis-primer.zh.md` —— 30 分钟建立心智模型；
2. `docs/cordis-tutorial/01~07` —— 动手（无需 API 密钥）；
3. `docs/user/develop/basic/{index,tool,config,publish}.zh.md` —— harness 内真实流程；
4. `docs/user/develop/framework/{index,service,events}.zh.md` + `practice/{index,llm-adapter}.zh.md` —— 进阶；
5. 按需查 `docs/subsystems/*.zh.md` 的 `cordis-surface` 生成区块（写代码时以此 + TS 接口为准，不维护静态清单）。

## 3. 仓库关键路径速查

| 路径 | 用途 |
|---|---|
| `packages/core/tools/README.md` | 工具注册表 + 执行流水线 + 扩展点 + Code Mode 权威说明 |
| `packages/llm/llm/README.md` | LLM 服务/适配器/StreamChunk 协议权威说明 |
| `packages/bundle/{base,web-app,headless}/cordis.patch.yml` | 内置 bundle 的完整插件清单（最好的"真实 cordis.yml"范例） |
| `examples/headless-agent/cordis.yml` | 一个可运行 agent 的完整组合（适配器/工具/压缩/子代理……逐行注释） |
| `packages/examples/`、`examples/` | 演示 bundle 与可运行叶子组装 |
| `apps/cli/reference/README.zh.md` | CLI 层序、flag、profile、插件管理、web 别名、源码执行的权威行为参考 |
| `vendor/cordis/{src,bin.js}` | vendored Cordis 框架源码 + 单文件启动器 |
| `docs/module-graph.md` | 包依赖关系图（`pnpm run gen-module-graph` 生成） |
| `docs/event-producer-consumer.md` | 每个事件的生产方/消费方映射 |
| `website/docs.ts` | 站点路由 ↔ 仓库 Markdown 的投影清单 |
| `.agents/notes/**` | 大量带日期的架构/特性设计笔记（如 capability-seams、tool-cancel、parallel-tool-call 等 Agent Note） |

## 4. 功能 → 插件机制对照表（官方 cookbook 摘编）

| 产品功能 | 插件机制 |
|---|---|
| 钩子系统（用户级+项目级） | `agent/session-start`、`agent/pre-step`、`agent/request`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping` 监听器；`dsh-hooks-claude-code`/`dsh-hooks-codex` 把钩子配置映射到这些点 |
| 同会话目标（/goal） | `ctx.goals` 持久状态 + goal-round-driver 通过公共 `Agent` 调度轮次 |
| /loop 循环 | `turn/end` 上 `followup()` 下一次迭代 |
| 动态工作流 | `ctx.workflowEngine` + worker-thread 引擎 + `workflow`/`ralph` 工具（`agent()` 经 `ctx.subagents` 扇出） |
| 排队消息 + 中途引导 | 核心 `Agent.followup()` / `Agent.steer()` |
| 上下文压缩 | `ctx.compaction` seam + `dsh-compaction-basic`（`agent/pre-step` 压力检查、`agent/request-error` 溢出恢复） |
| 系统提示词可配置 | `ctx.systemPrompt.section()`（排序 + 作用域覆盖）；AGENTS.md 读取器就是一个 section provider |
| 目录 AGENTS.md 按需触发 + 文件变更通知 | watcher/工具结果监听器调用 `agent.inject()` |
| 内置工具 | `ctx.tools.register()`；schema 自动流入组装（dsh-tool-bash/fs/web/subagent/todo 为范例） |
| ToolSearch / 渐进式披露 | 可见集变化时替换作用域化的 `ctx.tools.restrict()` 注册 |
| 工具截止时间/重试/指标 | `tools/execute` 包裹分发（仅可替换 `exec.signal`） |
| 最终结果指标/审计/捕获 | `tools/result` 只读观察；需变换才用 `tools/post-execute` |
| 单调终止轮次策略 | 成功终端工具调用 `ToolExecution.concludeTurn()` |
| 子进程沙箱（landlock/sandbox-exec） | `dsh-bash-sandbox` 用 `ctx.sandbox` 后端；能力级拒绝用 `tools/pre-execute` |
| 权限系统 / AskUserQuestion | `tools/pre-execute` 返回 `ask` + `ctx.approval` 应答；普通提问注册独立 ask 工具 |
| Plan mode | `dsh-plan-mode`：落日志 `plan/mode`、`plan:policy` 引导段、`/plan` 入口、`exit_plan_mode` 出口 |
| subagent 委派 | `ctx.subagents` provider 注册表（spawn/fork/acp/codex/claude-code/dsh-sdk）+ `dsh-tool-subagent` |
| MCP | 每服务器一个插件：发现工具 → `ctx.tools.register()` |
| skill | section + 工具注册；调用时 `inject()` 注入内容 |
| 记忆 | section provider + 工具 |
| 定时任务（cron） | 插件注册面向模型的调度工具；空闲时 `followup(…, {source:{kind:'cron'}})`／忙碌时 `inject()` 通知 |
| UI（GUI；CLI 输出 JSONL） | 监听 `session/event`；输入 → `followup()` |
| 遥测 / 可回放 trace | `session/event` → JSONL；回放 = `sessions.create(id, { seed })` |
| 模型适配器 | `LlmAdapter` 子类 + `registerAdapter` |
| 插件热重载 | 每个注册都是 `ctx.effect` → HMR 直接生效 |

## 5. 术语表（摘编自官方 glossary）

| 术语 | 含义 |
|---|---|
| **Cordis** | DSH vendored 的插件框架（shigma 系，与 Koishi 同源） |
| **Context（ctx）** | 服务容器；`ctx.<key>` 访问服务，`extend/isolate/intercept` 派生作用域 |
| **Plugin** | 导出 `apply(ctx[, config])` 的模块（函数/对象/Service 子类） |
| **Service** | 插件通过 `super(ctx, name)` 公开到 ctx 的具名能力 |
| **inject** | 插件声明的必需服务依赖 |
| **Fiber** | 已加载插件实例的运行时句柄（PENDING→…→DISPOSED） |
| **effect** | 可逆副作用：`ctx.effect(() => disposer)` |
| **emit / parallel / serial / bail / waterfall** | 五种事件分发模式 |
| **waterfall 短路** | 监听器不调 `next()` 直接返回 = 否决下游 |
| **Seam** | 可替换能力 = Service Definition + Provider + Consumer |
| **Profile** | `$DSH_HOME/profiles/<name>` 下的具名组装 |
| **Bundle（组合包）** | 带 `dsh.bundle` manifest 与 patch 层的 npm 包 |
| **Patch 层** | `cordis.patch.yml`：按 id 覆盖整行 config 或插入新行，后写胜出 |
| **Loader** | 读 `cordis.yml`/patch 并挂载插件的插件（`@deepseek-ai/cordis-plugin-include` 支持 `!!js`） |
| **HMR** | `@deepseek-ai/cordis-plugin-hmr`：卸载-重载替换运行中的插件 |
| **PENDING** | 等待缺失服务的合法静默状态 |
| **Agent loop / agent loop** | 实现 Agent 接口的默认驱动器（步骤/轮次循环） |
| **Turn / Step** | 轮次（一次输入到不再欠任何工作）/ 步骤（一次模型请求+其工具调用） |
| **Session event** | 仅追加的持久事实，经 `session/event` 广播；"模型可见即已记录" |
| **Code Mode** | 工具经 `run_code` 程序（TS/Python）调用：`await tools.<name>(args)` |
| **canonical value / render** | 工具规范 JSON 返回值 / 面向模型的渲染内容（值-展示分离） |
| **presentCall / presentResult** | 工具自有的 UI 卡片渲染意图（generic/terminal/diff/search/read/web） |
| **typert** | 运行时类型注册表 / RPC 网关（API BFF） |
| **Schemastery** | 配置/值 schema 库（`Schema.object({...})`），满足 Standard Schema |
| **dsh.bundle / dsh.profile** | package.json 中两类 manifest（组合包 / profile） |
| **cmdlineArgs** | 启动器移交应用参数的共享不可变快照（`ctx.cmdlineArgs.get()`） |
| **isolate / realm** | 服务隔离：组内独立的服务实例作用域 |

## 6. 常用导入速查

| 包 | 常用导出 |
|---|---|
| `@deepseek-ai/cordis` | `Context`（type）、`Service`、`FiberState`；`declare module` 合并点 |
| `@deepseek-ai/schemastery` | `Schema`（default import） |
| `@deepseek-ai/dsh-tools` | `defineTool`、`ToolExecution`/`PreToolDecision` 等类型、`tools/*` 事件声明 |
| `@deepseek-ai/dsh-llm` | `LlmAdapter`、`LlmError`、`CallId`、`StreamChunk`/`GenerateOptions` 类型、`attributionHeaders`、`createUserMessage` 等消息构造器（`@deepseek-ai/dsh-llm/message` 供浏览器侧） |
| `@deepseek-ai/dsh-session` | `SessionId` 等品牌类型 |
| `@deepseek-ai/dsh-cmdline` | `parseCmdline`（应用自有 CLI 参数） |
| `@deepseek-ai/cordis-plugin-*` | 辅助插件：hmr、timer、logger-console、include（`!!js`） |

> 声明合并的引入方式：`import type {} from '@deepseek-ai/dsh-tools'`（运行时零依赖，仅让 TS 看到 `Events`/`Context` 合并）。
