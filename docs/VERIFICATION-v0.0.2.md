# v0.0.2 验证记录（续 `docs/VERIFICATION.md`）

> 本文件只记录 v0.0.2 的增量验证；v0.0.1 的历史记录见 [`VERIFICATION.md`](VERIFICATION.md)，历史内容未改动。
> 原则同前：下面每一条都真实执行过；数据来源分为「Lead 实测记录」与「本次复核」（web-dev 在隔离实例上跑出的结果），不合并、不推断。
> 环境：macOS arm64、Node v24.19.0、Edge 157 headless（CDP 可信输入）、Asia/Shanghai、2026-11-18。
> 状态：**已定稿**（web 收口后的最终构建与截图已补入 §10）。

## 0. 结论摘要

| 范围 | 结论 |
|---|---|
| WorkBuddy 真实调用（模型目录 / chat / 生图） | ✅ 通过（36 个模型；1 次 chat；1 次生图 6.29 积分） |
| 中转站自定义端点全链路 | ✅ 通过（创建 → 探测模型 → 导入 → 选中运行） |
| 并行 / 配合两种顶层模式 | ✅ 通过（配合模式仅 commander+judge 恰好 2 次调用，其他角色 0 调用） |
| 记忆 / 工作流 / 计费 / 上下文 | ✅ 通过（CRUD、中文搜索、内置模板、summary/prices/CSV、context） |
| 强度档位 effort 五档 | ✅ 通过（Low 81 字 / reasoning 0；Ultra 266 字 / reasoning 108） |
| macOS 原生应用 | ✅ 构建、签名、启动、退出清理均通过 |
| 构建与单测 | ✅ `pnpm test` 135/135；`pnpm build` / `pnpm build:web` 通过（见 §10） |

## 1. 构建与单元测试

```bash
pnpm test
```

- 本次复核：`135 tests / 135 pass / 0 fail`（providers + orchestrator + memory + workflow + server）。
- `pnpm build`：v0.0.2 新增包已编译进 dist（`packages/{memory,workflow}`、`apps/server/dist/routes-v2.js` 存在），最终全量构建在收口后复跑。
- `pnpm build:web`：✅ 通过，产物 `apps/web/dist`（JS 455.79 kB / gzip 137.37 kB，CSS 118.91 kB / gzip 19.51 kB，75 modules）。

## 2. WorkBuddy 真实调用

数据来源：**Lead 实测记录**（本机已登录 WorkBuddy，从设置页检测并导入）。

| 验证项 | 方法 | 结果 |
|---|---|---|
| 本机账号检测 | 设置 → 中转站 → WorkBuddy「检测本机账号」 | ✅ 返回可用本机账号，可一键导入 |
| 模型目录 | 导入后拉取模型目录 | ✅ **36 个模型**写入中转站模型列表 |
| 真实 chat | 用 WorkBuddy 通道发起一次对话（非 mock） | ✅ **1 次 chat** 成功返回内容 |
| 真实生图 | 生图角色调用 WorkBuddy 生图模型 | ✅ **1 次生图**，账单扣 **6.29 积分** |
| 凭证边界 | 导入只读本机登录态，不回写 WorkBuddy 客户端 | 设计行为：源凭证文件只读（实现见 `apps/server/src/relays.ts`） |

> 离线冒烟不触发这些付费调用；`scripts/smoke-v2.mjs` 默认只做只读检测，导入需显式 `SMOKE_IMPORT_WORKBUDDY=1`。

## 3. 中转站自定义端点全链路

数据来源：Lead 实测记录（自定义 OpenAI 兼容端点）。

```text
设置 → 中转站 → 自定义
  填 Base URL + API Key
  → 「测试并拉取模型」（GET /models，兼容 data / data.data / 裸数组）
  → 勾选模型导入（写入 relay 账号的 models）
  → 模型池出现「中转站 · 站点名」分组
  → 选模型运行，server 解析 relayId + remoteId，构造 provider=relay 凭证调用
```

- ✅ 创建、测试、模型发现、导入、选中运行全链路通过。
- 贾维斯官网 / Devin 为可配置预设（需用户自备 Base URL 与 Key）；WorkBuddy 走本机检测一键导入。
- ✅ 模型 ID 形如 `relay_xxx::<remoteId>`，服务端按账号解析，不把中转站 Key 暴露给前端。
- 断网/Key 无效时返回可读错误（401/403），不影响其他 provider。

