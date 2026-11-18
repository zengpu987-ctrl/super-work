# Effort（强度档位）Web 接入规格

> 面向 `web-v2`（v0.0.2 前端）的集成说明。组件已就绪，**不要重写**；如需要改组件 API，先找 web-dev。
> 强度视觉以 `docs/kimi-ui-review-v2.md §5` 为准（五格刻度、选中格及左侧填充、文字中性、指定色板）。
> 契约来源：`@super-work/core` 的 `effort.ts` / `events.ts` / `api.ts`；服务端：`apps/server/src/routes-v2.ts`。

## 0. 需求

给「正在运行的每个模型」一个强度选择器：**Low / Medium / Fast / Max / Ultra**，改动要真实有效——落到该 participant 后续每次模型调用的 `reasoning` / `maxTokens` / system 提示，支持运行中热调、下一次调用生效。

## 1. 契约（直接用，不要自造字段）

```ts
// @super-work/core
type EffortLevel = "low" | "medium" | "fast" | "max" | "ultra";

interface EffortMeta {
  id: EffortLevel;
  name: string;                 // Low/Medium/Fast/Max/Ultra
  level: 1 | 2 | 3 | 4 | 5;
  reasoning: "low" | "medium" | "high" | null;
  maxTokensMultiplier: number;  // 0.5 / 1 / 1.3 / 2 / 3
  temperature: number;          // 0.3 / 0.5 / 0.4 / 0.6 / 0.7
  hint: string;                 // 编排层注入 system 的强度说明
  description: string;          // UI 一句话描述
}
EFFORT_ORDER: EffortLevel[] = ["low","medium","fast","max","ultra"];
EFFORT_BY_ID / EFFORT_LEVELS / normalizeEffort / applyEffortToMaxTokens

// 运行请求 / 详情
ParticipantSpec.effort?: EffortLevel      // 创建运行时提交
Participant.effort?: EffortLevel          // run.start / RunDetail.participants 回显
ParticipantResult.effort?: EffortLevel    // 历史详情 / 结果
RunOptions.defaultEffort?: EffortLevel    // 未单独指定时的默认档
RunDetail.efforts?: Array<{ participantId: string; effort: EffortLevel }>
```

档位语义（来自 core，UI 只做展示）：

| 档位 | 名称 | reasoning | 输出预算 | 温度 | 中文短标 |
|---|---|---|---|---|---|
| low | Low | low | ×0.5 | 0.3 | 低 |
| medium | Medium | medium | ×1 | 0.5 | 中 |
| fast | Fast | medium | ×1.3 | 0.4 | 快 |
| max | Max | high | ×2 | 0.6 | 强 |
| ultra | Ultra | high | ×3 | 0.7 | 极 |

## 2. 文件与导入

```
apps/web/src/components/EffortSelector.tsx   // 选择器 + EffortBadge
apps/web/src/lib/effort.ts                   // 展示元数据 / 工具函数
apps/web/src/styles/effort.css               // 组件自带（组件内部已 import）
```

```tsx
import { EffortSelector, EffortBadge } from "./components/EffortSelector";
import {
  EFFORT_OPTIONS, effortOf, effortName, effortShort, effortBadge,
  effortDescription, effortTooltip, effortVars, effortMaxTokens,
  DEFAULT_EFFORT, isEffortLevel,
} from "../lib/effort";
```

CSS 二选一（不要同时做）：
- 组件自带 `import "../styles/effort.css"`（默认，零改动，推荐）；
- 或删掉组件内那行，在 `src/styles.css` 加 `@import "./styles/effort.css";`（集中管理）。

## 3. 组件 API

```tsx
export interface EffortSelectorProps {
  value?: EffortLevel;                 // 缺省 Medium
  onChange: (effort: EffortLevel) => void;
  size?: "sm" | "md";                  // sm = 96×24（编排行）；md = 30px 高（卡片/抽屉）
  labels?: "short" | "full";           // 默认 short：L/M/F/Mx/U；full：Low/…/Ultra
  disabled?: boolean;                  // 请求中 / 只读 / 服务端未支持
  label?: string;                      // 可选可见前缀（如「强度」）
  helperText?: string;                 // 可选辅助文案（如「下次调用生效」）
  className?: string;
  ariaLabel?: string;                  // 建议传 `${participant.label} 强度`
}

<EffortBadge level={effort} withName={false} />  // 只读：低/中/快/强/极；withName 显示 Ultra
```

