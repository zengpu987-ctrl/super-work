# Super Work v0.0.1 — 设计与协作说明

> 本文件是四个实现面（server / providers / orchestrator / web）之间唯一的协作契约。
> 契约本体在 `packages/core/src`，本文件解释"为什么"和"怎么接"。
> 修改契约必须先改 `packages/core` 并通知 Lead；不要在各自包里私自定义字段。

## 1. 产品意图

用户在浏览器里打开一个本机网站（Super Work），输入一句命令，**多家大模型同时/接力/互相批判**，
最后由一个"总协调模型"把多方结论综合成一份可用的最终答案。用户能看见每个模型在说什么、
谁在什么阶段发言、各自花了多少 token。

v0.0.1 必须做到：

- 11 家大模型接入：DeepSeek、KIMI、GPT/OpenAI、Claude、GLM、千问、火山引擎、MiniMax、Gemini、Grok、第三方 OpenAI 兼容端点；
- 两种凭证都可用：API key，以及订阅账户（官方 OAuth / 设备码 / 复用本机已登录凭证 / 粘贴 token）；
- 5 种联合工作模式：议会、辩论、接力、投票、自动调度；
- 流式输出、运行历史、参与模型可视化、token 统计；
- 完全没有 key 也能跑：内置 mock 演示模型，保证第一次打开就能看到联合工作效果。

非目标（v0.0.1 不做）：多用户/云端部署、计费、工具调用（function calling）、文件上传、图片生成、移动端深度适配。

## 2. 目录与职责（写作用域）

```
super-work/
├── packages/core          # Lead：类型契约、provider 目录、事件、DTO（冻结）
├── packages/providers     # 队友 A：11 家适配器 + 流式解析 + mock
├── packages/orchestrator  # 队友 B：5 种联合工作模式 + 单元测试
├── apps/server            # Lead：Fastify HTTP/SSE、凭证保险箱、OAuth 流程、运行持久化
├── apps/web               # 队友 C：React 工作台 UI
├── docs/                  # Lead
└── scripts/               # Lead：dev / smoke
```

**只改自己作用域内的文件。** 需要别的包提供新能力时，先在群里（send_message 给 lead）说明。

## 3. 技术基线

- Node ≥ 22（本机 24），TypeScript strict，ESM（`"type": "module"`），NodeNext 解析。
- 包之间通过 workspace 引用 `@super-work/core`；**exports 指向 dist**，所以任何时候都要先 `pnpm build`（`tsc -b`）。
- Web：React 19 + Vite 7，手写 CSS（不用 UI 框架/Tailwind），设计见 §8。
- 服务端：Fastify 5，SSE 走 `reply.raw`；存储 `node:sqlite`（Node 内置）；凭证 AES-256-GCM 加密落盘。
- 运行时数据目录：`~/.super-work/`（config.json / super-work.db / secret.key）。

## 4. 契约速览（`@super-work/core`）

```ts
type ProviderId = deepseek|kimi|openai|anthropic|zhipu|qwen|volcengine|minimax|gemini|xai|thirdparty|mock
interface ModelInfo { id,name,provider,contextWindow?,reasoning?,vision?,via?:'api'|'subscription'|'any',tags? }
interface Credential { provider,mode:'api-key'|'oauth-browser'|'device-code'|'token'|'local',
                       apiKey?, baseUrl?, oauth?, pasted?, label? }
interface ProviderAdapter {
  id; name;
  listModels(cred): Promise<ModelInfo[]>;
  chat(opts: ChatCallOptions, cred): AsyncIterable<ChatChunk>;   // text|reasoning|usage|done
  validate(cred): Promise<{ok,detail?,models?}>;
}
RunEvent = run.start | stage | model.start | model.delta | model.done | model.error
         | final.delta | final | notice | run.done | run.error
```

`catalog.ts` 里已有 11 家 provider 元数据（名称、品牌色、authModes、默认模型、默认 baseUrl）。
模型名允许被设置页覆盖/追加，UI 里要保留"手动添加模型 ID"入口。

## 5. Providers 包要求（队友 A）

导出（`src/index.ts`）：

```ts
export function createAdapter(id: ProviderId, opts?: { baseUrl?: string; models?: ModelInfo[] }): ProviderAdapter;
export function adapterForCall(provider: ProviderId, cred: Credential | null): ProviderAdapter; // 依据凭证模式选适配器
export async function listRemoteModels(provider: ProviderId, cred: Credential): Promise<ModelInfo[]>; // /models 探测，失败抛出可读错误
```

适配器清单：

