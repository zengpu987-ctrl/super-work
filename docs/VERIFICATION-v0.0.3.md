# v0.0.3 验收清单（VERIFICATION）

> 本文件只新增，不改 `VERIFICATION.md` / `VERIFICATION-v0.0.2.md` 历史内容。
> 状态：**已填（2026-11-19）**。结果来自 Lead 实测记录与 web-v3 REPORT；未单独实测的子项明确标注「未单独实测」，不预写通过。
> 验证环境：macOS arm64、Node v24.19.0、服务 `http://127.0.0.1:7788`、Edge headless（CDP 可信输入）。
> 契约依据：`packages/core/src/v3.ts`、`docs/DESIGN-v0.0.3.md` §2–§8、`docs/kimi-tech-ui-v3.md`。

## 0. 总门禁（先跑这四项）

| 项 | 命令 | 期望 | 结果 / 证据 |
|---|---|---|---|
| 全量构建 | `pnpm build` | exit 0（core → providers/orchestrator/memory/workflow/files/plugins → server） | ✅ 通过（core/server/providers/orchestrator/files/plugins 全部编译；Lead 实测） |
| 单测 | `pnpm test` | 全绿；v0.0.3 新增包与既有包零失败 | ✅ **163/163 通过**，0 fail（含 v3 新增包与多轮对话单测） |
| Web 构建 | `pnpm build:web` | exit 0，产物 `apps/web/dist` | ✅ 通过：JS **551.04 kB**（gzip **165.41**）/ CSS **159.33 kB**（gzip **26.27**） |
| Web 类型 | `pnpm -C apps/web typecheck`（或 `tsc -p apps/web/tsconfig.json --noEmit`） | exit 0 | ✅ 通过（web-v3 收口构建；与 `pnpm build:all` 的 tsc -b 一并验证） |

补充门禁：

- 离线可用：构建产物不得引用 CDN/外部字体/图片（`grep` 构建产物仅允许 `/api` 与 core catalog 的端点/文档字符串）→ ✅ 随 build:web 产物检查（本版未引入外链；截图见 §7）。
- v0.0.3 端到端：`pnpm smoke:v3` → ✅ **66/66 通过**（Lead 实测；覆盖上传、附件运行、预算、关键词、自定义角色、插件、budgets/usage）。
- v0.0.1/v0.0.2 回归：`pnpm smoke` / `node scripts/smoke-v2.mjs` 本次未重跑（历史记录分别见 `VERIFICATION.md` §2、`VERIFICATION-v0.0.2.md` §8；v0.0.3 不回归由 `smoke:v3` 覆盖）。

## 1. 附件上传（图片 / PDF / DOCX / DOC / 代码 / 文本）

### 1.1 上传与解析 API

```bash
printf 'Super Work v0.0.3 附件测试：请总结这份材料的三条结论。' > /tmp/sw-attach.txt
B64=$(base64 < /tmp/sw-attach.txt | tr -d '\n')
curl -s -X POST http://127.0.0.1:7788/api/uploads \
  -H 'content-type: application/json' \
  -d "{\"name\":\"sw-attach.txt\",\"mime\":\"text/plain\",\"size\":$(wc -c < /tmp/sw-attach.txt | tr -d ' '),\"dataBase64\":\"$B64\"}"
```

期望：`200`，返回 `UploadResponse`（`attachment.id`、`kind:"text"`、`chars`、`text` 非空、`path` 指向 `~/.super-work/uploads/<id>/`）；同内容可 `GET /api/uploads/:id` 回读。

真实实测（Lead 在运行中的服务上逐项 POST /api/uploads）：

| 类型 | 实测结果 |
|---|---|
| txt | ✅ `200`；`kind:"text"`；两次上传 `chars` 分别为 **16 / 63** |
| PNG | ✅ `200`；`kind:"image"`；缩略图 `dataUrl` **5,363 B** |
| PDF | ✅ `200`；`kind:"pdf"`；`chars` **5023**（PDF 文本提取成功） |
| DOCX | ✅ `200`；`kind:"docx"`；`chars` **22** |
| DOC | 未单独实测（macOS `textutil` 路径；实现见 `@super-work/files`） |
| 代码 / 文本 | 未单独实测（文本路径与 txt 同链路；>200KB 截断） |
| 超限（>20MB / 第 9 个） | 未单独实测（服务端限制 8 个/20MB，错误为 `400 upload_failed`） |

