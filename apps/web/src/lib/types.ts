/**
 * Web 层视图模型与常量。
 * DTO 一律来自 @super-work/core（契约冻结），这里只放"UI 需要派生的形状"。
 */
import type {
  Artifact,
  AttachmentMeta,
  ContextInsight,
  CoordinationAssignment,
  EffortLevel,
  ModelInfo,
  ParticipantSpec,
  ParticipantStageResult,
  ProviderId,
  RunEvent,
  RunGuardInfo,
  RunMode,
  StageId,
  Usage,
} from "@super-work/core";
import { RUN_MODE_META } from "@super-work/core";

/* ---------------------------------------------------------------- view models */

export type ParticipantState = "idle" | "streaming" | "done" | "error" | "stopped";

export interface ParticipantView {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  role: string;
  text: string;
  reasoning: string;
  usage?: Usage;
  latencyMs?: number;
  state: ParticipantState;
  error?: string;
  startedAt?: number;
  /** 各阶段发言（来自 ParticipantResult.stages，历史/完成态才有） */
  stages?: ParticipantStageResult[];
  /** relay 模型的中转站账号 */
  relayId?: string;
  /** 该模型在本次运行中的调用次数（来自上下文洞察） */
  calls?: number;
  /** 当前生效的强度档位（服务端 participant.effort / run.start 回传） */
  effort?: EffortLevel;
  /** 运行中刚切换、下一次调用才生效的档位 */
  effortNext?: EffortLevel;
}

/** stage id → 中文短标签（卡片按阶段切换时用）。 */
export const STAGE_LABELS: Record<StageId, string> = {
  command: "发令",
  chat: "Chat",
  specialist: "执行",
  integrate: "整合",
  render: "渲染",
  memory: "记忆",
  workflow: "工作流",
  plan: "规划",
  opening: "立论",
  fanout: "作答",
  critique: "互评",
  rebuttal: "反驳",
  handoff: "接力",
  judge: "裁决",
  synthesis: "综合",
  final: "定稿",
};

/** 上下文洞察的一次调用（服务端 /api/runs/:id/context 与 SSE context 事件同构）。 */
export interface ContextCall extends ContextInsight {
  at: number;
}

/** 未知 stage 直接展示原文，保持前向兼容。 */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as StageId] ?? stage;
}

export interface StageMark {
  stage: StageId;
  label: string;
  at: number;
}

export interface RunNotice {
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

export type RunState = "loading" | "running" | "done" | "error";

export interface RunView {
  id: string;
  command: string;
  mode: RunMode;
  state: RunState;
  createdAt: number;
  finishedAt?: number;
  participants: ParticipantView[];
  stages: StageMark[];
  notices: RunNotice[];
  finalText: string;
  finalStreaming: boolean;
  usage?: Usage;
  error?: string;
  /** live=本次新建并流式接收；history=从历史读取 */
  origin: "live" | "history";
  streamStatus?: StreamStatusLabel;
  /**
   * 裁决 / 综合模型。后端的裁判结果 id 固定为 "judge"，不占参与者卡片，
   * 只在最终答案卡头部展示"裁判：xxx"。
   */
  judge?: { label: string; provider?: ProviderId; model?: string };
  /** 生图 / 建模 / 文件产物（SSE artifact 实时到达） */
  artifacts: Artifact[];
  /** 每次模型调用的上下文构成（SSE context 实时到达） */
  contexts: ContextCall[];
  /** 配合模式的角色编排快照 */
  coordination?: CoordinationAssignment[];
  /** 本次运行注入的记忆条数（服务端可能不回传） */
  memoryInjected?: number;
  /** 本次运行成本（服务端计算后回传） */
  cost?: number;
  /** 命令区附件（v0.0.3） */
  attachments?: AttachmentMeta[];
  /** 预算 / 关键词 / 省钱模式守卫信息（v0.0.3） */
  guard?: RunGuardInfo;
  /** 多轮对话：所属工作 id（等于自身 id 表示第 1 轮新建的工作） */
  threadId?: string;
  /** 多轮对话：第几轮 */
  round?: number;
  /** 本次注入的前几轮历史（轮数 / 估算 token / 是否截断） */
  history?: { rounds: number; tokens: number; truncated: boolean };
}

export type StreamStatusLabel = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "failed";

/** 继续追问时携带的上一轮上下文。 */
export interface FollowUpContext {
  runId: string;
  command: string;
  finalText: string;
  label: string;
}

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "error" | "warn";
  message: string;
  detail?: string;
}

