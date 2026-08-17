# 11 · 通知测试脚本（dsh-lark-bridge 验收/回归）

> 本文提供一份**可直接粘贴给 DSH** 的测试脚本：逐步骤触发插件的各类停顿/停机场景，
> 让使用者在飞书里逐条核对通知。各类别的检测模型与去噪规则见 [09-notify-plugin.md](./09-notify-plugin.md)，
> 安装与配置见 [README](../README.md)。

## 1. 怎么用

1. （可选）按 §2 做测试前准备（缩短 stall 判定、hook、watchdog 等）；
2. 完成插件配置（`/lark-notify setup` 或设置面板填好 chatId），重启 DSH；
3. **新开一个会话**，把 §3 的脚本原样粘贴提交；
4. 按 §4 对照表逐条核对飞书通知。

两条铁律（违反会导致「明明停了却没通知」的假阴性）：

- **每步之间至少等 6–8 秒**，先看到飞书通知、再发下一条指令。否则：
  complete 的 5s idle 宽限会被下一步的唤醒取消；question/permission 的 0.5s grace
  窗口会因秒答/机器审批去噪。
- **complete 每会话 30 分钟只通知一次**——因此脚本把 complete 放在第 1 步；
  之后各步的轮次即使以 completed 收尾，也不会再刷屏（预期静默，不算失败）。

## 2. 测试前准备（按需）

### 2.1 缩短 stall 判定（第 6 步用，默认 10 分钟太久）

在 profile 的 `cordis.patch.yml` 覆盖插件行（patch 按 `id` 整行替换 config，
其余类别会回到 schema 默认值，若你有自定义项请一并带上）：

```yaml
- id: dsh-lark-notify
  name: 'dsh-lark-bridge'
  config:
    categories:
      stall: { stallMs: 60000, repeatMs: 120000 }   # 1 分钟判定、2 分钟重复提醒
```

### 2.2 stop:blocked 的 hook 配方（进阶场景 A 用）

见 §5-A：需要 codex/claude-code hooks 的 `UserPromptSubmit` 拒绝点。

### 2.3 watchdog（进阶场景 E 用）

```yaml
- id: dsh-lark-notify
  name: 'dsh-lark-bridge'
  config:
    watchdog: { enabled: true, heartbeatFile: '/tmp/dsh-lark-heartbeat' }
```

然后运行进程外监督者（另开一个终端）：

```sh
node scripts/lark-watchdog.mjs --heartbeat-file /tmp/dsh-lark-heartbeat \
  --stale-ms 60000 --chat-id oc_xxx --once    # cron/systemd timer 模式；或去掉 --once 常驻
```

## 3. 核心测试脚本（原样粘贴给 DSH）

```text
你将执行 dsh-lark-bridge 通知测试。严格一次执行一步，每步结束自然收尾本轮，
并输出「⏸ 第 N 步结束——请核对飞书通知后再发下一条指令」。不要合并步骤、不要抢跑。

第 1 步（complete 任务完成）：只回复一句话「✅ 通知测试：任务完成」，
不调用任何工具、不提问、不展开。

第 2 步（question 提问）：调用 ask_user_question 工具：header 填「通知测试」，
问题填「请选择接下来的测试方式：」，选项两个：「A. 继续下一步」（描述：
依次测试权限申请等场景）与「B. 结束测试」。提出后停下等待回答；请先提醒使用者：
等飞书收到「❓」通知后再回答（0.5 秒内秒答会被宽限期去噪、不发通知）。

第 3 步（permission 权限申请）：执行命令 `echo dsh-lark-notify-test > /etc/dsh-lark-notify-test-marker`
（写入工作区外，必然触发权限审批；若你的环境对该路径无需审批，换成任何必然需要审批的操作）。
不要绕过审批、不要自行放弃；提醒使用者：飞书收到「🔔 DSH 权限申请」后，再回 DSH 批准。

第 4 步（goal blocked 归因素材）：使用 goal 工具：先 create_goal（objective 填
「通知测试目标」），随后立即 update_goal 将其标记为 blocked，blocked_reason 填
「dsh-lark-bridge 测试：模拟目标阻塞」。结束本轮。
（说明：本轮以 completed 收尾，complete 通知已被第 1 步节流，通常不再收到新通知，
属预期；此步是为进阶场景 A 的 stop:blocked 通知准备 blocked_reason 素材。）

第 5 步（stop:aborted 反例验证）：从 1 开始连续输出数字，直到被打断。
提醒使用者：在你持续输出时点击 DSH 的「停止」。预期：飞书不收到任何新通知
（user 中止按设计抑制）；若收到「🛑」说明需要排查。

第 6 步（stall 停滞，需先按文档 §2.1 调小 stallMs）：执行 `sleep 180` 并等待完成，
期间不要输出任何内容。预期：停滞判定时间到达时飞书收到「⏳ DSH 长时间无进展」。

全部步骤完成后回复「测试脚本执行完毕」并结束。
```