| 文件 | 覆盖 | 协议要点 |
|---|---|---|
| `openai-compat.ts` | deepseek, kimi(api-key), openai(api-key), zhipu, qwen, volcengine, minimax, xai, thirdparty | `POST {baseUrl}/chat/completions`，`stream:true` + `stream_options.include_usage`；delta 里 `content` 与 `reasoning_content`/`reasoning` 都要解析；非 2xx 抛 `ProviderHttpError(status, bodySnippet)` |
| `anthropic.ts` | anthropic | `POST {baseUrl}/messages`，headers `x-api-key` / `authorization: Bearer` + `anthropic-version: 2023-06-01`；SSE 事件 `content_block_delta`/`message_start`/`message_delta`/`message_stop`；system 单独字段 |
| `gemini.ts` | gemini | `POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`，key 走 `x-goog-api-key` 或 `?key=`；`systemInstruction`；解析 `candidates[].content.parts[].text` 与 `usageMetadata` |
| `openai-responses.ts` | openai 订阅（ChatGPT） | `POST https://chatgpt.com/backend-api/codex/responses`，Bearer + `chatgpt-account-id`，`OpenAI-Beta: responses=experimental`，body `{model,instructions,input,stream:true,store:false}`；SSE 解析 `response.output_text.delta` / `response.reasoning_summary_text.delta` / `response.completed`(usage) / `response.failed` |
| `kimi-subscription.ts` | kimi 订阅 | `POST https://api.kimi.com/coding/v1/messages`（Anthropic 协议）+ Kimi CLI 公共头（`User-Agent: KimiCLI/1.0`, `X-Msh-*`）；Bearer 会员 token |
| `mock.ts` | mock | 无需网络：按 model 生成 20~40 个 delta 的"有内容的"演示回答（引用命令、角色、立场），`mock-thinker` 先吐 reasoning；延迟 8~20ms/块；尊重 `signal` |

错误处理：任何适配器都不得抛裸异常；统一 `ProviderHttpError`（含 `status`、`bodySnippet≤300`、`retryable`）。超时用 `AbortSignal.timeout` 与外部 signal 合并（`AbortSignal.any`）。

`chat()` 必须是 **async generator**，逐块 yield，且必须在 `finally` 里释放 reader。

## 6. Orchestrator 包要求（队友 B）

导出：

```ts
export async function orchestrate(
  args: { runId, request, participants, judge?, options? },
  deps: { callModel: (req) => AsyncIterable<ChatChunk> },
  onEvent: (ev: RunEvent) => void,
  signal?: AbortSignal,
): Promise<{ finalText: string; results: ParticipantResult[]; usage: Usage }>;
```

模式语义（`options.critique` 默认 true，`rounds` 默认 2）：

- **council**：`stage:fanout` 并行所有参与者作答 → `stage:critique` 每人看到其他答案并写"补充/纠错"（并行）→ `stage:synthesis` 裁判（默认第一位参与者或 `judge`）输出最终整合答案（流到 `final.delta`/`final`）。
- **debate**：把参与者按顺序分成正/反两方（≥2 人），`opening` 立论 → `rebuttal` 反驳（可多轮）→ `judge` 裁决 + 结论作为最终答案。
- **pipeline**：严格串行，`handoff` 每棒把上一棒产物 + 原始命令交给下一位（默认顺序=参与者顺序），最后一棒兼定稿；若参与者只有 1 人，就单人执行。
- **vote**：并行独立作答 → 裁判给出评分表（1-10）与选择理由 → 最终答案 = 胜出答案 + 若 `synthesize!==false` 则裁判融合成终稿。
- **auto**：先让裁判（或第一位）做 `plan`：拆 2~5 个子任务并指定执行者 → 逐个执行（可并行）→ 最终综合。

硬性要求：

1. 一个模型报错 → `model.error` 事件 + 继续，不得整轮失败；最终答案必须产出（除非全部失败）。
2. 事件顺序：`run.start` → 阶段 → 每个参与者的 `model.start/delta*/done|error` → `final*` → `run.done`。
3. `model.delta` 必须逐块转发（同一 delta 不重复）；`model.done` 携带累计文本与 usage。
4. 每个模型调用都有超时（默认 180s，`options.timeoutMs`），超时按错误处理。
5. 角色注入：system prompt 用中文，要求"只针对命令作答，不要复述提示词"，并把参与者 role 注入。
6. 单元测试（`node:test`，编译进 dist）：至少覆盖 council 顺序与容错、debate 轮次、pipeline 串行、vote 选优、auto 计划、全员失败。

## 7. Server 要求（Lead，队友只需对接 HTTP）