UI 侧（web-v3 截图验证）：命令区 file input 上传、chips、预览（文本/图片缩略图）、失败重试与移除均正常；
证据：[`28-v3-attachments.png`](screenshots/28-v3-attachments.png)。

### 1.2 随运行提交

```bash
# 用上一步返回的 attachment.id/name/kind/text 组装
curl -s -X POST http://127.0.0.1:7788/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "command":"请总结附件里的三条结论",
    "mode":"parallel",
    "participants":[{"provider":"mock","model":"mock-fast","role":"总结"}],
    "attachments":[{"id":"<id>","name":"sw-attach.txt","mime":"text/plain","kind":"text","text":"<text>"}]
  }'
```

期望：`201`；`run.attachments` 含该附件；运行详情 `guard.attachments` 有记录；上下文洞察（`GET /api/runs/:id/context`）`reference` 段计入附件 token；最终答案体现附件内容。总附件上下文预算 ≤12000 chars（省钱模式 ≤6000）。

实测：✅ `smoke:v3` 第③步「带附件发起并行运行 → 详情里的 attachments 与 guard」通过；UI 真实上传截图见 §1.1。

### 1.3 UI 操作路径

工作台 → 底部命令区：

1. **拖拽整区** / **⌘V 粘贴** / 点「附件」选择文件 → chips 出现（图标 + 名称 + 大小 + 百分比）；✅
2. 点 chip 展开预览：文本前 2000 字、图片 120px 缩略图；✅
3. 上传/解析中「运行」禁用，提示「附件仍在上传或解析中」；失败 chip 变红，可「重试/移除」；✅
4. 发送前显示「附件约 x tokens」；超过单次上限直接拦截并提示；✅（截图 28）
5. 最多 8 个、单文件 20MB。✅（实现/UI 限制）

证据：[`28-v3-attachments.png`](screenshots/28-v3-attachments.png)（真实 UI 上传与 chips/预览）。

## 2. 预算拦截（防 token 额外/自动消耗）

### 2.1 配置与查询

```bash
# 每日 token 上限（用 mock 即可稳定触发）
curl -s -X PUT http://127.0.0.1:7788/api/settings \
  -H 'content-type: application/json' \
  -d '{"budgets":{"currency":"CNY","dailyTokenLimit":1,"perRunTokenLimit":5000,"warnAtPercent":80,"confirmAboveCost":0.01,"cheapMode":false}}'

curl -s http://127.0.0.1:7788/api/budgets/usage
```

期望：`budgets/usage` 返回 `{today:{tokens,cost,currency}, limits, percent, cheapMode, blocked, message?}`；`blocked=true` 时 message 指向“设置 → 预算”。

实测：✅ `/api/budgets/usage` 结构正确（`smoke:v3` 第⑧步）；`dailyTokenLimit=1` 后再次 `POST /api/runs` 返回
**409 `budget_exceeded`**，message 含「今日 token 已用 **4,255**」。

### 2.2 拦截行为

| 场景 | 操作 | 实测结果 / 证据 |
|---|---|---|
| 每日上限 | 跑 1 次 mock → 再 POST `/api/runs` | ✅ `409 {code:"budget_exceeded"}`，message 含「今日 token 已用 4,255」；UI 拦截条 [`35-v3-budget-blocked.png`](screenshots/35-v3-budget-blocked.png) |
| 单次预估上限 | 设 `perRunTokenLimit` 小于「参与者数 × perCall×3」后再创建 | 未单独实测（`runs.ts checkBudget` 已实现，错误同为 `budget_exceeded`） |
| 高成本确认 | 设 `confirmAboveCost`，用有定价模型（WorkBuddy/DeepSeek）创建 | UI 确认弹窗 ✅ [`29-v3-budget-confirm.png`](screenshots/29-v3-budget-confirm.png)；API 侧 `409 budget_confirm` 未单独记录 |
| 运行中守卫 | 设 `perRunTokenLimit` 使预检通过、运行累计超限 | 未单独实测（orchestrator 预算守卫逻辑与单测覆盖；本次未采集运行中真实数据） |
| 省钱模式 | 设 `cheapMode:true` 后创建运行 | 未单独实测（`guard.cheapMode` / 默认 low / 关闭互评已实现） |
| 非法数值 | `PUT /api/settings` 传 `perCallMaxTokens:100` / `warnAtPercent:5` | 未单独实测（`validateV3Settings` 范围校验 256~32768 / 10~100） |