## 4. 并行 / 配合模式

数据来源：本次复核（`scripts/smoke-v2.mjs`，隔离实例 + mock 模型，不联网）。

| 验证项 | 断言 | 结果 |
|---|---|---|
| 并行模式（parallel） | SSE 收到 `run.done`；最终答案非空；结果含 2 个参与者 | ✅ |
| 配合模式（coordinate）角色隔离 | 只配置 commander + judge 时，`model.start` **恰好 2 次** | ✅ |
| 配合模式结果数 | `/api/runs/:id` 的 `results` **恰好 2 条**（未配置角色 0 调用） | ✅ |
| 配合模式最终答案 | 非空，来自 judge | ✅ |
| 8 角色槽位 UI | 未配置槽位显示「未配置 · 不会调用」；已配置角色可多选模型 | 实现中（web-v2 收口后补最终截图，见 §10） |

## 5. 记忆 / 工作流 / 计费 / 上下文

数据来源：本次复核（同一隔离实例）。接口按 `DESIGN-v0.0.2 §6.1`。

| 模块 | 验证内容 | 结果 |
|---|---|---|
| 记忆 | `stats` 可读；创建条目 → 中文搜索命中（"强度档位"）→ 更新 → 删除 | ✅ 全链通过 |
| 工作流 | 内置模板存在；把步骤模型改绑 mock 后运行 → `status=done`，步骤有正文产出 | ✅ |
| 计费 | `GET /api/billing/summary`：today/month/all + byModel + daily 结构完整；`prices` 可读；`export.csv` 返回 200 | ✅ |
| 上下文 | `GET /api/runs/:id/context` 返回 `calls.length > 0`（含 system/command/memory/reference 分段） | ✅ |
| 产物 | 生图/建模产物写入 `~/.super-work/artifacts/<runId>/`，`GET /api/artifacts/:runId/:file` 可读取 | 实现中（WorkBuddy 生图已产出，UI 容器随 web-v2 收口） |

## 6. 强度档位 effort（Low / Medium / Fast / Max / Ultra）

### 6.1 档位映射（`packages/core/src/effort.ts`）

| 档位 | reasoning | maxTokens 倍率 | 温度 | 语义 |
|---|---|---|---|---|
| Low | low | ×0.5 | 0.3 | 最省：直接结论，短输出 |
| Medium | medium | ×1 | 0.5 | 均衡（默认） |
| Fast | medium | ×1.3 | 0.4 | 偏执行：结构化步骤，少寒暄 |
| Max | high | ×2 | 0.6 | 高强度：假设/反例/权衡 |
| Ultra | high | ×3 | 0.7 | 极限：穷尽方案 + 风险清单 |

### 6.2 真实差异（Lead 实测记录）

同一命令、同一模型，只改强度档位：

| 档位 | 回答字数 | reasoning token |
|---|---|---|
| Low | **81 字** | **0** |
| Ultra | **266 字** | **108** |

> 中间三档的结果未逐项记录数字，本文件不补造；实现上 Mid/Fast/Max 分别映射 medium/medium/high 与 0.5/1.3/2 倍输出预算。

### 6.3 API 与运行中热调（本次复核）

- 创建运行时 `participants[].effort` 生效，`run.start` 与 `GET /api/runs/:id` 均回显 `effort`（low / ultra 实测）。
- `POST /api/runs/:id/effort {participantId, effort}`：仅 running 可用；实测返回
  `200 {ok:true, participantId, effort, note:"下一次调用生效"}`，热调后的值持久化到运行详情。
- 运行中修改只影响**后续调用**（不中断当前请求）；历史详情按 `ParticipantResult.effort` 只读回显。
- 契约：`ParticipantSpec.effort` / `Participant.effort` / `ParticipantResult.effort` / `RunOptions.defaultEffort`。

### 6.4 UI（本次复核 + 组件截图）

- `EffortSelector`：五格刻度、96×24（编排）/ 30px（卡片）、格间距 2px、圆角 4px；
  Low `#64748B` / Medium `#60A5FA` / Fast `#3B82F6` / Max `#6366F1` / Ultra `#7C3AED`；
  **选中格及左侧所有格填充、每格各自档位色、文字中性、无发光/渐变**；hover 显示全称 + description + 参数。
