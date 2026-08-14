# 02 · 插件开发核心知识

> 对应官方文档：[Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer.html)、[Cordis 教程](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.html)（仓库 `docs/cordis-tutorial/`）、[插件与生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/index.md)、[服务与依赖](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/service.md)、[事件系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/framework/events.md)、[插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)。

## 1. 插件的最小形态

插件是导出 `apply` 函数的 TypeScript 模块。框架加载时调用 `apply`，传入上下文对象 `ctx`；所有能力都通过 `ctx` 注册：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'     // 可选：诊断标识

export function apply(ctx: Context) {
  // 在这里注册能力
}
```

## 2. 插件的三种形态

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

// 1. 函数插件（最常用）：Cordis 直接调用该函数
export function apply(ctx: Context) {}

// 2. 对象插件：带 apply 方法的对象
export const objectPlugin = {
  name: 'object-plugin',
  apply(ctx: Context) {},
}

// 3. 类插件：Service 子类（需要向 ctx 公开服务时使用）
export class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myTutorialService')
  }
}
```

类形态的等价写法：`export default class MyService extends Service { static inject = ['tools']; constructor(ctx) { super(ctx, 'myService') } }`。大多数情况用函数形态；要对外提供服务才用类形态。

## 3. 生命周期：Fiber 状态机与 Effect

每个已加载插件实例都有一个 **fiber**：

```text
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
               ↘ FAILED
```

| 状态 | 含义 |
|---|---|
| PENDING | 已声明，但 `inject` 的必需服务尚不可用 |
| LOADING / ACTIVE | `apply` 运行中／已完成 |
| FAILED | `apply` 或配置校验抛异常（进程报错退出） |
| UNLOADING / DISPOSED | disposer 运行中／一切已拆除 |

插件可能因改配置、热重载、显式 dispose 或**所需服务消失**而卸载。

### ctx.effect：可逆副作用

Cordis 不管理的资源（定时器、连接、watcher）用 `ctx.effect()` 包装并返回 disposer：

```ts
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => console.log('tick'), 200)
    return () => {                     // 卸载时自动执行
      clearInterval(timer)
    }
  })
}
```

**已经属于 effect 的内置注册**（无需手写清理）：

- `ctx.on(event, listener)` —— 监听器卸载时自动移除；
- `ctx.plugin(child)` —— 子插件随父插件递归 dispose；
- 服务注册、`ctx.tools.register(...)` 等 harness 注册表——返回的 disposer 附着到调用插件上，自动撤销。

顺序注意：disposer 按注册顺序**逆序**启动，但多个**异步** disposer 并发运行；有顺序要求的拆除步骤必须放进同一个 disposer 里串行 await。

`ctx.plugin(fn)` 返回 fiber 句柄，`await fiber.dispose()` 会等所有清理（含异步）完成后结束。

## 4. 服务与依赖注入（inject）

**服务** = 一个插件提供、其他插件通过 `ctx` 消费的具名能力。harness 中 `ctx.tools`、`ctx.llm`、`ctx.agents` 都是服务。消费方只声明能力名（`inject`），不 import 提供方 → 配置可以替换提供方而不改消费方。

### 提供服务

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {          // 编译时：声明合并
  interface Context { greeter: GreeterService }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')                        // 运行时：注册 ctx.greeter
  }
  greet(who: string) { return `Hello, ${who}!` }
}

export function apply(ctx: Context) {
  ctx.plugin(GreeterService)                     // Service 子类本身就是插件
}
```

### 消费服务

```ts
export const inject = ['greeter']               // 硬依赖：就绪才启动

export function apply(ctx: Context) {
  console.log(ctx.greeter.greet('world'))
}