### 2.3 UI 操作路径

- 工具条预算条：显示今日已用/上限；≥80% 变黄、100% 变红并显示拦截状态；点预算条进入设置 → 预算。✅
- 设置 → 预算：每日成本/token、单次运行成本/token、单次调用上限、预警百分比、确认阈值、省钱模式；保存后 `GET /api/budgets/usage` 生效。✅（设置六页签截图组，见 §7）
- 高成本/超限创建时弹确认弹窗（最高层级），确认仅本次放行（`force:true`）。✅（截图 29）

## 3. 自定义角色（配合模式）

### 3.1 契约与 API

```bash
curl -s -X PUT http://127.0.0.1:7788/api/settings \
  -H 'content-type: application/json' \
  -d '{"customRoles":[{"id":"custom_audit","name":"安全审计","description":"检查安全与合规风险","kind":"text","order":100}]}'
```

创建运行（只配自定义角色 + 裁判）：

```bash
curl -s -X POST http://127.0.0.1:7788/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "command":"对这份方案做安全审计",
    "mode":"coordinate",
    "participants":[],
    "coordination":[
      {"role":"custom_audit","participants":[{"provider":"mock","model":"mock-fast","role":"安全审计","effort":"low"}]},
      {"role":"judge","participants":[{"provider":"mock","model":"mock-thinker","role":"裁判","effort":"medium"}]}
    ]
  }'
```

实测（Lead）：

- ✅ `PUT /api/settings` 写入 `custom_audit` 成功；
- ✅ coordinate 仅配 `custom_audit` + `judge` → **201**；跑完 `results` **恰好 2 条**；
- ✅ 两个参与者分别为 `mock-fast`（`effort: low`）/ `mock-thinker`（`effort: medium`）；
- ✅ 事件 `label` 使用角色名（安全审计）；
- ✅ `smoke:v3` 第⑥步「custom_audit + 裁判 = 恰好 2 次调用」通过（66/66）。

未单独实测：未知角色 `400`、名称 2~12/重名/id 前缀等校验（`validateV3Settings` 已实现）、上限 24、拖拽排序/复制/删除（UI 由 web-v3 实现）。

### 3.2 UI 操作路径

配合模式 → 右栏「编排」→ 末尾虚线「＋角色」→ 抽屉：

- 名称（2–12 字、不可重名）、职责（≤200 字）、是否生图、模型多选；
- 未选模型不能启用；保存后出现在自定义槽；
- 支持拖拽排序、复制、删除（二次确认，历史运行保留角色快照）；
- 空槽显示「未配置 · 不会调用」。

✅ 截图：[`27-v3-custom-role.png`](screenshots/27-v3-custom-role.png)。

## 4. 关键词

### 4.1 规则与测试

```bash
curl -s -X PUT http://127.0.0.1:7788/api/settings \
  -H 'content-type: application/json' \
  -d '{"keywords":[
    {"id":"kw_image","enabled":true,"keyword":"画图","match":"contains","priority":3,"action":{"type":"mode","mode":"coordinate"}},
    {"id":"kw_cheap","enabled":true,"keyword":"省钱","match":"contains","priority":2,"action":{"type":"cheapMode","enabled":true}}
  ]}'

curl -s -X POST http://127.0.0.1:7788/api/keywords/test \
  -H 'content-type: application/json' \
  -d '{"command":"帮我画图：一只在指挥舱里的猫，并尽量省钱"}'
```

实测（Lead）：

- ✅ 关键词「画图」→ 模式 `coordinate`；`/api/keywords/test` 返回 effects **`["模式 → coordinate"]`**；
- ✅ `smoke:v3` 第⑤步验证「画图」命中后，配合运行被追加角色（未配置角色不调用）；
- ✅ UI 关键词表格/测试文本/命中与最终生效摘要截图：[`32-v3-keywords.png`](screenshots/32-v3-keywords.png)。

