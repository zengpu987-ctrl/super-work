# Super Work v0.0.2 — 设计与协作说明（增量）

> 本文件是 v0.0.2 的增量契约。v0.0.1 的 `docs/DESIGN.md` 仍然有效（架构、错误格式、SSE 语义不变）。
> 契约本体在 `packages/core/src`：`relay.ts`、`coordination.ts`、`insight.ts`、`memory.ts`、`workflow.ts`；
> `events.ts` / `types.ts` / `api.ts` 已同步扩展。改契约先改 core 并通知 Lead。

## 0. 本版目标（用户原话）

1. **三款中转站模型导入**：贾维斯官网、Devin、WorkBuddy（WorkBuddy 本机已登录，模型目录 50+）。
   用户选择「先做导入界面 + 预设，我稍后自己填」→ 贾维斯/Devin 做成可配置预设；WorkBuddy 本机自动导入。
2. **DSH 四功能原生导入**：计费、上下文洞察、记忆系统、工作流系统；并导入 DSH 历史数据。
3. **KIMI K3.1 Pro 优化 UI**：评审稿见 `docs/kimi-ui-review.md`，作为前端改版依据。
4. **两种顶层模式**：**并行模式**、**配合模式**。配合模式有 8 个角色槽位（发令官 / 生图 / 强推理 /
   代码实现 / 整合优化 / 建模 / Chat / 裁判），每个角色可多选模型；**未选中的角色严格不调用**。
5. **生图与建模真产出**（用户选择 A）：生图角色真的调用图像模型产出图片；建模角色产出可运行的
   Three.js 代码，并在工作台里预览。

## 1. 写作用域

| 目录 | 负责人 |
|---|---|
| `packages/core` | Lead（含 `tokens.ts` 需要时） |
| `packages/providers` | providers-dev |
| `packages/orchestrator` | orchestrator-dev |
| `packages/memory`、`packages/workflow` | systems-dev |
| `apps/server` | Lead |
| `apps/web` | web-dev |
| `docs/` | Lead（`docs/kimi-ui-review.md` 已由 Lead 生成，web 只读） |

## 2. 契约速览（core 已实现，直接 import）

```ts
// relay.ts
type RelayKind = "openai-compat" | "workbuddy";
interface RelayPreset { id,name,kind,baseUrl?,note,requiresKey,localDetect? } // RELAY_PRESETS 已含 jarvis/devin/workbuddy/custom
interface RelayModel { id,name,contextWindow?,supportsImages?,supportsReasoning?,imageGen?,creditMultiplier?,enabled }
interface RelayAccount { id,name,kind,presetId?,baseUrl,hasKey,accountLabel?,source,enabled,models,discoveredAt?,credits?,health,detail?,createdAt,updatedAt }
function relayModelToModelInfo(relay, model): ModelInfo // id = `${relay.id}::${model.id}`
function workbuddyModelToModelInfo(model): ModelInfo

// coordination.ts
type CoordRole = "commander"|"image"|"reasoning"|"coding"|"integrator"|"model3d"|"chat"|"judge";
COORD_ROLES / COORD_ROLE_BY_ID / COORD_ROLE_LABEL / COORD_EXECUTION_ORDER
interface CoordinationAssignment { role: CoordRole; participants: ParticipantSpec[] }

// events.ts（增量）
type ArtifactKind = "image" | "code3d" | "file";
interface Artifact { id,kind,title,mime?,path?,dataUrl?,text?,meta?,createdAt }
RunMode += "parallel" | "coordinate"（旧 5 种保留）
StageId += "command"|"specialist"|"integrate"|"render"|"memory"|"workflow"
RunEvent += { type:"artifact", participantId?, artifact }
RunEvent += { type:"context", participantId, stage, insight: ContextInsight }
RunOptions += { memoryContext?, memoryIds?, useMemory?, imageSize? }
RunRequest += { coordination?: CoordinationAssignment[] }
OrchestratorDeps += generateImage?(req): Promise<ImageResult>

// insight.ts
interface ContextInsight { participantId,model,stage,sections[],promptTokens,contextWindow?,utilization?,recalledMemoryIds?,injectedMemoryIds? }
interface ContextRunSummary { runId,calls[],peakPromptTokens,peakUtilization?,tightest?,totalPromptTokens }
interface ModelPrice { provider,model,currency,inputPerMTokens,outputPerMTokens,cachedInputPerMTokens?,creditMultiplier?,updatedAt? }
interface CostBreakdown / BillingModelRow / BillingWindow / BillingSummary
interface DshLedgerRow

// memory.ts
type MemoryKind = "fact"|"preference"|"decision"|"insight";
interface MemorySpace / MemoryEntry / MemoryHit / MemoryStats / DshMemorySeed + create/update request 类型

// workflow.ts
interface WorkflowStep { id,name,model?,role?,instruction,input:"command"|"previous"|"all",parallelGroup?,outputMode?,maxOutputChars? }
interface WorkflowDef / WorkflowStepRun / WorkflowRun / WorkflowCreateRequest / WorkflowRunRequest
BUILTIN_WORKFLOWS（两个内置模板）
```