// 可选依赖：不写 inject，使用处探测
export function apply(ctx: Context) {
  const greeter = ctx.get('greeter')            // 无提供方时 undefined
  console.log(greeter?.greet('maybe') ?? 'no greeter available')
}
```

### 依赖行为要点

- **加载顺序无关紧要**：决定启动时机的是依赖关系，不是 `cordis.yml` 行序。
- **运行期继续跟踪**：必需服务消失（提供方被卸载/热替换）→ 依赖插件自动 dispose；服务恢复 → 自动重新加载。这正是"换 provider 全树自动重启"的机制。
- 服务名共用扁平命名空间：自有服务加前缀（harness 已占用 `tools`、`llm` 等）；完整清单见各子系统页生成的 `cordis-surface` 区块。

## 5. 事件系统

事件让插件在不知道有哪些监听者的情况下通信。harness 用事件处理工具结果、模型请求、审批决定等交互。

### 声明合并获得类型安全

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'stats/report'(name: string, count: number): void
    'demo/transform'(input: string, next: () => Promise<string>): Promise<string>
  }
}
// 之后 ctx.emit / ctx.on / ctx.waterfall('stats/report', …) 全部有类型
// 命名约定：namespace/action；import type {} from '包' 引入声明合并
```

### 五种分发模式（详见 01 架构 §2）

```ts
ctx.emit('stats/report', name, next)              // 同步广播，忽略返回值
await ctx.parallel('x', payload)                  // 全部并发，一起等待
await ctx.serial('x', payload)                    // 顺序执行，首个非空值胜出
ctx.bail('x', payload)                            // serial 的同步版
await ctx.waterfall('x', input, async () => input) // 中间件链，见下
```

### Waterfall：拦截/转换/短路

```ts
ctx.on('demo/transform', async (input, next) => {
  const downstream = await next()          // 1) 先委托下游
  return downstream.toUpperCase()          // 2) 再包装返回值
})
ctx.on('demo/transform', async (input, next) => {
  if (input.includes('blocked')) return '** blocked **'  // 有意短路：不调 next()
  return next()
})
```

**纪律：只观察/标注的 waterfall 监听器必须调用 `next()`**；不调用 = 短路（否决），是策略监听器的特权。忘记 `next()` 的日志监听器会静默吞掉所有下游默认行为。

harness 的典型 waterfall：`agent/pre-step`（改写/拒绝进入的消息）、`agent/request`（替换模型调用配置）、`approval/request`（策略代替用户作答）、`llm/stream`（缓存/日志/路由）、`tools/pre-execute`（允许/拒绝/询问）。

### 区分：Cordis 事件 vs 会话事件

`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久化的会话事件类型**，不是同名 Cordis 事件。要观察它们：监听 `session/event` 并检查 `event.type`。

## 6. 插件配置（Schemastery Schema）

`cordis.yml` 条目可带 `config` 块；插件导出同名 `Config` 接口 + schema，在 `apply` 之前校验，非法配置加载失败并给出准确报错。

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'config-demo'

export interface Config {
  greeting: string
  targets: string[]
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) {
  // config 总是完整且通过校验（默认值已补齐）
}
```

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
    greeting: !!js process.env.DEMO_GREETING ?? 'Hello'   # !!js：加载时求值
```

- `Config` 同时是 TS 接口（消费方类型）与运行时 schema（验证器）。不要导出普通对象——Cordis 接受任意 [Standard Schema](https://standardschema.dev/) 验证器。
- `!!js` 标签仅在 `config` 与条目 `disabled` 字段内有效（`disabled: !!js ...` 每次挂载决策时基于 loader 上下文求值，可按平台/环境门控一行）。
- **无硬编码可调参数**：凡是不同部署可能取不同值的参数都必须是配置字段。检验标准：能否只改 `cordis.yml` 而不改代码？
- 配置变更触发 HMR：卸载旧实例 → 加载新实例，旧注册全部回收。

## 7. 组合、HMR 与诊断

### 配置条目元数据

```yaml
- id: greeter          # 稳定标识；无 id 的行每次读取都视为"删了重建"
  name: './greeter.ts'
- id: consumer
  name: './consumer.ts'
  disabled: true       # 卸载但不删行；改回 false 即恢复
