# 07 · Lark 官方 SDK 生态与 MCP

> 调研源：[larksuite/node-sdk](https://github.com/larksuite/node-sdk)（npm `@larksuiteoapi/node-sdk` v1.73.0）、[larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)（npm `@larksuiteoapi/lark-mcp`，Beta）、开放平台文档。选择适合 DSH 插件（TypeScript host 插件）的接入路径用。

## 1. 官方 SDK 全家桶

| 语言/形态 | 包/仓库 | 说明 |
|---|---|---|
| **Node.js（经典版）** | npm `@larksuiteoapi/node-sdk`（repo `larksuite/node-sdk`） | 服务端 SDK：token 自动管理、语义化调用、事件订阅（webhook+websocket）、加解密、卡片支持；提供 ESM/CJS + 完整类型 |
| Go | `github.com/larksuite/oapi-sdk-go/v3` | lark-cli 自身就是 Go 生态的产物 |
| Python | `larksuite/oapi-sdk-python`（新版 pyoapi） | |
| Java | `larksuite/oapi-sdk-java` | |
| **CLI** | npm `@larksuite/cli`（repo `larksuite/cli`） | 见 06；200+ 命令 + skills + 事件消费 |
| **MCP** | npm `@larksuiteoapi/lark-mcp`（Beta，repo `larksuite/lark-openapi-mcp`） | 把飞书 API 封装为 MCP 工具；另有官方**托管 MCP 服务**（`mcp.larksuite.com`，免部署） |

## 2. node-sdk 用法（原生 TS 插件路线的核心）

```typescript
import * as lark from '@larksuiteoapi/node-sdk';

// 自建应用
const client = new lark.Client({
  appId: 'cli_xxx',
  appSecret: 'xxx',
  appType: lark.AppType.SelfBuild,   // ISV 用 lark.AppType.ISV（需 tenant_key）
  domain: lark.Domain.Feishu,        // 或 lark.Domain.Lark（国际版）
});

// 语义化调用：client.<业务域>.<资源>.<方法>({ params, data })
const res = await client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: 'oc_xxx',
    content: JSON.stringify({ text: 'hello world' }),
    msg_type: 'text',
  },
});
```

SDK 负责的繁琐部分：tenant/user token 的获取与刷新缓存、请求签名（webhook 验签）与事件加解密、类型提示（每个 API 完整参数/响应类型）。事件侧提供 dispatcher/websocket 客户端（长连接事件订阅），webhook 模式提供 `EventDispatcher` + `AESCipher`。

## 3. lark-mcp（MCP 服务器）

```json
// MCP Client 配置（Cursor/Trae 等）
{
  "mcpServers": {
    "lark-mcp": {
      "command": "npx",
      "args": ["-y", "@larksuiteoapi/lark-mcp", "mcp", "-a", "<app_id>", "-s", "<app_secret>"]
    }
  }
}
```

- **bot 身份**：仅凭 app_id/app_secret 即可调用（tenant_access_token）。
- **user 身份**：先跑一次 `login` 保存令牌，后续客户端复用。
- 另附 `recall-mcp`（开发文档检索 MCP，帮 AI 查飞书 API 文档）。
- 官方还提供**托管 MCP 服务**：配置远程 MCP 地址即可，免本地部署（见[官方 MCP 介绍](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction)）。
- Beta 阶段：接口可能变化。

## 4. 接入路径对比（DSH 视角）

| 维度 | A. lark-cli 子进程 | B. node-sdk 原生 TS | C. lark-mcp | D. 手写 OpenAPI |
|---|---|---|---|---|
| 语言/依赖 | 外部 Go 二进制（npm 安装） | 纯 TS 依赖 | 外部 npx 进程（Node） | 无依赖，工作量大 |
| 功能覆盖 | 18 域 200+ 命令 + 26 skills + 事件消费 | 全量 API（语义化）+ 事件 | 全量 API（MCP 工具集） | 自选 |
| Token/scope 管理 | CLI 内置（keychain/登录流/`--as` 身份） | SDK 自动 | MCP 自动 | 自实现 |
| 事件接收 | `event consume` NDJSON + 就绪标记（为子进程设计） | websocket 客户端 + dispatcher | 取决于 MCP 工具（较弱） | 自实现 |
| AI 亲和度 | 极高（输出契约/错误信封/affordance/skills 全为 Agent 设计） | 中（需自己设计工具层） | 高（MCP 原生工具语义） | 低 |
| 可控性/审计 | 高（extension/sidecar/命令面限制） | 高（代码在自己手里） | 中 | 高 |
| 企业集中凭据 | sidecar 代理 | 自集成凭据中心 | 受 MCP 配置限制 | 自实现 |
| 稳定性 | 活跃迭代（v1.0.87，2026-08） | 成熟（v1.73） | **Beta** | — |

**结论**：消息桥/工具层优先 A（lark-cli），深度定制与原生集成用 B，快速验证用 C，不建议 D。08 给出具体组合方案。

## 5. 各路径的关键坑

- **node-sdk 的事件**：websocket 长连接需处理断线重连与"事件重复投递"（消息去重键 `message_id`）；webhook 模式要处理加解密与验签超时。
- **MCP 的 user 身份**：需要一次性登录流（浏览器授权），headless 部署麻烦；Beta 接口不稳定。
- **lark-cli 的事件**：详见 06 §6 子进程契约（ready 标记、stdin EOF、退出码、禁 kill -9）。
- 三者的共同前提：开发者后台开通事件订阅 + 权限 scope；p2p 消息需 `im:message.p2p_msg:readonly`，群消息需 bot 在群内。