## 3. Providers（providers-dev）

导出（`packages/providers/src/index.ts` 增加）：

```ts
export function discoverRelayModels(baseUrl: string, apiKey: string, extraHeaders?): Promise<ModelInfo[]>;
// createAdapter("relay", { baseUrl }) 走 OpenAI 兼容；model 由 server 传 remoteId
// createAdapter("workbuddy") 实现 listModels / chat / validate / generateImage
```

**WorkBuddy 协议（本机实测可用）**

- 凭证形态（server 会这样传）：
  ```ts
  { provider:"workbuddy", mode:"token", baseUrl:"https://copilot.tencent.com",
    pasted:{ access:<accessToken>, extraHeaders:{ "X-User-Id":<uid>, "X-Domain":<domain> } } }
  ```
- 模型目录：`GET https://www.codebuddy.cn/v2/enterprises/personal/models`（Bearer），
  返回含 `id/name/contextWindow/supportsImages/reasoning` 的条目；视频/生图模型带 tag
  （`hunyuan-image-alpha` 为文生图）。国际区 base 取 vault 的 `domain`，chatBase 为 `https://www.workbuddy.ai`。
- 对话：`POST {chatBase}/v2/chat/completions`，OpenAI 兼容 SSE（content + **reasoning_content**）。
  必需头：`Authorization: Bearer`、`X-Product: SaaS`、`X-User-Id`、`X-Domain`、
  `X-Conversation-ID`/`X-Conversation-Request-ID`/`X-Conversation-Message-ID`（随机 uuid）、
  `X-Requested-With: XMLHttpRequest`、`Origin/Referer` 为站点、UA 仿官方客户端。
  **首条消息必须是 system**（没有就补一条占位）。
- 生图：`POST {chatBase}/v2/images/generations`，body `{model,prompt,size,n}`；
  解析 `data.data[0].url | b64_json`，`data.usage.credit` 为积分消耗。
- 刷新：`POST https://www.codebuddy.cn/v2/plugin/auth/token/refresh`（细节见插件源码）。
- 参考源码：`~/.dsh/profiles/desktop/node_modules/dsh-connect-workbuddy/lib/host-heartbeat-D1N-f8Q6.js`

**Relay（openai-compat）**：`GET {baseUrl}/models` 发现模型（兼容 `{data:[]}` / 数组 / `{data:{data:[]}}`）；
chat 用现有 openai-compat 实现；401/403 抛可读 `ProviderHttpError`。

## 4. Orchestrator（orchestrator-dev）

新增 `parallel`、`coordinate` 两种模式（旧模式保持不动）。

- **parallel**：全员并行独立作答 → 若 judge 存在则裁判综合（final 流式），否则按顺序拼接各答案作为最终答案
  （options.synthesize === false 时也拼接）。阶段 fanout / synthesis。
