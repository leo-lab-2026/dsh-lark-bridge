# DeepSeek Harness 插件开发文档

本目录是对 **DeepSeek Harness（DSH）** 代码库与官方参考文档的调研总结，聚焦**插件开发知识与流程**。

- 调研源 1（代码库）：<https://github.com/deepseek-ai/deepseek-harness>（本地 checkout：`/home/lifxu/src/deepseek-harness`，commit `47f943859b`，v0.1.0-rc.5）
- 调研源 2（参考站点）：<https://deepseek-harness.github.io/deepseek-harness/reference/>
- 站点与仓库同源：参考站点是 VitePress 项目，通过 `website/docs.ts` 把仓库中的 Markdown（`docs/**`）投影到 `/reference/` 路由，中文侧优先投影 `*.zh.md`。

## 文档导航

### 第一部分：DeepSeek Harness 插件开发

| 文档 | 内容 | 适用读者 |
|---|---|---|
| [01-architecture.md](./01-architecture.md) | DSH 架构总览：Cordis 微内核、插件树、组合机制（profile/bundle/patch）、核心服务与能力 seam、事件域与轮次流程 | 所有人（先读） |
| [02-plugin-core.md](./02-plugin-core.md) | 插件开发核心知识：插件三形态、生命周期与 effect、服务与依赖注入、事件分发模式、配置 schema、HMR 与诊断、作用域与隔离 | 插件开发者 |
| [03-development-workflow.md](./03-development-workflow.md) | 插件开发全流程：从 scratch 插件到工具插件、LLM 适配器、UI 插件，再到打包 bundle、安装 profile、分发发布 | 动手写插件的人 |
| [04-reference.md](./04-reference.md) | 速查：参考站点地图、仓库关键路径、内置服务/事件索引、扩展点→机制对照表、术语表 | 需要查资料的人 |

### 第二部分：Lark/飞书 调研（为 dsh-lark-bridge 插件做准备）

调研源：[github.com/larksuite/cli](https://github.com/larksuite/cli)（本地 clone，`@larksuite/cli` v1.0.87）、[larksuite/node-sdk](https://github.com/larksuite/node-sdk)（`@larksuiteoapi/node-sdk` v1.73）、[larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)、[开放平台文档](https://open.feishu.cn/document/)。

| 文档 | 内容 | 适用读者 |
|---|---|---|
| [05-lark-platform-api.md](./05-lark-platform-api.md) | Lark/飞书开放平台能力与 API 总览：应用与凭据、token/身份模型、API 形态、18+ 能力域、事件订阅机制、scope 体系、交互卡片 | 所有人（先读） |
| [06-lark-cli.md](./06-lark-cli.md) | 官方 CLI 详解：安装认证、三层命令体系、输出/错误契约、26 个 AI Agent Skills（含与 DSH skill 格式的兼容性）、事件消费子进程契约、安全设计与企业嵌入（extension/sidecar） | 采用 lark-cli 路线的人 |
| [07-lark-sdk-ecosystem.md](./07-lark-sdk-ecosystem.md) | 官方 SDK 生态：node-sdk、Go/Python/Java、lark-mcp，四种接入路径对比与关键坑 | 选型阶段 |
| [08-lark-dsh-plugin-plan.md](./08-lark-dsh-plugin-plan.md) | **DSH 集成方案**：五种方案对比（推荐 lark-cli 子进程桥 + skills vendor）、消息桥设计（收→处理→回）、会话映射、配置 schema、安全、打包分发、路线图与验证清单 | 开发 dsh-lark-bridge 的人 |
| [09-notify-plugin.md](./09-notify-plugin.md) | **停顿通知插件实现设计**（本仓库代码）：停顿检测模型（permission/question/error + Phase 2A 的 complete/stop 族/retry/stall/goodbye/watchdog）、grace 竞态与 idle 宽限、架构与两条接缝（Category/Notifier）、配置 schema、模板变量、调试清单、Phase 2A/2B/2C 路线图 | 开发/使用 dsh-lark-bridge 的人 |

## 核心结论（TL;DR）

### DeepSeek Harness

1. **DSH 是一个"Cordis 微内核 + 插件树"的 agent 运行时**。产品的一切能力（LLM 适配器、工具注册表、会话日志、agent loop 本身）都是挂载到共享上下文（`ctx`）上的插件，没有需要打补丁的特权内核——扩展方式就是把插件挂载到其他插件旁边。
2. **插件 = 导出 `apply(ctx, config)` 的 TypeScript 模块**，通过 `inject` 声明服务依赖、`ctx.on` 监听类型化事件、`ctx.effect` 注册可逆副作用；加载顺序由服务依赖决定而非配置顺序。
3. **组合而非继承**：`cordis.yml` / `cordis.patch.yml` 是插件清单；profile 叠放 bundle（组合包），patch 按 `id` 覆盖或插入行，最后写入的行生效。
4. **官方中文资料非常完整**：`docs/user/develop/`（面向插件作者的分步指南）、`docs/cordis-tutorial/`（7 章动手教程）、`docs/cordis-api/` + `docs/subsystems/*`（生成的 API/事件参考）、`docs/cookbook/`（工具/包/适配器/UI 节点编写参考）。开发插件时优先以这些生成区块为准。

### Lark → DSH 桥接

1. **lark-cli 是官方为 AI Agent 设计的 CLI**（`@larksuite/cli`）：200+ 命令覆盖 18 个业务域、26 个 AI Agent Skills、`{ok,error}` 结构化输出契约、`event consume` 事件订阅子进程契约（就绪标记 + NDJSON + 退出码）、`--dry-run`/`schema` 内省、extension/sidecar 企业嵌入——与 DSH 插件天然契合。
2. **推荐集成组合**：B（vendor 官方 skills 进 DSH skill 根目录 + 通用 `lark` 工具出能力面）+ A（`lark-cli event consume im.message.receive_v1` 子进程桥收消息、`followup` 路由到会话、发送工具回复）；C（node-sdk 原生 TS）作深度定制路线，D（lark-mcp）作快速验证。
3. **关键安全基线**：默认只接受 p2p 白名单会话、过滤 bot 自循环、`message_id` 幂等去重、禁 `kill -9`（防订阅泄漏）、凭据走 keychain/sidecar，对齐官方"bot 只做私人助手"建议。