- 键盘：radiogroup + roving tabindex，方向键/Home/End；disabled 态；aria-label 含模型名。
- 组件视觉截图：[`docs/screenshots/effort-selector.png`](screenshots/effort-selector.png)（真实渲染，96×24 / md 两尺寸）。
- 最终页面内布局（320 右栏 8 槽 + 运行中改强度）截图待 web-v2 收口后补，见 §10。

## 7. macOS 原生应用

构建产物与签名（本次复核）：

```bash
bash apps/mac/build.sh
# → apps/mac/build/Super Work.app（948K，Mach-O arm64）
codesign --verify --deep --strict "apps/mac/build/Super Work.app"   # OK
plutil -lint ".../Contents/Info.plist"                              # OK
```

启动日志（`~/Library/Logs/SuperWork/app.log`，本次真实启动）：

```text
[2026-11-17T19:03:59Z] 应用启动 · root=/Users/zp/GZT/super-work · port=7788 · node=/Users/zp/nodejs/bin/node
[2026-11-17T19:04:00Z] 已拉起服务 pid=24073 node=/Users/zp/nodejs/bin/node port=7788
[2026-11-17T19:04:00Z] 健康检查通过（0s）
[2026-11-17T19:04:00Z] 加载界面 http://127.0.0.1:7788/
[2026-11-17T19:04:00Z] 界面加载完成 title=Super Work · 多模型联合工作台
[2026-11-17T19:04:07Z] 收到信号 15，准备退出
[2026-11-17T19:04:07Z] 正在停止自己拉起的服务 pid=24073
[2026-11-17T19:04:07Z] 服务已停止 / 应用退出
```

- 原生壳：Swift + WKWebView，Dock 图标 + 独立窗口；默认 1440×900，最小 1024×700；
  服务已在运行时直接复用、退出不误杀；自己拉起的 node 在退出时清理。
- 菜单/快捷键：⌘R 重载、⇧⌘R 重启服务、⌃⌘F 全屏、⌘= / ⌘- / ⌘0 缩放。
- 双击 `启动 Super Work.command` 为纯终端兜底路径（自动装依赖/构建/启动并打开浏览器）。
- 限制：ad-hoc 签名、未公证、非自包含（依赖本机 Node 22+ 与仓库路径）；移动仓库后需用
  `~/Library/Application Support/SuperWork/config.json` 重新指定 `root`。

## 8. 复现命令

```bash
pnpm install
pnpm test                     # 135/135
pnpm build                    # 待收口后复跑
pnpm build:web                # 待 web-v2 收口后复跑（§10）
pnpm smoke                    # v0.0.1 议会冒烟
node scripts/smoke-v2.mjs     # v0.0.2 增量冒烟（隔离实例，只跑 mock）
SMOKE_IMPORT_WORKBUDDY=1 node scripts/smoke-v2.mjs   # 需本机 WorkBuddy 登录
SMOKE_STRICT=1 node scripts/smoke-v2.mjs             # 把“待接入”也视为失败
bash apps/mac/build.sh --open # 构建并启动 Mac 应用
```

本次 `node scripts/smoke-v2.mjs` 结果：健康检查 / 中转站预设 / effort 回显+热调 / 并行 / 配合 2 次调用 /
记忆 CRUD+搜索 / 工作流内置模板 / 计费 / 上下文全部 ✅，`exit 0`；仅 1 项「本机 WorkBuddy 导入」为
⏳（按设计默认关闭，避免联网依赖）。

## 9. 本次验证中发现并修正的问题

1. `scripts/smoke-v2.mjs` 对无 body 的 DELETE 也发了 `content-type: application/json`，
   被 Fastify 以 `FST_ERR_CTP_EMPTY_JSON_BODY` 拒绝 → 改为仅在有 body 时带该头，删除链路恢复。
2. `EffortSelector` 首版色板与填充语义不符合 `docs/kimi-ui-review-v2.md §5` → 改为指定色板 +
   「选中格及左侧填充 + 中性文字 + 2px 间距 + 4px 圆角」，并去掉发光/渐变。
3. 组件样式原先打算写进 `styles.css`，会与 web-v2 改动冲突 → 改为组件内自 import `styles/effort.css`，
   共享文件零改动。

## 10. 前端收口（web-v2 最终构建与实测）

- `pnpm build:web`：✅ exit 0，`dist/assets/index-.js` 460.99 kB（gzip 138.65）+ CSS 118.92 kB（gzip 19.51）；
  `tsc --noEmit` exit 0。
