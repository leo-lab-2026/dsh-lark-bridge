# 03 · 插件开发流程（从零到发布）

> 对应官方文档：[第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、[开发一个工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.md)、[插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)、[打包与安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[LLM 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md)、[dsh CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)。

## 流程总览

```text
① 环境准备（clone + pnpm install + build）
② 本地插件（scratch-plugin 目录 + apply 函数）
③ 挂载运行（cordis.yml patch → pnpm dsh web --patch）
④ 迭代开发（HMR + 配置 schema + 依赖注入 + 事件）
⑤ 打包 bundle（package.json dsh.bundle + cordis.patch.yml + 入口）
⑥ 安装进 profile（dsh plugin add → --dump-config 验证 → 运行）
⑦ 分发（npm publish / tarball / github + prepare + allowBuilds）
```

## ① 环境准备

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build          # 源码运行时需构建产物（Typert Host / 前端 / client bundle）
```

- 需要 Node `^22.19 || >=24`、pnpm（repo 用 11.7）。
- 源码执行：仓库根目录用 `pnpm dsh <args...>`（等价 `node --import tsx/esm apps/cli/src/bin.ts`）；安装版直接 `dsh <args...>`。教程类无密钥实验可用 `node --import tsx vendor/cordis/bin.js`（在 `tmp/cordis-tutorial/` 下跑 `cordis.yml`）。

## ②③ 第一个插件：本地挂载运行

```sh
mkdir -p scratch-plugin/src
```

`scratch-plugin/src/my-plugin.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  console.log('[hello-plugin] plugin loaded!')
}
```

`scratch-plugin/cordis.yml`（Web 覆盖层，插件路径必须为绝对路径）：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

启动并验证：

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
# 打开 http://127.0.0.1:3080，终端打印 [hello-plugin] plugin loaded!
```

## ④ 迭代开发三件套

### a. 声明依赖（inject）

```ts
export const name = 'my-tool-plugin'
export const inject = ['tools']        // 依赖就绪后才 apply

export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}
```

### b. 接受配置（Config schema）

见 [02-plugin-core.md §6](./02-plugin-core.md#6-插件配置schemastery-schema)：导出 `Config` 接口 + Schemastery schema，`cordis.yml` 里加 `config:` 块；改配置自动触发热替换。

### c. 事件/effect 自动清理

一切经 `ctx` 的注册（`ctx.on`、`ctx.plugin`、`ctx.tools.register`）卸载即回收；自建资源用 `ctx.effect(() => disposer)`。

## 流程 A：开发一个工具插件（最常用路径）

在 `ctx.tools` 注册由模型调用的工具，核心是 `defineTool`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',          // 模型看到的描述
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },                  // 规范返回值（JSON 值）
      render: (_args, value) => [{ type: 'text', text: value }],  // 模型可见内容
    },
    async execute(args, exec) {                    // args 由 schema 推导并预先校验
      return `Hello, ${args.name}!`
    },
  }))
}
```

运行后在 Web UI 输入 `Use the greet tool to greet Ada.`，模型即可调用并收到结果。

**工具编写关键规则**（完整契约见官方[工具编写参考](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-tool.html)）：

1. **参数自动校验**：`defineTool` 在 `execute` 前按 `parameters` DSL 校验模型参数；跨字段/非空等 DSL 表达不了的约束仍需自行检查。直接注册原始 JSON Schema 的工具自负输入校验。
2. **返回规范 JSON 值**（不是内容块）：`execute` 只返回 `output.schema` 声明的值，注册表快照/校验/冻结后交给 `output.render(args, value)` 渲染。异常或无效值 → 结果标记 `isError`。
3. **遵守 `exec.signal`**：取消信号触发即停止进行中的工作。
4. **后台工作**：`run_in_background` 工具用 `ctx.jobs.start({ kind, label, owner: exec.agent, run })`，成功分支返回 `{ kind:'background', jobId }` 这类规范句柄；任务生命周期归 `job_kill`/owner dispose，与 `exec.signal` 解耦。
5. **UI 卡片是独立关注点**：可选的 `presentCall(args)` / `presentResult(args, {content, isError, meta})` 返回 `card` 标签渲染意图（`generic`/`terminal`/`diff`/`search`/`read`/`web`），必须为纯函数（回放时也会执行）。可选的 `output.presentationMeta(args, value)` 派生随 `tool/result` 持久化的回放数据。
6. **执行策略放扩展点，不内建到工具**：`tools/pre-execute`（可重排允许/拒绝/询问）→ `ctx.tools.guard()`（单调最终拒绝）→ `tools/execute`（超时/重试/指标）→ `tools/post-execute`（替换内容/值、阻止、附加上下文）→ `tools/result`（只读观察）。
7. **Code Mode 自动触达**：Code Mode 下每个可见工具自动可用 `await tools.<name>(args)` 调用，`output.schema` 就是程序化 API——把句柄/字段直接返回，面向人的解释放进 `render`。

生产级参考实现：`packages/shell/tool-bash`（terminal 卡片）、`packages/fs/tool-fs`（generic/diff 卡片）。

## 流程 B：接入一个新 LLM 提供方（适配器）

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  attributionHeaders, LlmAdapter, LlmError,
  type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'

class MyAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. options.messages → 提供方格式
    // 2. 调用流式 API（headers 必须合并 attributionHeaders()，请求传 options.signal）
    // 3. 响应 → StreamChunk 序列（协议见下）
    throw new LlmError('Provider API error: …', 'PROVIDER_HTTP_ERROR')  // 错误带稳定 code
  }
}

export interface Config { apiKey: string; providers: string[] }
export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required(),
  providers: Schema.array(Schema.string()).required(),
})

export const name = 'my-llm-adapter'
export const inject = ['llm']

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(config.providers, new MyAdapter(config.apiKey))
}
```

