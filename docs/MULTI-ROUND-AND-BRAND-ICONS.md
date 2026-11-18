# 多轮工作对话 + 官方模型图标（v0.0.3 增量）

> 本文记录两项增量的契约与验收；与 `docs/DESIGN-v0.0.3.md` 并行，不改动其中已冻结的部分。
> 截图：[26-v3-multi-round](screenshots/26-v3-multi-round.png)、
> [27-v3-round3-context](screenshots/27-v3-round3-context.png)、
> [28-v3-brand-icons](screenshots/28-v3-brand-icons.png)。

## 1. 一个工作 = 一条多轮对话线

### 数据与契约（`packages/core`）

- `RunDetail` / `RunListItem` 增加 `threadId`、`round`；`RunDetail` 增加
  `history?: { rounds, tokens, truncated }`（本次注入了前几轮、估算 token、是否截断）。
- `CreateRunRequest.threadId?`：带上即“继续这个工作的下一轮”；不带则新建工作
  （新工作的 `threadId` 等于第一轮 run id，`round = 1`）。
- 新查询类型：`ThreadSummary`（轮数、最后一轮状态、累计 usage/cost、预览）与
  `ThreadDetail`（摘要 + 按轮次升序的 `RunDetail[]`）。
- `RunOptions.conversation?: ConversationTurn[]` + `conversationTruncated?`：
  server 按预算组装，orchestrator 以 **user/assistant 消息**注入每一次模型调用，
  同时把同一份文本计入上下文洞察的 `history` 段。

### 服务端（`apps/server`）

- `runs` 表新增 `thread_id`、`round_index`（`ensureColumn` 自动迁移历史库）；
  旧运行（v0.0.2 无 thread_id）视为各自独立的工作，被续聊时自动归入自己。
- 创建运行时：
  - `threadId` 存在 → 校验工作存在，轮次 = 已有最大轮次 + 1；
  - 按最紧模型的上下文窗口取 55% 作为历史预算（下限 4k、上限 600k token），
    从最新一轮往前装，装不下丢更旧轮次；最新一轮本身超预算时截断正文并标记 `truncated`；
  - 历史只取每轮的命令与最终答案（不重复注入每个模型的作答，省 token）。
- 新接口：`GET /api/threads?limit=30`、`GET /api/threads/:id`（摘要 + 全部轮次）。
- 上下文洞察：`history` 段计入实际注入的历史文本（单测断言 > 0）。

### 前端（`apps/web`）

- 左栏「工作记录」按工作展示：轮数、状态、模型数、累计 token，点击一次还原全部轮次
  （`GET /api/threads/:id` → 前几轮折叠卡 + 当前轮）。
- 运行画布顶部堆叠「对话历史」：每轮显示第几轮、模式、完成数/耗时、命令、最终答案
  （6 行折叠、可展开全文）、token；「过程」可展开该轮各模型卡片。
- 当前轮头部显示「第 N 轮」「带 N 轮历史（截断）」，命令台按钮变为「继续第 N 轮」。
- 命令台运行：当前有工作 → 自动带 `threadId` 续轮；「＋」新建工作清空对话；
  「重新运行 / 重新综合 / 演示」强制开新工作。

## 2. 对话底部的上下文占用比例

- 常驻在命令台上方（对话底部）的 `ContextBar`：
  - 百分比 = 本轮单次调用的提示词 token ÷ 参与模型里**最紧**的上下文窗口；
  - 堆叠条按 `system / command / memory / reference / history / output` 分段着色；
  - 显示 `tokens / window`、最紧模型名、当前轮次与注入历史轮数；
  - 70% 变黄、85% 变红；运行中实时更新，运行结束后从 `/api/runs/:id/context` 回读；
  - 「洞察」跳到右栏「上下文洞察」，看每次调用的细分。
- 分母来源：每次调用的 `ContextInsight.contextWindow`（core 模型目录）；
  无数据时显示「—」，不伪造 0%。

## 3. 官方模型图标

- 新增 `BrandIcon` 组件 + `apps/web/public/brand/*.svg`（11 个官方标记，本地打包、离线可用；
  来源 `@lobehub/icons-static-svg`，MIT，署名见 `apps/web/public/brand/NOTICE.md`）。
- 浅色小底片承托官方原色：Kimi / OpenAI / Grok 等含黑色笔画，直接放深色面板不可见。
- 覆盖位置：左栏模型连接、参与模型卡、模型池分组与模型行、编排已选行与角色模型行、
  参与模型选择器、设置页 provider 列表与页头、命令区 chips。
- 中转站 / 第三方 / 演示模型无官方商标，用字形兜底（链接 / 地球 / 星芒）。

## 4. 验收记录（2026-11-19）

- `pnpm build:all`：tsc -b 全绿；vite build 通过（CSS 159.33 kB / JS 551.04 kB）。
- `pnpm test`：163 项全绿（含新增 2 项多轮对话 orchestrator 单测 + 2 项服务端 thread 单测）。
- 新增服务端单测 2 项：`thread_id/round_index` 落库与按轮次读取、v0.0.2 历史运行归入工作。
- 隔离实例（`SUPER_WORK_HOME=/tmp/sw-thread-test`，mock 模型）端到端实测：
  - 第 1 轮 `threadId=run_xxx, round=1`；
  - 第 2 轮带 `threadId` → `round=2`、`history={rounds:1,tokens:94}`；
  - `GET /api/threads` → 1 个工作、2 轮；
  - `GET /api/runs/:id/context` → `history` 段 100 token，utilization 已计算。
- Headless Edge（1440×900）实测：
  - 打开工作 → 第 1 轮折叠卡 + 当前第 2 轮 + 上下文条「1.1% · 345/32k · 第 2 轮 · 带 1 轮历史」；
  - 命令台继续第 3 轮 → 服务端落成第 3 轮，界面显示「第 3 轮 · 带 2 轮历史」；
  - 设置页 11 个 provider 图标与页头大图标正常，无控制台报错。