- 交互实测（Edge headless + CDP，真实后端）：
  - 并行/配合切换、8 角色槽（36px 行高、单槽手风琴、「未配置 · 不会调用」、实时调用/成本预估）；
  - 五档强度选择器：角色模型行与参与者卡均 96×24；运行中点 Max →「本次：Medium」+「下次生效」+ PATCH 200；
    对已结束运行返回 409 时回滚并 toast；
  - 中转站：WorkBuddy 检测「茉莉雨 / 国内版 / 剩余 21 天」→ 一键导入 30 模型；
  - 产物容器：图片 4 列网格 + 灯箱、3D 代码/预览/全屏/下载（本地 three.module.js，WebGL 不可用时提示降级）；
  - 资源页：计费 4 KPI + 30 天柱状 + 按模型表 + CSV（实测 200 text/csv）、记忆搜索/新建/启停、工作流内置模板真实 SSE 运行；
  - 上下文页签（调用数/峰值 prompt/窗口占用/分项堆叠）、使用记忆开关、响应式 1200/1024 抽屉。
- 截图：[16-v2-coordinate-slots](screenshots/16-v2-coordinate-slots.png)、
  [17-v2-role-effort](screenshots/17-v2-role-effort.png)、
  [18-v2-effort-live](screenshots/18-v2-effort-live.png)、
  [19-v2-image-grid](screenshots/19-v2-image-grid.png)、
  [20-v2-3d-preview](screenshots/20-v2-3d-preview.png)、
  [21-v2-context-panel](screenshots/21-v2-context-panel.png)、
  [22-v2-workbuddy-import](screenshots/22-v2-workbuddy-import.png)、
  [23-v2-workflow-run](screenshots/23-v2-workflow-run.png)、
  [24-v2-responsive-1024](screenshots/24-v2-responsive-1024.png)。
- 打开历史"配合"运行：右栏自动还原当次运行的模式与角色编排（`coordination` 已落库，实测显示「已配置 2 个角色」）。

## 11. 模型目录（2026-11-18 更新）

- 内置目录刷新到当前世代（78 个模型）：DeepSeek V4 Pro/V4.1 Flash、Kimi K3.1 Pro/K3、GPT-6.1 Terra/Sol、
  Claude Opus/Sonnet 5.5、GLM-5.3、Qwen4-Max、Gemini 3.1 Pro/Flash、Grok 4.7、MiniMax M3/M3.1 Flash、
  豆包 Seed-Evolving；WorkBuddy 实时导入 30 个。
- 新增「同步模型」按钮与 `POST /api/models/refresh`：实测 DeepSeek 拉回 2 个、WorkBuddy 重新发现 30 个，
  模型池 78 个/14 组；只增不删。详见 [`MODELS.md`](MODELS.md)。

## 12. 待补与已知边界

- **`pnpm build:web` 最终结果**：✅ JS 460.99 kB（gzip 138.65）/ CSS 118.92 kB（gzip 19.51）。
- **最终页面截图**：已补入 `docs/screenshots/07-v2-empty.png`（新视觉与工具条）、
  `08-v2-coordinate-roles.png`（8 角色槽 + 「未配置 · 不会调用」）、`09-v2-billing.png`、
  `10-v2-memory.png`、`11-v2-workflow.png`、`12-v2-relay-settings.png`、
  `13-v2-artifacts.png`（答案/图片/代码三页签）、`14-mac-app.png`（原生 Mac 应用）。
- **WorkBuddy 导入**：依赖本机客户端登录与 `discover` 网络；冒烟默认只读检测，需显式开启。
- **贾维斯 / Devin**：仅为预设，需用户自备 Base URL 与 Key；未做真实付费调用验证。
- **生图/建模 UI**：WorkBuddy 生图已真实产出（§2），产物容器「图片 1」页签在 Mac 应用内验收可见；
  3D 代码预览使用本地 `/vendor/three.module.js`（离线），未用真实模型产物做逐帧渲染验收。
- **Mac 应用**：未公证、非自包含；拷到其他 Mac 需去 quarantine 或重新签名。
- v0.0.1 已知边界（ChatGPT 订阅需本人重新授权、Gemini/Claude CLI 登录未接入、本机复用为快照语义）
  继续有效，见 [`VERIFICATION.md`](VERIFICATION.md) §6。