已实现：5 段、96×24、**统一五格刻度：选中格及左侧所有格填充**；文字保持中性色，不用红绿/发光/渐变（严格按 `docs/kimi-ui-review-v2.md §5`：low `#64748B` / medium `#60A5FA` / fast `#3B82F6` / max `#6366F1` / ultra `#7C3AED`，未填充格为 `--track #E2E8F0` 7% 叠加；圆角 4px、格间距 2px）；title 显示全称 + description + reasoning + 输出预算 + 温度；`role=radiogroup/radio` + `aria-checked`、roving tabindex、方向键/Home/End、focus-visible、disabled、prefers-reduced-motion。

**不包含运行态语义**：组件不判断"本次/下次"，由你方用 `helperText` + `EffortBadge` 表达（见 §5）。

## 4. 编排区（并行参与者 / 配合 8 角色槽位）

### 4.1 状态与持久化

`ParticipantSpec` 直接带 `effort`，随现有 `participants` / `coordination` 一起持久化即可：

```ts
const DEFAULT_EFFORT: EffortLevel = "medium";

// 添加模型时
{ provider, model, role, effort: DEFAULT_EFFORT }

// 修改
function setParticipantEffort(target, effort) {
  setParticipants(prev => prev.map(p =>
    clickKey(p) === clickKey(target) ? { ...p, effort } : p));
}

// 配合模式：coordination.assignments 里的 ParticipantSpec 同理
setCoordination(prev => ({
  ...prev,
  assignments: prev.assignments.map(a => ({
    ...a,
    participants: a.participants.map(p =>
      key(p) === key(target) ? { ...p, effort } : p),
  })),
}));
```

- key 建议沿用现有 `keyOf(spec)`（provider + relayId + model），重复模型按数组索引操作。
- 新建运行 `POST /api/runs` 的 `participants[]` / `coordination[].participants[]` 已包含 effort，无需额外字段。
- 默认档：新增模型写 `DEFAULT_EFFORT`；后端 `RunOptions.defaultEffort` 可作为全局兜底。

### 4.2 行内 UI（每模型行 40px，行尾 96×24）

```tsx
<div className="participant-row">   {/* 现有 40px 行 */}
  {/* 名称 / 角色输入 … */}
  <EffortSelector
    value={spec.effort}
    onChange={(effort) => setParticipantEffort(spec, effort)}
    size="sm"
    ariaLabel={`${labelFor(spec)} 强度`}
  />
</div>
```

- 96×24 固定宽高，`labels` 默认短标签；hover 全称见 tooltip。
- 角色槽位（配合模式）每个已选模型单独一行，同样放行尾。
- 模型池里的未选模型不需要选择器（选中后进入编排行再调）。

## 5. 运行中热调（ParticipantCard）

### 5.1 数据来源与回显

- `run.start` 的 `participants[].effort`；SSE `snapshot.run.participants[].effort`；`RunDetail.efforts` 兜底。
- `ParticipantView` 增加 `effort?: EffortLevel`，从上面三处填充；历史详情用 `results[].effort` 或 `participants[].effort`。
- 数据缺失时按 `medium` 展示（`effortOf(undefined)` 已兜底）。

### 5.2 API

建议在 `lib/api.ts` 加：

```ts
import type { EffortLevel } from "@super-work/core";

export interface SetEffortResponse {
  ok: boolean;
  participantId: string;
  effort: EffortLevel;
  note?: string;
}

export function setRunEffort(
  runId: string,
  participantId: string,
  effort: EffortLevel,
): Promise<SetEffortResponse> {
  return request<SetEffortResponse>(
    `/api/runs/${encodeURIComponent(runId)}/effort`,
    { method: "POST", body: JSON.stringify({ participantId, effort }) },
  );
}
```

状态码：200 成功（`note` = 「下一次调用生效」）；404 运行/参与者不存在；409 运行已结束或状态已变化；其它走统一 `ApiError`。

### 5.3 乐观更新 + 回滚 + 降级

```tsx
const [saving, setSaving] = useState<Record<string, boolean>>({});
const [liveUnsupported, setLiveUnsupported] = useState(false);

async function changeEffortLive(participantId: string, next: EffortLevel) {
  if (!run || run.state !== "running" || liveUnsupported) return;
  const current = run.participants.find(p => p.id === participantId);
  if (!current || current.effort === next) return;

  const prev = current.effort ?? "medium";
  const runId = run.id;

  setSaving(s => ({ ...s, [participantId]: true }));
  patchParticipantEffort(participantId, next);          // 乐观：立即高亮新档

  try {
    const res = await api.setRunEffort(runId, participantId, next);
    if (runRef.current?.id !== runId) return;            // 切走不覆盖
    patchParticipantEffort(participantId, res.effort);   // 以服务端为准
    pushToast("success", `已将 ${current.label} 调整为 ${effortName(next)}`, "下一次调用生效");
  } catch (err) {
    patchParticipantEffort(participantId, prev);         // 回滚
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      pushToast("warn", "强度未生效", err.message);
      if (err.status === 404) setLiveUnsupported(true);  // 旧服务端：禁用后续热调
    } else {
      pushToast("error", "调整强度失败", errorMessage(err));
    }
  } finally {
    setSaving(s => { const next = { ...s }; delete next[participantId]; return next; });
  }
}
```