/* ---------------------------------------------------------------- modes */

/** v0.0.2 的两个顶层模式。 */
export const PRIMARY_MODES: RunMode[] = ["parallel", "coordinate", "chat"];

/** v0.0.1 的联合策略，收进并行模式的「作答策略」里保留。 */
export const LEGACY_MODES: RunMode[] = ["council", "debate", "pipeline", "vote", "auto"];

export const MODE_ORDER: RunMode[] = ["parallel", "coordinate", "chat", ...LEGACY_MODES];

export const MODE_META = RUN_MODE_META;

export const MODE_TIP_V2: Record<string, string> = {
  parallel: "所有选中的模型同时独立作答；可指定裁判模型把结论合成一份最终答案。",
  coordinate: "按 8 个角色分工：发令 → 推理 / 代码 / 建模 / 生图 / Chat → 整合 → 裁判。未配置的角色不会调用。",
  chat: "只选一个模型，像聊天一样多轮对话；可在画布上直接调档，也能交给模型团队接着做。",
};

export const MODE_EXPECTATION: Record<RunMode, string[]> = {
  parallel: ["并行作答", "综合"],
  coordinate: ["发令", "角色执行", "整合", "裁判"],
  chat: ["对话"],
  council: ["规划", "并行作答", "互评", "综合"],
  debate: ["立论", "反驳 ×2", "裁决"],
  pipeline: ["第 1 棒", "第 2 棒", "…", "定稿"],
  vote: ["并行作答", "打分", "融合终稿"],
  auto: ["调度规划", "子任务执行", "汇总"],
};

export const MODE_TIP: Record<RunMode, string> = {
  parallel: "所有选中的模型同时独立作答，可由裁判模型综合成一份最终答案。",
  coordinate: "按角色分工执行：未配置的角色严格不调用，空槽不会产生任何请求。",
  chat: "Chat 模式每次只选一个模型聊天，支持多轮上下文与档位调节；切回并行/配合即可让团队接手。",
  council: "6 个模型各自独立作答，再互相挑错，最后由总协调模型合成。",
  debate: "参与者分正反两方，先立论再反驳，裁判给出结论。",
  pipeline: "严格串行：每一棒只在前一棒成果上继续，最后一棒定稿。",
  vote: "并行独立作答，裁判打分选出最佳，再补一版终稿。",
  auto: "先由调度模型拆任务，把子任务分给更擅长的模型，最后汇总。",
};

/** 有"裁决者"概念的模式（其余模式由最后一位兼定稿）。 */
export const JUDGE_MODES: RunMode[] = ["parallel", "council", "debate", "vote"];

/* ---------------------------------------------------------------- stage ribbon */

export interface StageSlot {
  id: string;
  label: string;
  stages: StageId[];
}

/** DESIGN §8：规划 / 并行作答 / 互评 / 综合 / 裁决。 */
export const STAGE_SLOTS: StageSlot[] = [
  { id: "plan", label: "规划", stages: ["plan"] },
  { id: "fanout", label: "并行作答", stages: ["fanout", "opening"] },
  { id: "critique", label: "互评", stages: ["critique", "rebuttal"] },
  { id: "synthesis", label: "综合", stages: ["synthesis", "handoff"] },
  { id: "judge", label: "裁决", stages: ["judge", "final"] },
];

/** 配合模式的阶段条。 */
export const COORD_STAGE_SLOTS: StageSlot[] = [
  { id: "command", label: "发令", stages: ["command"] },
  { id: "specialist", label: "角色执行", stages: ["specialist", "render", "memory"] },
  { id: "integrate", label: "整合", stages: ["integrate"] },
  { id: "judge", label: "裁判", stages: ["judge", "synthesis", "final"] },
];

/** 并行模式的阶段条。 */
export const PARALLEL_STAGE_SLOTS: StageSlot[] = [
  { id: "fanout", label: "并行作答", stages: ["fanout", "opening", "plan"] },
  { id: "judge", label: "综合 / 裁决", stages: ["synthesis", "judge", "final"] },
];

/** Chat 模式的阶段条：只有一段对话。 */
export const CHAT_STAGE_SLOTS: StageSlot[] = [
  { id: "chat", label: "对话", stages: ["chat", "fanout", "final"] },
];

