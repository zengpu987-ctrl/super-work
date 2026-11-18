# Super Work v0.0.3 — 设计与协作说明

> 增量契约见 `packages/core/src/v3.ts`、`coordination.ts`、`events.ts`、`api.ts`（已冻结并 build 通过）。
> UI 设计依据：`docs/kimi-tech-ui-v3.md`（Kimi-K3.1-Pro，科技感/Jarvis 指挥舱规格）。

## 0. 本版目标（用户原话拆解）

1. 解决模型导入校验无法通过的问题；
2. 配合模式增加自定义角色；
3. UI 设计由 KIMI K3.1-Pro 完成（WorkBuddy 通道），科技感；
4. 增加防止 token 额外/自动消耗机制；
5. 把 DSH 目前所有插件迁移过去（落地方式：插件中心 + 能力桥接；详见 §5）；
6. 命令发送区增加文件上传（图片、PDF、Word、代码等）；
7. 每个模型运行中档位调节（v0.0.2 已有，本版补齐 relay/WorkBuddy 映射与 UI）；
8. 贾维斯科技感图标（已完成：`apps/mac/resources/jarvis-icon-final.png` → AppIcon.icns，App v0.0.3 已装进 /Applications 与 Dock）；
9. 设置里增加插件查看器；
10. 设置增加性能配置调控器与关键词模块。

## 1. 写作用域

| 目录 | 负责人 |
|---|---|
| `packages/core` | Lead（已冻结 v3 契约） |
| `packages/memory` / `packages/workflow` | 冻结，本版不动 |
| `packages/files`、`packages/plugins` | systems-v3 |
| `packages/orchestrator` | orchestrator-v3 |
| `packages/providers` | providers-v3 |
| `apps/server` | Lead |
| `apps/web` | web-v3 |
| `docs/` | Lead |

## 2. 自定义角色（配合模式）

- 定义：`CustomRoleDef { id, name, description, kind: "text"|"image", order }`，存 `AppSettings.customRoles`。
- 运行请求：`coordination[].role` 可以是 8 个内置 id，也可以是 `custom_*`；Server 创建运行时按内置 + 自定义校验，未知角色 400。
- Orchestrator：`options.customRoles` 传入；用 core `resolveCoordRole(role, customRoles)` 得到 `{name,kind,order,builtin}`。
  - `image` 类角色走 `deps.generateImage`（与内置生图一致）；
  - `text` 类角色在 specialist 阶段并行（顺序按 order）；
  - 内置 commander / integrator / judge 语义保持不变；若自定义角色没有模型 → 0 调用。
- 事件里的 `label` 用角色名；`run.start.participants` 仍按参与者展开。
- Web：编排区内置 8 槽 + 自定义槽（虚线「＋角色」），新增/编辑抽屉（名称 2-12 字、职责≤200、是否生图、模型多选），可拖拽排序、复制、删除（删除需确认，历史运行保留快照）。

## 3. 附件上传

- 服务端：`POST /api/uploads`（JSON：`{name,mime,size,dataBase64}`，≤20MB，最多 8 个/次），保存到 `~/.super-work/uploads/<id>/`，
  用 `@super-work/files` 提取文本：代码/文本直接读、PDF（pdf-parse）、DOCX（mammoth）、DOC（macOS `textutil`）、
  图片存原图 + 返回缩略 dataUrl（服务端生成 ≤512px）。返回 `UploadResponse`。
- UI：命令区整区拖拽、⌘V 粘贴、文件选择；chips + 预览；发送前显示「附件约 x tokens」；
  附件文本随 `CreateRunRequest.attachments` 提交。
- Orchestrator：`options.attachmentsContext` 由 server 拼好（每份附件带名称/类型/正文，总预算 ≤12000 chars），
  注入 commander/specialist 的 system，并在 context 洞察里计入 `reference`。
- 图片：本版先做存储/预览；providers-v3 为适配器增加图片输入能力（`ChatMessage` content 支持 image parts，见 §6），
  WorkBuddy 可用于图片理解。

## 4. 防 token 额外消耗 / 预算与性能

- `AppSettings.budgets`：每日成本/每日 token/单次运行 token/单次运行成本/单次调用输出上限/预警百分比/确认阈值/省钱模式。
- `AppSettings.performance`：并发 1-8、超时 15-300s、默认 maxTokens 256-32768、流式合并间隔。
- Server：
  - 创建运行前用 `BillingService.summary()` 检查今日窗口：超限 → 409 + 可读原因（除非 `force:true` 明确确认）；
  - 计算本次预估（参与者数 × 档位 maxTokens）超过 `confirmAboveCost` → 返回 409 需确认一次；
  - 把 `cheapMode` / `perCallMaxTokens` / `concurrency` 写进 `RunOptions`；`guard` 回写 RunDetail/guard 事件。