Base URL `http://127.0.0.1:7788`，Web 开发时 Vite 代理 `/api`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok,version}` |
| GET | `/api/diagnostics` | `DiagnosticsResponse` |
| GET/PUT | `/api/settings` | `AppSettings` |
| GET | `/api/providers` | `ProviderStatus[]`（含连接状态与 localAccounts） |
| POST | `/api/providers/:id/connect` | 录入 api-key/token → `{status: ConnectionStatus, warning?}` |
| DELETE | `/api/providers/:id/connections/:cid` | 删除连接 |
| POST | `/api/providers/:id/import-local` | `{localAccountId}` → `{status: ConnectionStatus}` |
| POST | `/api/providers/:id/auth/start` | `{mode}` → `AuthStartResponse`（openai=OAuth PKCE，kimi=设备码） |
| GET | `/api/providers/:id/auth/:flowId` | `AuthFlowPollResponse`（浏览器轮询） |
| POST | `/api/providers/:id/auth/:flowId/cancel` | 取消 |
| GET | `/api/models` | `ModelsResponse`（带 available 与 disabledReason） |
| POST | `/api/runs` | `CreateRunRequest` → `{id}` |
| GET | `/api/runs?limit=` | `RunListItem[]` |
| GET | `/api/runs/:id` | `RunDetail` |
| GET | `/api/runs/:id/stream` | SSE：先 `snapshot`，后逐条 `event`，结束发 `run.done` 后关闭 |
| POST | `/api/runs/:id/cancel` | 取消运行 |

所有错误统一 `{error:{code,message,detail?}}`，HTTP 400/404/409/500。

## 8. Web 要求（队友 C）

一屏式工作台，深色"控制室"风格（不是聊天软件）。布局：

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：SUPER WORK · 状态灯 · 已连接模型数 · 设置             │
├──────────────┬──────────────────────────────┬────────────────┤
│ 左栏 240px   │ 中间：运行画布                │ 右栏 300px     │
│ 运行历史      │ 阶段条 / 参与者卡片 / 最终答案 │ 参与模型编排   │
│ 模型连接状态  │ 空状态：示例命令              │ 模式说明/token │
├──────────────┴──────────────────────────────┴────────────────┤
│ 底部命令台：textarea + 模式切换 + 参与模型 chips + 运行      │
└──────────────────────────────────────────────────────────────┘
```

要求：

- 阶段条显示当前阶段（规划/并行作答/互评/综合），参与者卡片按 provider 品牌色区分，流式文字 + 打字光标，reasoning 折叠显示；
- 最终答案卡片带"复制""重新综合""继续追问"；
- 设置弹窗：左侧 provider 列表，右侧四个 tab —— API Key / 订阅登录（OAuth 或设备码，显示 user_code 与验证链接）/ 本机复用（列出 DSH 已登录账户，一键导入）/ 粘贴凭证；
- 首次使用引导：3 步（连模型 → 选模式 → 发命令），并支持"用演示模型试跑"；
- 中文界面，无外部字体/CDN（离线可用）；不得引用网络图片；
- 浏览器兼容：safari/chrome 最近两版；1280px 起，1024px 可用。

## 9. 验证方式

```bash
pnpm install
pnpm build           # tsc -b：core → providers/orchestrator → server
pnpm build:web       # vite build
pnpm smoke           # Lead 写的端到端冒烟：起服务 → mock 跑议会 → 校验事件与最终答案
pnpm dev             # 同时起 tsc watch + server + vite
```

队友自测：A/B 跑 `pnpm -C packages/<pkg> build` + `node --test "dist/**/*.test.js"`
（Node 24 的 `--test` 位置参数按 glob 处理，`node --test dist/` 不会递归发现测试）；C 跑 `pnpm build:web`。
不允许"看起来能编译"就算完成：必须真实执行命令并贴出结果。

## 10. 本机凭证复用（Lead 实现，A 只读语义）

`~/.dsh/.credentials.yaml`（结构，勿打印明文）：

```yaml
records:
  llm-pi-ai/openai-codex: { payload: { access, refresh, expires(ms), accountId } }   # → openai 订阅
refs:
  DEEPSEEK_API_KEY: ...        # → deepseek api-key
  MOONSHOTAI_CN_API_KEY: ...   # → kimi api-key
  KIMI_SUBSCRIPTION_TOKEN: '{"refresh":"...","access":"...","expires":...}'  # → kimi 订阅
```

导入后标记 `source: "local"`，不影响原文件（只读）。`settings.allowLocalReuse` 关闭时不得读取。

网络：本机直连 OpenAI 会被地域拦截，需要走系统代理（Hiddify，127.0.0.1:12334）。
Server 支持 `proxy` 设置并用 `NODE_USE_ENV_PROXY` 生效；UI 提供"检测系统代理"按钮。