渲染：

```tsx
<div className="participant-card__effort">
  <EffortSelector
    value={view.effort}
    onChange={(next) => changeEffortLive(view.id, next)}
    size="md"
    labels="short"
    disabled={run.state !== "running" || !!saving[view.id] || liveUnsupported}
    helperText={
      liveUnsupported
        ? "当前服务端未支持实时调节"
        : run.state === "running"
          ? "运行中修改，下一次调用生效"
          : undefined
    }
    ariaLabel={`${view.label} 强度`}
  />
  <EffortBadge level={view.effort} withName />
</div>
```

要求：
- 运行中才可点；结束后 disabled（历史只读）。
- 请求中只禁用该卡选择器，不阻塞其它卡。
- 404/409 必须回滚并 toast；404 后记住 `liveUnsupported`，避免反复报错。
- 成功时若后端 SSE 新增 `participant.effort` 事件，以事件为准同步；没有事件就用响应。
- 不要在前端伪造 reasoning 变化——真实差异来自 orchestrator/providers（mock 模型能看到 reasoning token 与输出块数变化）。

## 6. 历史详情 / chips / 预估

- **历史详情**：`ParticipantResult.effort`，卡片头部 `<EffortBadge level={result.effort} withName />`，只读、无选择器。
- **命令台 chips**：`<EffortBadge level={spec.effort} />`（中文单字），chip 的 title 加 `effortTooltip(spec.effort)`。
- **预估卡**：
  ```ts
  const efforts = participants.map(p => effortOf(p.effort));
  const maxLevel = efforts.reduce((max, e) => Math.max(max, e.level), 1);
  // 输出预算总量 = 各档 maxTokensMultiplier 之和；最高档 badge
  ```
  文案示例：「强度分布：低×1 · 中×2 · 极×1 · 最高 Ultra（单次最多 ≈3× 输出预算）」。
- 计费/成本使用现有 billing 接口；如需按档位估算，用 `maxTokensMultiplier` 乘输出 token 预估即可，**不要**另造价格表。

## 7. 无障碍与响应式

- 每个选择器 `ariaLabel` 必须包含模型名（卡片里有多组 radiogroup）。
- 键盘：Tab 进入当前选中项；←/→/↑/↓ 循环；Home/End 到首尾；focus-visible 已内置。
- 96×24 满足行内点击；卡片内建议 `size="md"`（30px 高）。
- 1200px 左栏图标化后，编排行仍保持 40px；选择器可换行但不撑破行高。
- 对比度：填充格文字统一中性色 `--text-1`、未填充格 `--text-2`；不要再给档位文字套 level 色（会破坏中性色规格）。

## 8. 验收清单

1. 编排区每个模型行有 5 段选择器，96×24，hover 显示全称；改档后新建运行请求体包含对应 `effort`。
2. 运行中改某卡强度 → PATCH 200、立即高亮、toast「已将 X 调整为 Ultra，下一次调用生效」；该 participant 下一阶段 `reasoning` 长度 / usage.reasoningTokens / 输出块数明显增加（mock 即可复现）。
3. 服务端不可达 / 旧服务端 404 → 回滚 + toast，选择器禁用并显示「未支持实时调节」；409（运行刚结束）→ 回滚 + 提示。
4. 历史详情显示档位徽标；命令台 chips 显示中文单字；预估卡体现最高档与输出预算。
5. `pnpm build:web` + `tsc --noEmit` 通过；无 console 报错；1440/1200/1024 无溢出。
6. 键盘可完成全部操作，读屏能读出「X 强度，Ultra，选中」。

## 9. 边界与已知约束

- **运行中修改只影响后续调用**：已经在飞的请求不会变；council 的互评轮、pipeline 的后几棒、coordinate 的后续角色会生效。
- 未设置 effort 的旧运行按 Medium 展示；不要回写历史。
- 重复模型（同 provider+model 多实例）必须用索引/role 区分 key，不要只按 provider:model。
- relay / workbuddy 模型同样支持（effort 走 provider 透传）；模型池分组不影响选择器。
- 服务端尚未支持热调时（404），**不要**白屏或阻塞新运行；创建运行时仍提交 effort。