- Orchestrator：
  - 所有 chat 调用 `maxTokens = min(模型上限, 档位倍率, perCallMaxTokens, performance.defaultMaxTokens)`；
  - 运行时累计 usage，超过单次运行 token/成本上限 → 取消剩余调用并发 `notice(error)` + 正常收尾；
  - `cheapMode`：默认档位降为 low、关闭互评轮、上下文截断更激进；
  - 并发池大小取 `options.concurrency`（默认 3）。
- UI：工具条预算条（今日已用/上限，80% 黄、100% 红）；高成本运行确认弹窗；设置→预算面板。

## 5. 插件中心 + 能力桥接（DSH 插件迁移）

- `@super-work/plugins` 负责：
  - 读取 `~/.dsh/profiles/desktop/package.json` 的 dependencies + 各包 `package.json`，产出 `PluginInfo[]`（35 个）；
  - 分类映射表（内置）：native（memory/context/billing/workflow/workbuddy/vision 等）、bridge（ffmpeg/image-gen/hyperframes/remotion/arxiv/wolfram/github-router 等）、ui-only（pet/wallpaper/sidebar/theme-market/claude-style/dshmarket 等）、unsupported；
  - `testPlugin(plugin)`：用 `spawn` 执行 bridge 测试命令（超时 10s、输出截断 4KB、不跑真实任务），返回 ok/message/latency/output。
- Server：`GET /api/plugins`（合并 settings.plugins 的 enabled/lastTest）、`PUT /api/plugins/:id`（启用/覆盖桥接命令）、`POST /api/plugins/:id/test`；扫描结果缓存 60s。
- Web 设置 → 插件：表格（名称/版本/类型/状态/启用/测试/日志），搜索筛选；点「测试」显示进程输出与延迟。
- 「全部迁移」口径：**能桥接的提供可运行入口，已原生的标注迁移，DSH 专属 UI 插件标注仅 DSH 并给替代建议**（用户已确认方案 A）。

## 6. Providers（providers-v3）

1. 图片输入：`ChatMessage` 增加可选 `images?: string[]`（data URL）；适配器映射：
   - OpenAI 兼容 / WorkBuddy / Relay：`content: [{type:"text"},{type:"image_url",image_url:{url}}]`；
   - Anthropic：`{type:"image", source:{type:"base64", media_type, data}}`；
   - Gemini：`inlineData`。
2. `validate` 兜底：上游无 `/models`（404/405）时返回 `ok:true, detail:"未提供 /models，已跳过网络校验"`，避免「导入校验无法通过」；
   仅 401/403/超时才 ok:false。
3. WorkBuddy：effort→`reasoning_effort` 已有；生图/图片理解接口保持。
4. 单测覆盖以上。

## 7. Files / Plugins 包（systems-v3）

```ts
// files
export async function extractFile(input: {name,mime,data:Buffer}): Promise<{
  kind: AttachmentKind; text: string; chars: number; mime: string; error?: string;
}>;
export async function makeImageThumb(data: Buffer, mime: string): Promise<{dataUrl:string;width:number;height:number}>;

// plugins
export async function scanDshPlugins(opts?: {dshProfileDir?: string}): Promise<PluginInfo[]>;
export async function testPlugin(plugin: PluginInfo, timeoutMs?: number): Promise<PluginTestResult>;
export const PLUGIN_CLASSIFICATION: Record<string, { kind; status; capability?; bridge?; note? }>;
```

## 8. 验收

- `pnpm build` / `pnpm build:web` / `pnpm test` 全绿；
- 上传 PDF/DOCX/代码/图片各 1 个，运行里能看到附件内容与 token 估算；
- 自定义角色：新建「安全审计」角色 → 配合模式只配它 + 裁判 → 恰好 2 次调用；
- 预算：设 1 元日上限 → 第二次运行被拦截并提示；省钱模式生效；
- 关键词：配置「画图 → 配成生图角色」规则，命中后运行包含该角色；
- 插件：35 项列表、至少 3 个 bridge 测试真实返回（ffmpeg/python/wolfram 等按本机可用性）；
- 性能：并发 1 与 8 的行为、超时生效；
- 图标与 App：Dock 显示新 Jarvis 图标（已完成）。