export function stageSlotsForMode(mode: RunMode): StageSlot[] {
  if (mode === "coordinate") return COORD_STAGE_SLOTS;
  if (mode === "parallel") return PARALLEL_STAGE_SLOTS;
  if (mode === "chat") return CHAT_STAGE_SLOTS;
  return STAGE_SLOTS;
}

/** 未知 stage 返回 -1（后端新增阶段时不能让 UI 崩）。 */
export function stageSlotIndex(stage: StageId | string, slots: StageSlot[] = STAGE_SLOTS): number {
  return slots.findIndex((slot) => slot.stages.includes(stage as StageId));
}

/** 依据 stage 事件计算阶段条状态；未知阶段沿用最后一个已知阶段。 */
export function stageSlotStates(
  stages: StageMark[],
  state: RunState,
  slots: StageSlot[] = STAGE_SLOTS,
): Array<"pending" | "active" | "done"> {
  let activeIndex = -1;
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    const mark = stages[i];
    if (!mark) continue;
    const index = stageSlotIndex(mark.stage, slots);
    if (index >= 0) {
      activeIndex = index;
      break;
    }
  }
  if (activeIndex < 0 && state === "running") activeIndex = 0;
  return slots.map((_, index) => {
    if (state === "done") return "done";
    if (state === "error") return index <= activeIndex ? (index === activeIndex ? "active" : "done") : "pending";
    if (state === "loading") return "pending";
    if (activeIndex < 0) return "pending";
    if (index < activeIndex) return "done";
    if (index === activeIndex) return "active";
    return "pending";
  });
}

/* ---------------------------------------------------------------- estimate */

export interface EstimateInput {
  mode: RunMode;
  count: number;
  rounds: number;
  critique: boolean;
}

export interface Estimate {
  calls: number;
  formula: string;
}

export function estimateCalls(input: EstimateInput): Estimate {
  const { mode, count } = input;
  const rounds = Math.max(1, Math.min(5, input.rounds));
  switch (mode) {
    case "parallel": {
      return { calls: count + 1, formula: `${count} 个模型并行作答 + 综合 1 ≈ ${count + 1} 次调用` };
    }
    case "coordinate": {
      return { calls: count, formula: `按角色累计 ${count} 次调用（未配置角色不调用）` };
    }
    case "council": {
      const perRound = input.critique ? 2 : 1;
      const calls = count * perRound + 1;
      return {
        calls,
        formula: `${count} 个模型 × ${perRound} 轮${input.critique ? "（含互评）" : ""} + 综合 1 ≈ ${calls} 次调用`,
      };
    }
    case "debate": {
      const calls = count * rounds + 1;
      return { calls, formula: `${count} 个模型 × ${rounds} 轮 + 裁决 1 ≈ ${calls} 次调用` };
    }
    case "pipeline": {
      return { calls: count, formula: `${count} 棒串行接力 ≈ ${count} 次调用` };
    }
    case "vote": {
      return { calls: count + 2, formula: `${count} 个并行作答 + 打分 1 + 融合 1 ≈ ${count + 2} 次调用` };
    }
    case "auto":
    default: {
      const calls = count + Math.max(2, Math.ceil(count / 2)) + 1;
      return { calls, formula: `调度 1 + 子任务 ≈ ${count + 1} + 汇总 1 ≈ ${calls} 次调用` };
    }
  }
}

export function estimateSeconds(calls: number, reasoningHeavy: boolean): string {
  const low = Math.round(calls * (reasoningHeavy ? 5 : 3));
  const high = Math.round(calls * (reasoningHeavy ? 16 : 9));
  return `约 ${low}–${high} 秒`;
}

/* ---------------------------------------------------------------- examples */

export interface ExampleCommand {
  tag: string;
  title: string;
  command: string;
}