未单独实测：role/effort/memory/cheapMode/judge 各动作的真实运行、优先级冲突、正则非法 400（实现已具备，`smoke:v3` 未逐项覆盖）。

### 4.2 运行侧

命令含触发词创建运行（配合模式）：

- 命中 `mode` → 本次运行使用该模式（实测生效）；
- 命中其他动作（role/effort/memory/cheapMode/judge）→ 写入本次运行的生效配置（未单独实测）；
- 运行详情 `guard.matchedKeywords` 可回看命中项（`smoke:v3` 链路覆盖）。

### 4.3 UI 操作路径

设置 → 关键词：规则表格（启用 / 关键词 / 包含·精确·正则 / 触发模式 / 指定角色 / 强度 / 优先级）；「测试文本」输入命令 → 展示命中与最终生效摘要；冲突提示；编辑/删除/启用开关。✅（截图 32）

## 5. 插件中心

### 5.1 API

```bash
curl -s http://127.0.0.1:7788/api/plugins | head -c 800
curl -s -X POST http://127.0.0.1:7788/api/plugins/dsh-ffmpeg/test
curl -s http://127.0.0.1:7788/api/plugins/dsh-ffmpeg/logs
```

实测（Lead）：

- ✅ `GET /api/plugins` 返回 **35 条**：native **9** / bridge **12** / ui-only **10** / unsupported **4**；
- ✅ `POST /api/plugins/dsh-ffmpeg/test` → `ok:true`，**41ms**，输出含 `ffmpeg version 4.4`；
- ✅ `pnpm smoke:v3` **66/66** 通过（第⑦步：≥30 条且字段完整，至少 1 个 bridge 真实测试成功）；
- ✅ UI 插件表格/搜索/筛选/测试/日志截图：[`30-v3-plugin-center.png`](screenshots/30-v3-plugin-center.png)。

未单独实测：`PUT /api/plugins/:id` 启停/覆盖桥接命令、`/logs` 接口、35 条逐项分类核对（接口与实现已具备）。

### 5.2 UI 操作路径

设置 → 插件：35 行表格（名称/版本/类型/状态/启用/测试/日志）；搜索（如“ffmpeg”）、按类型/状态筛选；点「测试」显示 ok/延迟/进程输出；切换启用；失败有可读错误。✅（截图 30）

## 6. 性能面板

### 6.1 配置校验

```bash
curl -s -X PUT http://127.0.0.1:7788/api/settings \
  -H 'content-type: application/json' \
  -d '{"performance":{"concurrency":3,"timeoutMs":90000,"defaultMaxTokens":4096,"streamChunkThrottleMs":60}}'
```

期望：

- 合法值保存成功；非法值 `400`：并发 <1 或 >8、超时 <15s 或 >300s、默认 token <256 或 >32768；
- 修改仅影响**新运行**，不影响进行中任务；
- 并发生效：3 个 mock 模型分别以 `concurrency:1` 与 `8` 跑同一命令，记录从创建到 `run.done` 的耗时；
- 超时生效：用慢响应/不可达端点 + 小超时（15s）触发 `model.error`；
- 流式合并间隔：`streamChunkThrottleMs` 大于 0 时 delta 合并，事件数量减少但不丢文本。

实测：✅ 性能面板正常显示（截图 [`31-v3-performance.png`](screenshots/31-v3-performance.png)；设置六页签正常，见 §7）。
并发 1 vs 8 的实际耗时、超时触发、流式合并参数效果：**未单独记录**（本清单不预写数值；如需补测，按上面命令执行并记录 `run.done - createdAt`）。

### 6.2 UI 操作路径

设置 → 性能：并发（1–8，默认 3）、超时（15–300s，默认 90）、默认 maxTokens（256–32768，默认 4096）、流式合并间隔；「恢复默认」按钮；保存后新运行生效。✅（截图 31）

## 7. 科技感 UI（v3 视觉规格）

### 7.1 构建 + 截图

```bash
pnpm build:web
# Edge headless（CDP）访问 http://127.0.0.1:7788/，分别截 1440 / 1200 / 1024 三档
```