- **coordinate**（严格按 `coordination` 里的角色；空或未出现的角色 0 次调用，测试必须证明）：
  1. `command`：commander 并行产出「任务分解 + 验收标准 + 给各角色的明确指令」。
     多个 commander 时先并行再合并成一份执行简报（合并可在 orchestrator 端拼接）。
  2. `specialist`：reasoning / coding / model3d / chat 并行执行；image 角色走
     `deps.generateImage({provider, model, prompt, size})` 直接出图并 emit artifact。
     无 commander 时直接用用户命令（notice 说明）。
  3. `integrate`：integrator 顺序接力（后一位看到前一位草稿）；无 integrator 则拼接各角色产出。
  4. `judge`：judge 顺序裁决，最终答案=最后一个 judge 的输出；无 judge 则用整合稿。
  5. 代码/建模产物：输出含 ```html 或 ```js 代码块时提取为 artifact(kind="code3d", text=代码,
     title=`${role}-${step}`)，emit artifact 事件 ×1。
- **上下文洞察**：每次 chat 调用前 emit `context` 事件，`sections` 至少包含
  system / command / memory / reference / history（估算 token，用 core 的 `estimateTokens`，若 core 没有就新增
  `packages/core/src/tokens.ts` 并导出）。
- memoryContext 注入 commander 与 specialist 的 system prompt。

## 5. Systems（systems-dev）

### `packages/memory`

```ts
export class MemoryStore {
  constructor(dbFile: string);            // 自己建表，FTS5 + 回退 LIKE
  init(): void;                            // 建表 + 默认空间 + 内置示例记忆（可关闭）
  spaces(): MemorySpace[];
  createSpace(name, description?): MemorySpace;
  updateSpace(id, patch): MemorySpace | undefined;
  deleteSpace(id): boolean;
  add(input: MemoryCreateRequest, spaceId?): MemoryEntry;
  update(id, patch: MemoryUpdateRequest): MemoryEntry | undefined;
  remove(id): boolean;
  list(opts?: {spaceId?, kind?, enabled?, limit?, offset?}): MemoryEntry[];
  search(query: string, limit?: number): MemoryHit[];   // 中文可用：FTS5 unicode61 + LIKE 混合排序
  markUsed(ids: string[]): void;
  stats(): MemoryStats;
  importSeed(seed: DshMemorySeed): number;  // 去重（content hash）
  exportSeed(): DshMemorySeed;
  close(): void;
}
export function buildMemoryContext(hits: MemoryHit[], limit?: number): string; // 注入 prompt 的文本
```

数据文件由 server 指定：`~/.super-work/memory.db`。测试用 `:memory:` 或临时文件。

### `packages/workflow`

```ts
export interface WorkflowDeps {
  callModel(req: { provider, model, relayId?, system?, messages, maxTokens?, temperature?,
                   reasoning?, signal? }): AsyncIterable<{type:"text"|"reasoning",text}|{type:"usage",usage}>;
}
export async function runWorkflow(
  def: WorkflowDef, command: string,
  deps: WorkflowDeps,
  onEvent: (ev: RunEvent) => void,
  options?: { stepIds?: string[]; signal?: AbortSignal; runId?: string },
): Promise<{ finalText: string; steps: WorkflowStepRun[]; usage: Usage }>;
```

执行语义：按 `parallelGroup` 分组（undefined 视为独占组，保持声明顺序），组内并行、组间串行；
`input`: command=原始命令 / previous=上一组全部输出 / all=到目前为止全部输出；
步骤失败只标记该步 error 并继续；最后一步输出即 finalText（若最后一步失败，取最近成功步）。

## 6. Server（Lead）

### 6.1 新增数据与接口

中转站：`GET/POST /api/relays`、`PUT/DELETE /api/relays/:id`、`POST /api/relays/:id/discover`、
`POST /api/relays/:id/test`、`GET /api/relays/presets`、
`GET /api/relays/local/workbuddy`（检测本机账号）、`POST /api/relays/local/workbuddy/import`。

计费：`GET /api/billing/summary`、`GET/PUT /api/billing/prices`、`POST /api/billing/import-dsh`、
`GET /api/billing/export.csv`。

上下文：`GET /api/runs/:id/context`。

记忆：`GET /api/memory/stats`、`GET/POST /api/memory/spaces`、`PATCH/DELETE /api/memory/spaces/:id`、
`GET/POST /api/memory/entries`、`PATCH/DELETE /api/memory/entries/:id`、`POST /api/memory/search`、
`POST /api/memory/import-dsh`、`GET /api/memory/export`。