export const EXAMPLE_COMMANDS: ExampleCommand[] = [
  {
    tag: "增长",
    title: "AI 笔记产品 30 天冷启动",
    command:
      "为一家做 AI 笔记的初创公司设计 30 天冷启动增长方案：给出 3 条渠道、每周预算分配、可验证的关键指标，并指出最可能的失败点。",
  },
  {
    tag: "工程",
    title: "慢查询优化到 200ms",
    command:
      "orders 表 100 万行，这个查询要 8 秒：SELECT * FROM orders WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 50。请给出索引设计、改写方案与验证方法。",
  },
  {
    tag: "代码",
    title: "SSE 流式客户端",
    command:
      "用 TypeScript 写一个基于 fetch + ReadableStream 的 SSE 客户端：支持事件分帧、自动重连一次、AbortSignal 取消，并说明与 EventSource 相比的取舍。",
  },
  {
    tag: "选型",
    title: "RAG 还是长上下文",
    command:
      "对比 RAG 与长上下文模型在 100 页合同问答场景的准确率、成本与延迟，给出 3 种公司规模下的选型结论和迁移路径。",
  },
  {
    tag: "写作",
    title: "6 人团队周会议程",
    command:
      "为 6 人产品团队写一份 45 分钟周会模板：会议目标、时间盒、每人 60 秒同步的固定格式、需要当场决策的事项清单，以及会议结束后的动作项格式。",
  },
];

/* ---------------------------------------------------------------- participant helpers */

export const ROLE_PRESETS = [
  "总协调 / 综合",
  "深度分析",
  "长文与代码",
  "推理校验",
  "资料整合",
  "多模态视角",
  "反方质询",
  "事实核查",
  "风险审查",
];

export const MAX_PARTICIPANTS = 8;

export function participantKey(participant: Pick<ParticipantSpec, "provider" | "model">): string {
  return `${participant.provider}:${participant.model}`;
}

export function defaultRole(index: number): string {
  return ROLE_PRESETS[index % ROLE_PRESETS.length] ?? "独立视角";
}

export function modelLabel(model: Pick<ModelInfo, "name" | "id">): string {
  return model.name || model.id;
}

export function runEventLabel(event: RunEvent): string {
  switch (event.type) {
    case "run.start":
      return "运行开始";
    case "stage":
      return event.label;
    case "model.start":
      return "模型开始作答";
    case "model.delta":
      return "流式输出";
    case "model.done":
      return "模型完成";
    case "model.error":
      return "模型失败";
    case "final.delta":
      return "最终答案生成中";
    case "final":
      return "最终答案完成";
    case "notice":
      return event.message;
    case "artifact":
      return `产物：${event.artifact.title}`;
    case "context":
      return "上下文快照";
    case "run.done":
      return "运行结束";
    case "run.error":
      return event.message;
    default:
      return "事件";
  }
}


/* ---------------------------------------------------------------- v0.0.2 helpers */

/** 由 /api/models 的选项生成 ParticipantSpec（relay 需要把远程模型名与账号分开）。 */
export function specFromModel(model: ModelInfo, effort: EffortLevel = "medium"): ParticipantSpec {
  const remote = model.provider === "relay" ? (model.remoteId ?? model.id.split("::").pop() ?? model.id) : model.id;
  return {
    provider: model.provider,
    model: remote,
    relayId: model.relayId,
    effort,
  };
}

export function specKey(spec: Pick<ParticipantSpec, "provider" | "model" | "relayId">): string {
  return `${spec.provider}:${spec.relayId ?? ""}:${spec.model}`;
}

export function specLabel(spec: ParticipantSpec, models: ModelInfo[]): string {
  const found = models.find(
    (model) =>
      model.provider === spec.provider &&
      (model.provider === "relay" ? (model.remoteId ?? model.id) === spec.model : model.id === spec.model) &&
      (spec.relayId ? model.relayId === spec.relayId : true),
  );
  return found?.name ?? spec.model;
}

/** 角色槽位的调用次数估算（未配置角色不产生调用）。 */
export function estimateCoordCalls(assignments: Array<{ role: string; participants: ParticipantSpec[] }>, useJudge = true): number {
  let calls = 0;
  for (const item of assignments) {
    const count = item.participants.length;
    if (count === 0) continue;
    if (item.role === "commander") calls += count;
    else if (item.role === "image") calls += count;
    else if (item.role === "integrator") calls += count;
    else if (item.role === "judge") calls += useJudge ? count : 0;
    else calls += count;
  }
  return calls;
}

/** 配合模式的角色顺序（沿用 core 的 COORD_ROLES 声明顺序）。 */
export function roleOrder(): string[] {
  return ["commander", "reasoning", "coding", "model3d", "image", "chat", "integrator", "judge"];
}

/** 顶栏「资源」下拉里的独立页面。 */
export type ResourcePage = "billing" | "memory" | "workflow";

/** 设置弹窗的一级分区（v0.0.3 新增后四项）。 */
export type SettingsSection = "providers" | "relay" | "budget" | "plugins" | "performance" | "keywords";