## 4. 预期通知对照表

| 步骤 | 通知类别 | 飞书消息特征 | 时机 | 静默条件 / 注意 |
|---|---|---|---|---|
| 1 | `complete` | `✅ DSH 任务完成` | 轮次结束、agent 进 idle 后约 5s | 5s 内发下一条消息会取消；同会话 30min 内不再重复 |
| 2 | `question` | `❓` + header/问题/选项列表 | 提问后约 0.5s（grace 后） | 0.5s 内回答 → 静默（宽限期去噪） |
| 3 | `permission` | `🔔 DSH 权限申请` + 工具名/原因 | ~1s 内 | 机器秒批（ACP/`never` 策略）→ 静默 |
| 4 | —（素材） | 无新通知 | — | 轮次以 completed 收尾且 complete 已被节流，属预期 |
| 5 | 反例 | **不应**收到 `🛑` | — | `user`/`parent` 中止按设计抑制 |
| 6 | `stall` | `⏳ DSH 长时间无进展` + 停滞分钟数 | `stallMs` 后（扫描间隔 = min(stallMs/4, 60s)） | agent 不在 `running` 不判定；`repeatMs` 重复提醒 |

## 5. 进阶场景（需要环境配合）

### A. `stop:blocked`（`🚫 DSH 目标阻塞`）

真实触发条件是 `turn/end {kind:'blocked'}` = **预步骤被拒绝**（对 DSH 源码核实：
`agent/pre-step` 返回 `reject` 时 loop 以 `blocked` 收尾）。直接 `update_goal blocked`
的轮次以 `completed` 收尾（即第 4 步），不会单独发 `🚫`——它负责留下 `blocked_reason`
素材。配方：

1. 配置 codex hooks（`hooks-codex` 插件）：`configPath` 指向含 `[hooks]` 的配置，
   其中 `UserPromptSubmit` 命令在 prompt 含触发词 `BLOCK-ME` 时按 codex 协议
   `exit 2` 拒绝（claude-code hooks 同理）；
2. 先执行第 4 步（写入 blocked_reason 素材）；
3. 发送消息「BLOCK-ME 测试预步骤拒绝」→ 预步骤拒绝 → 轮次以 `blocked` 收尾 →
   idle 宽限后收到 `🚫`，原因显示第 4 步的 `blocked_reason`（无素材时回退为通用文案）。

### B. `stop:max-tokens`（`✂️ DSH 输出达到令牌上限`）

把会话的输出上限调小（如 64 tokens），再让它输出长文本（如第 5 步的数数任务）。
步骤触顶被截断、轮次以 `max-tokens` 收尾 → idle 宽限后通知。

### C. `retry`（`🔁 DSH 正在重试模型请求`）

把 provider 临时指向会 5xx 的地址（如本地未监听端口）+ 正常 `retryPolicy`：
请求失败进入退避，第 `retryThreshold`（默认 2）次起通知（含重试次数/退避秒数/错误码），
`intervalMs` 间隔节流。恢复 provider 配置后通知自然停止。

### D. `error`（`⚠️ DSH 会话出错停止`，V1 已实现）

把 model 名临时改错（不可重试的 4xx）再发消息：轮次以致命错误收尾 → 立即通知（无宽限）。

### E. `watchdog`（`💀 DSH 进程死亡`）

按 §2.3 开启心跳并运行监督者后，`kill -9` DSH 进程：心跳超时（`--stale-ms`）即发通知，
重复告警按 `--repeat-ms` 去重。正常退出（Ctrl+C）则由 `goodbye` 发 `👋 DSH 已正常退出`
（仅整个应用树卸载时，插件 HMR/重载不误报）。

### F. `stop:interrupted`（无法手工触发）

崩溃孤儿轮闭合事件在会话**加载（seed）期**生成、不进 live 广播，手工会话无法触发；
进程死亡场景由 E 的 watchdog 通知兜底（设计如此，见 09 §7.1）。

## 6. 「没收到通知」排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 提问/权限没通知 | 0.5s grace 窗口内被秒答/机器秒批 | 等通知到了再回答/批准 |
| 任务完成没通知 | 轮次结束 5s 内发了下一条消息（idle 宽限被取消） | 等 6–8s 再继续；goal 自动续轮/`/loop` 同理 |
| 连续完成只通知一次 | complete 每会话 30min 节流 | 换新会话测试 |
| 用户点停止没通知 | `user`/`parent` 中止按设计抑制 | 属预期（反例验证） |
| 任何通知都没有 | 目标未配置 / dryRun / lark-cli 认证失效 | `/lark-notify status` 逐项检查 |
| 同类别 3s 内第二次不通知 | 每会话×类别 debounce | 属预期去重 |
| 子代理任务完成没通知 | complete/stop 族跳过 `origin:'subagent'` 子会话 | 属预期（避免多代理刷屏） |