工作流：`GET/POST /api/workflows`、`PUT/DELETE /api/workflows/:id`、`POST /api/workflows/:id/run`、
`GET /api/workflow-runs`、`GET /api/workflow-runs/:id`、`GET /api/workflow-runs/:id/stream`。

产物：`GET /api/artifacts/:runId/:file`（图片/代码文件）。图片保存到 `~/.super-work/artifacts/<runId>/`。

`POST /api/runs` 现在接受 `mode: "parallel" | "coordinate"`、`coordination`、`options.useMemory`。
`/api/models` 会返回已导入的 relay / workbuddy 模型（`available` 按账号健康度）。

### 6.2 凭证解析

- `provider="relay"`：模型 id 形如 `relay_xxx::gpt-4o`，server 解析出 relay 账号，构造
  `Credential{provider:"relay", mode:"api-key", apiKey, baseUrl}`，调用时 model 传 `remoteId`。
- `provider="workbuddy"`：从 WorkBuddy relay 账号（kind=workbuddy）构造凭证（见 §3）。
- 生图：`registry.generateImage(provider, model, prompt, size)`，仅 workbuddy 支持；无能力时给可读错误。

## 7. Web（web-dev）

依据 `docs/kimi-ui-review.md` 做重设计，同时落地：

1. 顶栏下新增工作台工具条：左侧「并行 / 配合」分段控件；配合模式右侧显示角色槽位入口。
2. 右栏改双页签：「编排 / 上下文」。
3. 角色编排：8 个角色两行紧凑列表；每行显示角色名、已选模型数、开/关；点击展开模型多选；
   **空槽明确显示「未配置 · 不会调用」**；实时预估调用次数与成本；提供清空。
4. 参与模型池支持 relay 分组（站点名）与 WorkBuddy 分组（显示积分倍率）。
5. 设置新增「中转站」页：三张预设卡（贾维斯官网 / Devin / WorkBuddy）+ 自定义；WorkBuddy 显示本机账号检测与一键导入；其余填 Base URL + Key 后「测试并拉取模型」→ 勾选导入。
6. 新页面（顶栏「资源」菜单进入，不挤首屏）：
   - 计费：今日/本月/累计、按模型表、30 天柱状、价格表编辑、导入 DSH、导出 CSV；
   - 记忆：空间列表 + 条目增删改查 + 搜索 + 导入 DSH + 开关；
   - 工作流：列表、内置模板、步骤编辑器（角色/模型/指令/并行组/输入来源）、运行与步骤结果查看、从运行保存为工作流。
7. 最终答案卡升级为产物容器：页签「答案 / 图片 n / 代码 n」；图片网格 + 灯箱；3D 代码「代码 / 预览」
   （预览用本地 `/vendor/three.min.js`，iframe 沙箱）。
8. 上下文洞察：右栏「上下文」页签按调用列出 system/命令/记忆/参考 的 token 堆叠条 + 窗口占用；
   可在运行结束后从 `/api/runs/:id/context` 拉取。
9. 记忆召回：命令台提供「使用记忆」开关；运行详情显示本次注入的记忆条目。
10. 响应式：1440 三栏；1200 左栏图标化；1024 右栏抽屉；全部中文、离线、无外部 CDN。

## 8. 验证

- `pnpm build`（core → providers/orchestrator/memory/workflow → server）与 `pnpm build:web` 必须通过；
- `pnpm test` 全部包单测通过；`pnpm smoke` 通过；
- 真实链路：
  1. 设置中检测 WorkBuddy 本机账号 → 导入 → 模型列表出现 Kimi-K3.1-Pro 等 → 用 WorkBuddy Kimi 跑一次并行；
  2. 配合模式：只选 发令官=WorkBuddy Kimi、强推理=DeepSeek、代码实现=Kimi、裁判=DeepSeek，
     验证未选角色 0 调用、最终答案有裁判痕迹；
  3. 生图角色用 WorkBuddy `hunyuan-image-alpha` 真出一张图，UI 可见；
  4. 建模角色产出 Three.js 代码并在预览里跑起来；
  5. 计费/上下文/记忆/工作流四个面板有真实数据；记忆召回注入在运行详情可见。