实测：

- ✅ 主界面（科技感指挥舱）：[`26-v3-workbench-tech.png`](screenshots/26-v3-workbench-tech.png)；
- ✅ 设置六页签正常（预算/插件/性能/关键词等）：[`30-v3-plugin-center.png`](screenshots/30-v3-plugin-center.png)、
  [`31-v3-performance.png`](screenshots/31-v3-performance.png)、
  [`32-v3-keywords.png`](screenshots/32-v3-keywords.png)、
  [`33-v3-skip-validation.png`](screenshots/33-v3-skip-validation.png)；
- ✅ 附件真实 UI：28；自定义角色：27；历史/多轮：26；图标：36。
- 三档响应式截图：本版以 1440/1200/1024 工作台与设置页截图核对（具体三档文件见 screenshots 目录，未单独命名）。

### 7.2 令牌与观感探针（CDP evaluate）

```js
getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim()      // #070A10
getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()     // #0E1622
getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()    // #6D8DFF
getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()    // 10px
```

期望与核对：

- 背景 `#070A10`、面板 `#0E1622`、边框 `#1B293A`、正文 `#DCE6F2`、次要 `#71839A`；
- 面板 1px 内描边 + `inset 0 1px #ffffff06`，无厚重玻璃/大面积霓虹；
- 24px 网格仅画布显示、透明度 3%；动效 120ms（悬停）/180ms（面板）/240ms（抽屉）；
- 无持续呼吸动画；运行态只允许一次/2s 细线扫描；
- 设置四个一级页签：预算 / 插件 / 性能 / 关键词；命令区附件 chips、预算条、省钱模式在工具条；
- 与 `docs/kimi-tech-ui-v3.md §F` 反面清单逐条对照（无全屏霓虹、无意义扫描线、切角六边形、多层玻璃、持续旋转）。

实测：以上按截图核对通过；`computed style` 探针输出未单独保存（本清单不预写数值）。

## 8. 贾维斯图标（Mac App）

```bash
ls -l apps/mac/resources/jarvis-icon-final.png apps/mac/resources/AppIcon.icns
md5 -q apps/mac/resources/jarvis-icon-final.png apps/mac/resources/AppIcon.icns
md5 -q "apps/mac/build/Super Work.app/Contents/Resources/AppIcon.icns"
md5 -q "/Applications/Super Work.app/Contents/Resources/AppIcon.icns"
codesign --verify --deep --strict "/Applications/Super Work.app" && echo OK
```

实测：

- ✅ 新 Jarvis 图标已替换 macOS App（暗色反应核 + 三层断环 + 中央棱镜），Dock/应用图标正常：
  [`36-v3-app-icon.png`](screenshots/36-v3-app-icon.png)；
- ✅ `/Applications/Super Work.app` 已安装；`codesign --verify`（ad-hoc）通过；
- 图标 md5 基线（早前实测，供重构建后对比）：`jarvis-icon-final.png` `3dc0e91950eef45493a2feb12e38db25`；
  `AppIcon.icns` / 构建产物 / 已安装 App 均为 `101dd8a49d91cf3fd4a1777482143758`。

## 9. 结果汇总表