```

- 组（`group: true` + 子列表）可作为一个单元加载/卸载；`isolate: { shell: true }` 为组提供某项服务的独立实例（两个组各看到配置不同的 `shell` provider）。
- 相应 ctx API：`ctx.extend(meta)`（子上下文）、`ctx.isolate(name, label?)`（隔离某服务的解析作用域）、`ctx.intercept(name, config)`（服务级拦截配置）。

### HMR

`@deepseek-ai/cordis-plugin-hmr`（inject `timer` 服务做去抖）监视文件；保存即卸载旧实例（所有 effect 回卷）→ 加载新代码 → 重跑 `apply`。编辑 `cordis.yml` 本身也触发：loader 按 `id` 比较，只挂载/卸载/重配置变化的部分。

### 诊断"为什么我的插件没有输出"

插件 `inject` 了无人提供的服务 → 永远 PENDING，静默等待（合法状态，进程可能因此直接退出）。诊断方法：

```ts
import { FiberState, type Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.state === FiberState.PENDING) {
        console.log(`${fiber.name} is PENDING — a required service is missing`)
      }
    }
  }
}
```

另注意：配置项模块**无法解析**（路径/包名拼错）时，Cordis 通过 logger 报告而**不崩进程**；启动早期该报告可能丢失——新增行无效果先查拼写。`apply` 抛异常则进程直接退出。

## 8. 作用域：全局注册 vs agent 级注册

- 普通插件 ctx 上的注册是**全局**的（如全局工具）。
- 用 `agent.ctx` 注册则该 agent 独享（同名全局工具被它遮蔽）；`ctx.tools.presentAs(mode)`、`ctx.tools.restrict(filter)`、`ctx.tools.guard()` 同样支持 agent 作用域。
- `agent.ctx` 来自 `Agent` 句柄（`ctx.agents` 注册表）。作用域是可见性组合，**不是安全边界**（官方明确：security/authority 是非目标，用沙箱与审批负责）。

## 9. 扩展点速查：把行为接到哪里

| 需求 | 扩展点 |
|---|---|
| 新模型提供方 | `class X extends LlmAdapter` + `ctx.llm.registerAdapter(providers, adapter)` |
| 新面向模型的能力 | `ctx.tools.register(defineTool({...}))` |
| 工具执行前策略（允许/拒绝/询问） | `tools/pre-execute`（waterfall，返回 `{kind:'allow'|'deny'|'ask'}`） |
| 单调最终拒绝（不可被后续监听器撤销） | `ctx.tools.guard(fn)` |
| 包裹工具分发（超时/重试/指标） | `tools/execute`（waterfall；仅 `exec.signal` 可替换） |
| 变换工具结果/附加上下文 | `tools/post-execute` |
| 只读观察最终权威结果 | `tools/result`（emit） |
| 拦截模型请求 | `agent/request`、`llm/stream`（waterfall） |
| 每步前改写/拒绝输入 | `agent/pre-step`（waterfall） |
| 轮次要停止 | `agent/turn-stopping`（serial） |
| 持久事实观察 | `session/event`（按 `event.type` 过滤） |
| 向模型注入额外上下文 | `agent.inject({content, source})`（不唤醒，下次请求可见） |
| 用户输入回流 | `agent.followup()` / `agent.steer()` |
| 系统提示词片段 | `ctx.systemPrompt.section()`（支持排序与作用域覆盖） |
| 面向人的命令 | `ctx.commands.register(...)` |
| 后台任务 | `ctx.jobs.start({...})` |
| Web UI 聊天节点 | `ConversationNodeDefinition` + keyed renderer |

### 权限门禁插件示例（钩子插件范式）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

## 10. 客户端插件（浏览器侧）要点

- Web 组合包中的 `dsh.client` 行构成浏览器 roster，modules 节点半将其扫描进 `window.__DSH_BOOT__`；客户端插件经 HMR 接收器热更（需 `pnpm run dev:web` 同时运行才能不刷新即重载 bundle）。
- UI 插件从 `session/event` 渲染（助手 token 流以 `assistant/chunk` 到达），通过 `agent.followup()`/`agent.steer()` 回流输入。
- 向 Web Client 贡献业务行：注册 `ConversationNodeDefinition` + keyed Chat renderer（见 04 参考）。

## 11. 编写纪律清单（官方实践规则）

1. 把行为封装为插件；工具流水线事件属于 `ctx.tools`，模型流属于 `ctx.llm`，实时 agent 协调属于 `ctx.agents`。
2. 拦截与策略优先用事件；直接能力调用优先用服务方法。
3. 每个注册都要有对应 disposer（`ctx.effect()` 返回一个，或用内置辅助）。
4. teardown 有顺序要求时，放进同一个 effect 中按序释放。
5. 配置错误要响亮（schema 里表达全部约束，加载即失败）；对服务的引用用依赖注入。
6. 插件依赖 Service Definition，绝不依赖具体 provider。
