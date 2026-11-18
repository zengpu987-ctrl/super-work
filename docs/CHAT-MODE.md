# Chat 模式（单模型多轮对话 + 与团队互通）

> 2026-11-19。截图：[chat-mode.png](screenshots/chat-mode.png)。

## 1. 定位

工具条模式分段新增第三个模式 **Chat**（并行 / 配合 / Chat）：

- **每次只能选择一个模型**：右栏「Chat 模型」单选；服务端强校验（>1 个模型直接 400）。
- **像聊天一样多轮**：每条消息是一轮（`RunMode = "chat"` 的一次运行），沿用多轮对话的
  `threadId` 与历史注入，前几轮的命令 + 最终答案会作为 user/assistant 消息带入。
- **档位可调**：命令台与画布头部都有 5 档选择器；运行中改档走现有 `/api/runs/:id/effort`，
  下一轮沿用最后选择的档位（持久化在 `superwork.chatModel.v1`）。
- **与工作模式配合**：
  - Chat → 团队：画布「交给团队」或右栏「并行接手 / 配合接手」；模式切到目标模式，
    保留当前工作线程，下一条命令由团队接着做（带 Chat 历史）。
  - 团队 → Chat：工作运行结果头部的「用 Chat 继续」；模式切到 Chat，默认用裁判（无裁判时第一位
    参与者）接话，保留工作线程，下一条消息由单模型继续（带团队历史）。

## 2. 实现

- **core**：`RunMode` 增加 `"chat"`、`RUN_MODE_META.chat`、`StageId` 增加 `"chat"`。
- **orchestrator**：新增 `modes/chat.ts`：单参与者 + `streamFinal`，最终答案就是模型回复
  （不加 `### 模型` 标题）；历史注入与档位透传复用 `RunContext.call`；阶段条 `CHAT_STAGE_SLOTS`。
- **server**：`createRun` 校验 Chat 只有一个模型、禁止配合编排、不参与裁判逻辑；其余线程 /
  历史 / 预算 / 计费路径复用。
- **web**：
  - `useWorkbench`：`chatModel` 状态与持久化、进入 Chat 自动选第一个可用模型、
    `handoffToChat` / `handoffToTeam`；`startRun` 在 Chat 下用单模型并校验。
  - 工具条第三段、右栏「Chat 模型」单选面板（模型池 `singleSelect`）、命令台「发送」文案、
    档位选择器、第 N 轮继续。
  - 新增 `ChatView`：用户气泡 + 模型气泡、模型头（官方图标 / 档位 / 状态 / 停止 / 交给团队 /
    重新生成）、底部 token 与输入输出统计；历史轮次沿用折叠卡。
- **设备码**（同批修复）：Kimi 设备码登录开始时把设备码与验证地址打印到启动终端
  （`apps/server/src/auth/flows.ts`），UI 文案改为「设备码（启动终端也会显示）」。

## 3. 验证

- `pnpm build:all` 全绿；`pnpm test` **167 项全过**（新增 2 项 Chat 单测：单模型直出、历史 + 档位）。
- API：`mode=chat` 两个模型 → 400「Chat 模式每次只能选择一个模型」；一个模型 → 运行创建成功。
- Headless Edge 实测：切到 Chat → 单选 Demo Fast → 发送 → 用户/模型两个气泡、档位选择器、
  上下文条、历史工作记录均为 Chat；点「交给团队」后模式切到并行且无控制台报错。
- 终端实测：`POST /api/providers/kimi/auth/start` 后启动终端打印设备码与验证地址。
