# 05 · Lark/飞书开放平台：功能与 API 总览

> 调研源：官方开放平台文档 <https://open.feishu.cn/document/>（国际版 <https://open.larksuite.com/>）、[larksuite/cli](https://github.com/larksuite/cli) 代码库。本文是接入 Lark 前的平台背景知识。

## 1. 平台与账号体系

- **飞书（Feishu）**：中国版，API 域名 `open.feishu.cn`；**Lark（Lark Suite）**：国际版，API 域名 `open.larksuite.com`。两者 API 形态一致，仅域名/发行渠道不同（CLI/SDK 里用 `domain` 参数区分）。
- **应用类型**：
  - **企业自建应用（Self-Build）**：只在本企业内安装使用；
  - **商店应用 / ISV 应用**：上架应用市场，每个企业各自安装（SDK 里用 `appType: ISV` 区分，调用需带 `tenant_key`）。
- **应用凭据**：App ID + App Secret（换取 token）；事件推送还有 Verification Token 与 Encrypt Key（webhook 验签/解密用）。
- **应用形态**：机器人（bot，入驻聊天）、小程序、网页应用。本桥接场景主要用**机器人**。

## 2. Token 与身份模型

| Token | 代表身份 | 获取方式 | 适用 |
|---|---|---|---|
| `tenant_access_token` | **bot（应用身份）** | App ID+Secret 换取，SDK 自动维护，约 2h 有效 | 应用级操作：发消息、进群、bot 资源 |
| `user_access_token`（UAT） | **user（用户身份）** | OAuth 2.0 授权码/设备码流程 + refresh token | 访问用户自己的资源：日历、云文档、个人邮箱 |
| `app_access_token` | 应用元信息 | 较少用 | 应用管理接口 |

关键点：**同一 API 在不同身份下语义不同**——权限检查针对"当前调用者"（bot 的群成员身份/可用范围/scope，或用户的个人权限）。同一个调用可能 user 成功而 bot 失败。

常用标识符：用户 `open_id`（`ou_` 前缀，应用维度的用户 id）/`union_id`/`user_id`；群 `chat_id`（`oc_` 前缀）；消息 `message_id`（`om_` 前缀）；话题线程 `thread_id`（`omt_` 前缀）。`receive_id_type` 参数声明收件人 id 类型（`open_id`/`user_id`/`union_id`/`email`/`chat_id`）。

## 3. API 形态

统一形态：`POST/GET /open-apis/{domain}/{version}/{resource}/{action}`，query 走 `params`，body 走 `data`，响应为：

```json
{ "code": 0, "msg": "success", "data": { ... } }   // code != 0 即失败
```

- **2500+ 个原子 API**，按业务域组织；分页用 `page_token`/`has_more`。
- 平台提供[服务端 API 全列表](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/server-api-list)、API 调试台、以及供 SDK 生成的 OpenAPI 元数据。

## 4. 能力域清单（18+ 域）

| 域 | 核心能力 |
|---|---|
| **im（即时通讯）** | 发消息（text/post/image/file/audio/video/interactive 卡片/merge_forward…）、回复与话题（thread）、建群/成员/管理员管理、群设置、消息搜索/批量拉取、已读、加急（应用内/短信/电话）、表情回复、Pin、置顶会话（feed）、媒体上传下载 |
| **contact（通讯录）** | 用户/部门/用户组搜索与详情、按姓名/邮箱/手机查人、企业通讯录 |
| **calendar（日历）** | 日程增删改查、忙闲查询、空闲时间建议、会议室查找、邀请与会人、RSVP 回复 |
| **docs（云文档）** | 创建/读取/更新/搜索文档（含 markdown 格式）、文档块操作 |
| **drive（云空间）** | 上传/下载文件、权限管理、评论、搜索 |
| **wiki（知识库）** | 知识空间、节点、文档管理 |
| **sheets（电子表格）** | 读写单元格、追加、查找、导出 |
| **base（多维表格）** | 表/字段/记录/视图/仪表盘/工作流/表单/角色权限、数据分析聚合 |
| **slides（幻灯片）** | 创建、读内容、增删页 |
| **task（任务）** | 任务增删改查、清单、子任务、评论、提醒、成员指派 |
| **approval（审批）** | 查询审批任务、同意/拒绝/转交、撤销、抄送 |
| **attendance（考勤）** | 个人打卡记录查询 |
| **mail（邮箱）** | 收发/搜索/阅读邮件、草稿、新邮件监听 |
| **minutes（妙记）** | 会议纪要元数据与 AI 产物（摘要/待办/章节）、上传音视频生成纪要、下载媒体 |
| **vc（视频会议）** | 会议记录搜索、会议纪要/录制/转写产物查询 |
| **whiteboard / board（白板/画板）** | 白板更新事件、图表 DSL 渲染 |
| **okr** | 目标/关键结果增删改查、对齐、指标与进展 |
| **application（应用）** | 机器人菜单（bot menu）、应用信息 |
| **apps（应用引擎）** | Spark/Miaoda 应用创建、发布 HTML/静态站点 |
| **ai / 其他** | 开放能力持续扩展（如 markdown 原生 .md 文件读写） |