**StreamChunk 协议**：每个内容块以 `block-start {index, blockType}` 开始、`block-end {index, block}` 结束（block 为完整块）；文本走 `text-delta`，工具调用走 `tool-call-delta {id: CallId, name, argumentsDelta}`（原始 JSON 文本增量）；`usage` 必须在 `finish` 之前，`finish` 必须最后（`reason: {kind:'stop'|'tool-calls'|'error'|'aborted'}`）。index 从 0 递增。

其他可覆写：`resolveModel(provider, model, signal?)`（精确模型身份 + context/reasoning 元数据；异步须响应 signal）、`listModels()`（选择器展示）。参考实现：`packages/llm/llm-deepseek`（OpenAI 兼容）、`packages/llm/llm-pi-ai`。

组合进 `cordis.yml`：

```yaml
- id: my-llm
  name: './src/my-llm-adapter.ts'
  config:
    apiKey: !!js process.env.MY_API_KEY
    providers: [my-provider]
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: my-provider
        model: my-model-v1
```

## 流程 C：UI / 聊天节点插件

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      render(event.data.chunk.text)   // 从持久事件流渲染
    }
  })
  onUserInput(text => ctx.agents.get(SessionId('client-session'))?.followup(
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  ))
}
```

Web Client 业务行：注册 `ConversationNodeDefinition` + keyed renderer（步骤见官方 [adding-a-conversation-node](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-conversation-node.html)）。

## ⑤ 打包成 Bundle（组合包）

```
hello-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # profile 列出本 bundle 时应用的层
└── index.js           # patch 行引用的插件模块
```

`package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`（按包名引用，Node 解析到已安装代码）：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

没有 `dsh.bundle` 声明的包只作为普通依赖（供其他插件 import），`dsh plugin` 会告警且不激活任何层。

## ⑥ 安装进 Profile

```sh
dsh plugin --profile demo add ./hello-plugin      # 首次初始化 profile（含 dsh-base）
# 等价于在 profile 目录内把参数转发给 pnpm

dsh --profile demo --dump-config   # 先验证层：应出现 "# == dsh-hello-plugin"
dsh --profile demo                 # 启动
dsh plugin --profile demo remove dsh-hello-plugin
```

生成的 profile `package.json`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

**Bundle 作者的推论**（patch 语义）：你的 patch 可以按 `id` 覆盖前面各层的行，但必须**重述该行每一个键**；用户可在自己 profile 的 `cordis.patch.yml` 里覆盖你的行——优先给出用户大概率保留的默认值，其余交给 schema。

**让表层 bundle 持有自己的命令行**：挂载普通提供方插件（`inject = ['cmdlineArgs']`，用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline` 解析自己 program 的参数，在 action 里提供服务）；取 flag 的配置行 inject 该服务并用 `!!js` 求值：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

## ⑦ 分发方式对比

| 方式 | 命令 | 构建要求 |
|---|---|---|
| npm 发布 | `pnpm publish`（预构建 `lib/`）→ 用户 `dsh plugin add your-package` | 发布时构建 |
| tarball | `pnpm pack` → 用户 `dsh plugin add ./hello-plugin-0.1.0.tgz` | 打包前构建 |
| GitHub 安装 | 用户 `dsh plugin --profile demo add github:you/hello-plugin#<sha>` | **源码安装**，不会运行 `build` 脚本 |

GitHub 安装注意事项：

- **作者**必须提供自包含的 `prepare` 脚本（pnpm 在 git 安装后运行它，直接转译 `src/`，不能假设旁边有 monorepo checkout；参考 [turtle-ui](https://github.com/deepseek-harness/turtle-ui)）。
- **用户**需为构建授权：pnpm ≥10 默认拒绝 git 依赖的 `prepare`；首次 `add` 失败后，把 pnpm 提示的确切包键复制进 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  再重新 `add`。该授权意味着**允许该包代码在安装时于本机执行**（且不在 agent 沙箱内）——只对可信源码授权并锁定 commit。

## 常用 CLI 命令速查

```sh
dsh web                                       # = --profile web；Web UI 默认 127.0.0.1:3080
dsh web --patch ./extra.cordis.yml            # 附加 overlay 层
dsh web --dump-config                         # 查看生效配置树（含每行来源注释）
dsh --profile headless "run the tests"        # 一次性任务：stdout 文本，completed 时退出码 0
dsh --profile <name> --dump-default-config    # 只看 bundle 层
dsh plugin --profile <name> add|remove|update|why <spec…>   # 转发给 pnpm
dsh plugin --profile demo add github:you/hello-plugin#<sha>
dsh --help | dsh web --help                   # 启动器 / 应用各自的帮助
# 源码仓库内用 pnpm dsh <args> 代替 dsh；dev:web watcher 见 02 §10
```

## 调试与测试要点

- **PENDING 静默**：插件无输出先查 fiber 状态（`ctx.registry.values()`，见 02 §7）与模块名拼写。
- **配置校验**：非法 config 会在启动时以 `ValidationError` 明确报错。
- **验证 patch**：先 `--dump-config` 再启动；`!!js` 表达式在 dump 中保持未求值；找不到目标的 patch 报 stderr。
- **测试**：仓库 vitest（`pnpm test` / `test:e2e` / `test:snapshot`）；面向模型/UI 的交付变更必须提供对应组装覆盖（见官方 [testing](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.zh.md)）。
- **文档校验**：仓库自带生成-校验闭环（`gen-doc-graphs`、`gen-cordis-catalog`、`verify-translation-pairing` 等），改动生成区块需重跑生成脚本。
