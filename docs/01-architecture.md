# 01 · DeepSeek Harness 架构总览

> 对应官方文档：[architecture](https://deepseek-harness.github.io/deepseek-harness/reference/)（reference 首页即架构页）、[capability-seams](https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams.html)。仓库源码：`docs/architecture.zh.md`、`docs/capability-seams.zh.md`。

## 1. DSH 是什么

DeepSeek Harness（命令 `dsh`）是一个 TypeScript 编写的 agent 运行时框架（MIT，pnpm monorepo，npm scope `@deepseek-ai/dsh-*`，要求 Node `^22.19 || >=24`）。它提供一个可启动的 Web GUI（默认 `http://127.0.0.1:3080`）与 headless 运行模式，但其本质是一个**可组合、可替换的插件平台**。

核心设计原则：**没有特权内核**。产品的每一部分——模型适配器、工具注册表、会话日志、沙箱策略，乃至 agent loop（智能体主循环）本身——都是挂载到共享上下文上的插件，因此每一部分都可以从配置中替换。扩展 dsh 的方式就是把自己的插件挂载到其他插件旁边；所有注册都是可逆副作用，插件卸载时自动撤销。

```text
dsh 运行时的形态 = 一棵插件树（Cordis Context）
根 Context ── Loader(读 cordis.yml) ── 数百个插件行（LLM/工具/持久化/UI/…）
```

## 2. Cordis 微内核

[Cordis](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.html) 是 DSH 以 vendor 方式引入（`vendor/cordis/`）的插件框架。五个核心概念：

| 概念 | 含义 |
|---|---|
| **插件是实现 Service 的对象** | 带可选 `inject`/`apply(ctx)` 的函数，或 `Service` 子类；生命周期由 Cordis 挂载到当前上下文 |
| **上下文是服务的容器** | 一个服务占据稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；消费方通过 key 查找服务，而非 import 具体实现 |
| **通过 `inject` 声明服务依赖** | 依赖就绪才启动；加载顺序由依赖表达，而非手动编排 |
| **类型化事件用于通信** | 通过 TypeScript 声明合并注册事件名，按 `emit` / `waterfall` / `parallel` / `serial` / `bail` 模式分发 |
| **注册是可逆的副作用** | 提示词片段、工具 schema、适配器、监听器通过 `ctx.effect()` 或 `ctx.on()` 安装，reload/teardown 时自动撤销 |

**分发模式速查**（事件的公开约定，harness 事件均标注 `@mode`）：

| 模式 | 调用 | await？ | 顺序 | 返回值 |
|---|---|---|---|---|
| `emit` | `ctx.emit()` | 否 | 按注册顺序观察 | 无 |
| `parallel` | `await ctx.parallel()` | 是 | 并行扇出 | 无 |
| `serial` | `await ctx.serial()` | 是 | 按顺序，首个非空值胜出 | 有 |
| `bail` | `ctx.bail()` | 否 | serial 的同步版 | 有 |
| `waterfall` | `ctx.waterfall(name, ...args, next)` | 是 | 环绕中间件链 | 有 |

**Waterfall 语义**：监听器收到 `(...args, next)`；调用 `next()` 才执行下游，返回值可被本层包装后继续向外返回；**不调用 `next()` 直接返回 = 有意短路（否决）**。因此纪律是：只观察/标注的监听器必须 `next()`，只有拥有决策权的策略监听器才能短路。

## 3. 组合机制：Profile、Bundle 与 Patch

运行中的 `dsh` 是一棵插件树，由启动时**按序叠加的各层**组合而成。

- **profile**：`$DSH_HOME/profiles/<name>` 下的具名组装，列出自己叠放的 bundle、存放 pnpm 安装的树外插件、保存用户自己的 `cordis.patch.yml`。`web` 和 `headless` 是随发行版交付的模板。
- **bundle（组合包）**：Cordis 配置行及其挂载代码的分发格式。`package.json` 中以 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明。内置三件套：
  - `@deepseek-ai/dsh-base` —— 每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批、设置、凭据、遥测；
  - `@deepseek-ai/dsh-web-app` —— 增加浏览器应用；
  - `@deepseek-ai/dsh-headless` —— 增加一次性运行器，完全不启动服务器。
- **patch 层**：YAML 数组，条目为 `insert:`（插入行）或按 `id` 覆盖已有行的整条 `config`。**后应用的层按行胜出；patch 替换整个 `config` 而不是深合并键。**

**层叠顺序**（在空根之上逐层应用）：

1. profile `dsh.profile.bundles` 列表中的各 bundle patch（按列表顺序）；
2. profile 自己的 `cordis.patch.yml`；
3. home 级 `$DSH_HOME/cordis.patch.yml`（机器本地偏好）；
4. 每个 `--patch <path>` overlay（按 argv 顺序）。

查看机器实际启动的配置树：

```sh
dsh --profile web --dump-config        # 含全部层的生效配置
dsh --profile web --dump-default-config  # 只含 bundle 层
```

它打印出的任何一行，都可以被你自己的 patch 按 `id` 替换。

`cordis.yml` 条目元数据：`name`（模块说明符/包名）、`id`（稳定标识，loader 靠它区分"改行"与"删行重建"）、`config`（经 schema 校验的配置）、`disabled`（卸载但不删行）、`group`/`isolate`（分组与服务隔离）、`inject`。配置行按服务依赖并发激活，**行顺序不承载加载语义**。

## 4. 核心服务（ctx 键）与能力 Seam

### 主干服务

| 包 | 职责 | ctx 键 |
|---|---|---|
| `core/session` | 仅追加的 `SessionEvent` 日志 + 内存存储 | `ctx.sessions` |
| `core/system-prompt` | 提示词片段与工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域化工具注册表 + 带把关的执行流水线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、活跃 agent 注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现 Agent 接口的默认驱动器 | `ctx.agentLoop` |
| `llm/llm` | 消息/流式词汇表 + 适配器 seam | `ctx.llm` |

### 能力 Seam（可替换能力）与三种角色

**Seam** = 一项可替换能力，由三种角色构成：

- **Service Definition**：声明接口（Cordis 服务 + 请求/结果类型）；
- **Service Provider**：实现它（可多个，由配置选择）；
- **Consumer**：使用它（通常是面向模型的工具）。

以 Bash 为例：`dsh-shell`（定义）→ `dsh-bash-local`（本地实现）→ `dsh-tool-bash`（面向模型的工具）。Provider 与 Consumer 互不依赖，都只依赖 Definition。**换一个 provider 就能改变整个产品**——例如把文件系统与进程 provider 都指向远程沙箱，Bash、PTY、LSP 一起搬过去。

完整内置 seam 目录（含实现与消费方包名）见官方[能力 seam 页面](https://deepseek-harness.github.io/deepseek-harness/reference/capability-seams.html)，其中较常用的：`ctx.shell`（bash-local/pwsh-local）、`ctx.fs`（fs-local/fs-sandbox/fs-e2b）、`ctx.subprocess`、`ctx.terminals`、`ctx.sandbox`、`ctx.approval`、`ctx.skills`、`ctx.subagents`、`ctx.jobs`、`ctx.web`、`ctx.lsp`、`ctx.workflowEngine`、`ctx.compaction`、`ctx.settings`、`ctx.credentials`、`ctx.storage`、`ctx.sessionPersistence`、`ctx.sessionTitle`、`ctx.sessionQuery`。

## 5. 事件：三类事件域

事件就是扩展点，**选对事件域是大多数改动的第一个决定**。

- **会话事件（持久事实）**：追加到日志并通过 `session/event` 广播；必须在重载后仍然存在时使用。如 `turn/*`、`step/*`、`assistant/chunk`、`tool/result`（注意：`tool/result` 是持久会话事件，同名 Cordis 事件叫 `tools/result`）。
- **Agent 事件**（`agent/*`）：携带活跃 Agent——inbox、step、state、request、validation、resume；用于观察/拦截进行中的工作。
- **能力事件**（`fs/*`、`tools/*`、`telemetry/*` 等）：无需 import 循环即可给某个 seam 附加策略和适配器。

## 6. 轮次（Turn）流程

**步骤（step）** = 一次模型请求 + 它调用的工具；**轮次（turn）** = 零个或多个步骤。

```text
turn/start
  领取 next-step 输入 + 一条排队消息
  组装提示词分段 + 工具 schema
  → agent/pre-step                   拒绝 | enter(messages)
     step/start
     记录进入的消息为 user/message
     从日志推导模型历史
     agent/request → llm/stream → assistant/chunk* → assistant/message
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     工具还欠一次请求，或 next-step 输入到达 → 领取 → 下一步
  → agent/turn-stopping
turn/end
```

- `agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 事件是 **waterfall**（监听器必须 `next()` 才能委托）；`agent/turn-stopping` 是 **serial**（无 `next()`）。
- **"模型可见即已记录"**：抵达模型请求的一切都必须能从会话日志重建，由运行时不变量断言。因此新增模型可见输入就要新增一个会话事件：扩展 `SessionEventMap` 并从日志渲染。

## 7. 新行为的归属位置（官方速查表）

| 目标 | 机制 |
|---|---|
| 添加模型提供方 | 在 `ctx.llm` 上注册适配器 |
| 添加面向模型的能力 | 在 `ctx.tools` 上注册；schema 自动进入提示词组装 |
| 让某会话拥有不同能力集 | 组装 agent preset；服务行用 `isolate` realm |
| 添加 shell 执行 | 注册 `ctx.shell` 后端；本地后端通过 `ctx.subprocess` spawn |
| 添加用户命令 | 在 `ctx.commands` 上注册（无需模型轮次即可分派） |
| 添加后台工作 | 在 `ctx.jobs` 上注册；`job_*` 工具收集/停止 |
| 添加文件系统访问/策略 | 注册 `ctx.fs` provider，或监听 `fs/*` 事件 |
| 限制启动的进程 | 用 `ctx.sandbox` 后端；消费方在 spawn 前包装 argv |
| 拦截请求/工具/轮次 | 对应 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 可停轮次 |
| 添加模型可见上下文 | 调用 `agent.inject()`；落到下一次获准的请求 |
| 添加 UI/编辑器集成 | 驱动 `ctx.agents` 并从 `session/event` 渲染 |
| 添加 Web Client Chat 节点 | 注册 `ConversationNodeDefinition` + keyed renderer |
| 添加持久会话状态 | 扩展 `SessionEventMap`；从日志渲染和回放 |
| 将注册限定到单个 agent | 使用该 agent 的 `agent.ctx` |
| fork 活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |

## 8. 仓库结构地图

```
deepseek-harness/
├── packages/<group>/<pkg>/   # npm 包 @deepseek-ai/dsh-<pkg>，按能力分组
│   ├── core/       # 产品主干：session、system-prompt、tools、agent、agent-loop、scope
│   ├── llm/        # llm(抽象服务) + llm-deepseek / llm-pi-ai(适配器)
│   ├── shell/ fs/ terminal/ subprocess/ sandbox/ web/ lsp/ subagent/ jobs/ workflow/ …  # 能力家族(定义+实现+工具)
│   ├── bundle/     # base / web-app / headless 组合包
│   ├── boot/       # app 启动胶水（app-boot、cmdline）
│   ├── client/     # 浏览器半（shell、wire、slots、ui-* 插件）
│   ├── host/       # Web-GUI 宿主半（API 网关 + HTTP 路由）
│   ├── extensions/ # agent 运行时自修改（动态插件挂载/检查）
│   └── examples/   # 演示 bundle（agent-spine 等）
├── apps/cli/       # dsh CLI（args.ts → bin.ts → 运行器）；reference/ 有行为参考
├── apps/web/       # Web 前端壳（由 dsh web 注入 __DSH_BOOT__）
├── vendor/cordis/  # vendored Cordis 插件框架 + 启动器 bin.js
├── website/        # VitePress 参考站点（docs.ts 是路由→仓库 Markdown 的投影清单）
├── docs/           # 架构/教程/cookbook/子系统参考（中英双语，生成区块勿手改）
└── examples/       # 可运行组装：headless-agent、acp-agent、web-cordis …
```

依赖纪律：**扩展插件依赖 Service Definition，绝不依赖具体 provider**（`dsh-agent-loop` 可换；UI/hook/工具插件依赖 `dsh-agent`）。包依赖图由 `docs/module-graph.md` 生成（`pnpm run gen-module-graph`）。