## 5. 事件订阅机制（桥接的核心）

飞书开放平台把"平台侧变化"推送给应用，两种通道：

1. **Webhook 回调**：需要公网回调 URL；事件体加密（AES）+ 验签（Verification Token / Encrypt Key）。适合服务端部署。
2. **WebSocket 长连接**：**无需公网地址**，客户端主动连平台（适合本机/CLI/内网 agent 场景）。lark-cli 与各 SDK 均支持。

事件按 **EventKey** 订阅（如 `im.message.receive_v1`），需在开发者后台「事件与回调」开启对应事件 + 授予对应 scope，才会开始投递。常见事件族：

- IM：`im.message.receive_v1`（**收到消息**）、`im.message.message_read_v1`、`im.message.reaction.created/deleted_v1`、`im.chat.updated_v1`、`im.chat.disbanded_v1`、`im.chat.member.user/bot.added/deleted_v1`（入群/退群）、`im.chat.member.user.withdrawn_v1`
- 卡片交互：`card.action.trigger`（按钮点击/表单提交等，需开启回调配置）
- 审批：`approval.instance.status_changed_v4`、`approval.task.status_changed_v4`
- 会议/妙记：`vc.meeting.participant_meeting_started/joined/ended_v1`、`vc.note.generated_v1`、`vc.recording.recording_started/ended_v1`、`vc.recording.recording_transcript_generated_v1`、`minutes.minute.generated_v1`
- 白板：`board.whiteboard.updated_v1`；应用：`application.bot.menu_v6`；任务：`task.*`（更新类）

**消息接收事件的原始结构**（V2 信封，简化）：

```json
{ "schema": "2.0", "header": { "event_id": "...", "event_type": "im.message.receive_v1", ... },
  "event": {
    "sender": { "sender_id": { "open_id": "ou_xxx" }, "sender_type": "user" },
    "message": {
      "message_id": "om_xxx", "chat_id": "oc_xxx", "chat_type": "p2p|group",
      "message_type": "text|post|image|file|audio|video|interactive|...",
      "content": "{\"text\":\"...\"}", "create_time": "1690000000000",
      "mentions": [...], "root_id": "...", "parent_id": "...", "thread_id": "..."
    }
  }
}
```

**幂等**：用 `message_id`（而非 `event_id`）去重。content 对 text 是 `{"text":"..."}` JSON 字符串；interactive 卡片消息 content 是卡片 JSON。

## 6. 权限（Scope）体系

- **bot scope**：在开发者后台「权限管理」为应用开通（如 `im:message:readonly`、`im:message`、`im:chat:read`…），无需用户操作。
- **user scope**：经 OAuth 授权由用户授予（`calendar:calendar:read`、`docs:doc:readonly`…），可细到 `domain:resource:action`。
- 收 p2p 消息需 `im:message.p2p_msg:readonly`；收群消息需 bot 在群里且事件订阅开启。
- CLI/SDK 都会把"缺 scope"结构化地报出来（含 `missing_scopes` 与补救链接），见 06。

## 7. 交互卡片（Interactive Card）

飞书的富交互 UI：声明式 card JSON（`config`+`header`+`elements`，支持按钮/表单/下拉/日期选择），发送后用户操作触发 `card.action.trigger` 回调，可在 30 分钟内用 `interactive/v1/card/update` 更新卡片（`token` 有效 30 分钟、最多更新 2 次）。用于审批按钮、多轮表单等。lark-cli 有专门的卡片工作流（见 06 §6）。

## 8. 官方文档与调试入口

| 资源 | 地址 |
|---|---|
| 开放平台首页/文档 | <https://open.feishu.cn/document/>（国际版 <https://open.larksuite.com/>） |
| 开发者后台 | <https://open.feishu.cn/app/> |
| 服务端 API 列表 | <https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/server-api-list> |
| API 调试台 | <https://open.feishu.cn/api-explorer/> |
| MCP 集成文档 | <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction> |
| 机器人/事件订阅入门 | <https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process> |

> 小技巧：开放平台文档 URL 末尾加 `.md` 可直接取 Markdown 原文（CLI README 推荐给 AI 的用法），例如 `https://open.larksuite.com/document/.../embed-feishu-cli-in-agent.md`。