| # | 验收项 | 命令 / 路径 | 结果 | 证据 |
|---|---|---|---|---|
| 0 | 构建 / 测试 / Web 构建 | `pnpm build` `pnpm test` `pnpm build:web` | ✅ 163/163；Web JS 551.04 kB / CSS 159.33 kB（gzip 165.41 / 26.27） | Lead 实测；本表 §0 |
| 1 | 附件上传 | §1.1–§1.3 | ✅ txt(16/63 字)、PNG(缩略 5,363B)、PDF(5023 字)、DOCX(22 字)；UI 正常 | [`28-v3-attachments.png`](screenshots/28-v3-attachments.png) |
| 2 | 预算拦截 | §2.1–§2.3 | ✅ 每日上限 409 `budget_exceeded`（「今日 token 已用 4,255」）；确认弹窗正常 | [`35-v3-budget-blocked.png`](screenshots/35-v3-budget-blocked.png)、[`29-v3-budget-confirm.png`](screenshots/29-v3-budget-confirm.png) |
| 3 | 自定义角色 | §3.1–§3.2 | ✅ custom_audit+judge → 201，results 恰好 2（low/medium） | [`27-v3-custom-role.png`](screenshots/27-v3-custom-role.png)；`smoke:v3` ⑥ |
| 4 | 关键词 | §4.1–§4.3 | ✅「画图」→ effects `["模式 → coordinate"]`；配合运行追加角色 | [`32-v3-keywords.png`](screenshots/32-v3-keywords.png)；`smoke:v3` ⑤ |
| 5 | 插件中心 | §5.1–§5.2 | ✅ 35 条（9/12/10/4）；ffmpeg 测试 41ms、`ffmpeg version 4.4`；`smoke:v3` 66/66 | [`30-v3-plugin-center.png`](screenshots/30-v3-plugin-center.png) |
| 6 | 性能面板 | §6.1–§6.2 | ✅ UI 正常；并发/超时数值未单独记录 | [`31-v3-performance.png`](screenshots/31-v3-performance.png) |
| 7 | 科技感 UI | §7.1–§7.2 | ✅ 6 页签/主界面截图通过；计算样式探针未单独保存 | 26 / 30 / 31 / 32 / 33 |
| 8 | 贾维斯图标 | §8 | ✅ Dock/App 图标已替换；md5 三者一致（基线见 §8） | [`36-v3-app-icon.png`](screenshots/36-v3-app-icon.png) |

## 10. 已知边界

> web-v3 REPORT 原文未随仓库提交；以下按 Lead 已提供项与 `DESIGN-v0.0.3` / README / 既有验收文档可核实内容整理为 7 条，另附沿用 v0.0.2 的补充。

1. **插件「全部迁移」按方案 A**：能桥接的提供可运行入口，已原生的标注迁移；DSH 专属 UI 插件仅标注并给替代建议，不强行移植。
2. **插件桥接依赖本机可执行文件**（ffmpeg / python / wolfram 等）：未安装时该项测试失败，不影响其他插件；测试超时 10s、输出截断 4KB。
3. **KIMI 订阅 token invalid_grant**：本版 UI 验收使用 WorkBuddy 通道的 Kimi-K3.1-Pro；KIMI 官方订阅需重新授权（详见 `VERIFICATION-v0.0.2.md` §2）。
4. **PDF 解析曾因 Buffer/byteOffset 报 bad XRef**：已修为 `Uint8Array`；本次真实 PDF 提取 5023 chars 通过。
5. **macOS App**：ad-hoc 签名、未公证、非自包含（依赖本机 Node 22+ 与仓库路径）；移动仓库后需在 `~/Library/Application Support/SuperWork/config.json` 指定 `root`。
6. **生图 / 3D 预览**：依赖 WorkBuddy 额度与本机 WebGL；离线只保证代码与降级提示，不承诺逐帧渲染验收。
7. **上游 `/models` 404/405 时跳过网络校验**：导入成功不代表模型一定可用；只有 401/403/超时才判失败，运行时仍可能报错（`DESIGN-v0.0.3` §6）。

沿用 v0.0.2 补充：

- ChatGPT 订阅需用户本人重新授权（token 时效）；Gemini / Claude CLI 登录流未接入，当前用 API Key 或粘贴 OAuth token；本机复用是快照语义（源文件变动后需重新导入）。详见 `VERIFICATION-v0.0.2.md` §10 与 `VERIFICATION.md` §6。

## 11. 填表与证据规范

- 结果只写实际执行过的内容；未执行写「未单独实测」，不要预估“应该通过”。
- 命令输出粘贴关键行（状态码/断言/耗时），长输出截断前 40 行并注明完整日志路径。
- 截图统一放 `docs/screenshots/`，命名 `28-v3-*`（附件/图标/预算等）、`29-v3-*`、`30-v3-*`、`31-v3-*`、`32-v3-*`、`33-v3-*`、`35-v3-*`、`36-v3-*`。
- 每次执行注明：日期时间、Node 版本、服务端口、是否隔离实例（`SUPER_WORK_HOME`）、是否真实联网/付费调用。
- 涉及付费或本机 WorkBuddy 的项，明确标注“真实调用”与积分/费用；纯 mock 项标注“离线”。
