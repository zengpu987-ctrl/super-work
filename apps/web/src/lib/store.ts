/**
 * 运行状态机与离线兜底数据。
 * 纯函数 reducer：SSE 事件 / 快照 / 历史详情都收敛到同一个 RunView。
 */
import type {
  Artifact,
  CoordinationAssignment,
  ContextInsight,
  EffortLevel,
  ModelOption,
  ProviderId,
  Participant,
  ParticipantResult,
  ParticipantSpec,
  ProviderStatus,
  RunDetail,
  RunEvent,
  RunMode,
  StageId,
} from "@super-work/core";
import { PROVIDERS, PROVIDER_PURCHASE, PROVIDER_BY_ID, findModel } from "@super-work/core";
import type {
  ParticipantView,
  RunState,
  RunView,
  StageMark,
  StreamStatusLabel,
} from "./types";
import { defaultRole } from "./types";

function providerName(provider: string): string {
  const meta = PROVIDER_BY_ID[provider as keyof typeof PROVIDER_BY_ID];
  return meta?.name ?? provider;
}

function modelName(provider: string, model: string): string {
  const meta = findModel(provider as ProviderId, model);
  return meta?.name ?? model;
}

export function labelFor(provider: string, model: string): string {
  return modelName(provider, model);
}

/** 后端裁判结果/参与者的固定 id：不占参与者卡片。 */
const JUDGE_ID = "judge";

function isJudgeEntry(id: string | undefined): boolean {
  return id === JUDGE_ID;
}

/** 服务端裁判 label 可能自带"（裁判）"后缀，展示时去掉，避免"裁判：xxx（裁判）"。 */
function cleanJudgeLabel(label: string): string {
  const cleaned = label.replace(/[（(]\s*裁判\s*[)）]\s*$/u, "").trim();
  return cleaned || label;
}

function judgeFromDetail(detail: RunDetail): RunView["judge"] {
  const result = (detail.results ?? []).find((item) => isJudgeEntry(item.participantId));
  if (result) {
    return {
      label: cleanJudgeLabel(result.label || labelFor(result.provider, result.model)),
      provider: result.provider,
      model: result.model,
    };
  }
  const participant = (detail.participants ?? []).find((item) => isJudgeEntry(item.id));
  if (participant) {
    return {
      label: cleanJudgeLabel(participant.label || labelFor(participant.provider, participant.model)),
      provider: participant.provider,
      model: participant.model,
    };
  }
  return undefined;
}

/** 由 ParticipantSpec 造乐观视图（run.start 之前的占位）。 */
export function viewFromSpecs(specs: ParticipantSpec[]): ParticipantView[] {
  return specs.map((spec, index) => ({
    id: `spec-${index}-${spec.provider}-${spec.model}`,
    provider: spec.provider,
    model: spec.model,
    label: labelFor(spec.provider, spec.model),
    role: spec.role?.trim() || defaultRole(index),
    text: "",
    reasoning: "",
    state: "idle",
    effort: spec.effort ?? "medium",
  }));
}

function viewFromParticipant(participant: Participant): ParticipantView {
  return {
    id: participant.id,
    provider: participant.provider,
    model: participant.model,
    label: participant.label || labelFor(participant.provider, participant.model),
    role: participant.role || providerName(participant.provider),
    text: "",
    reasoning: "",
    state: "idle",
    effort: participant.effort ?? "medium",
  };
}

function viewFromResult(result: ParticipantResult): ParticipantView {
  return {
    id: result.participantId,
    provider: result.provider,
    model: result.model,
    label: result.label || labelFor(result.provider, result.model),
    role: result.role || providerName(result.provider),
    text: result.text ?? "",
    reasoning: result.reasoning ?? "",
    usage: result.usage,
    latencyMs: result.latencyMs,
    state: result.error
      ? /停止|已停止/.test(result.error)
        ? "stopped"
        : "error"
      : "done",
    error: result.error,
    effort: result.effort,
    stages: (result.stages ?? [])
      .filter((stage) => typeof stage.text === "string" && stage.text.trim().length > 0)
      .map((stage) => ({ stage: stage.stage, text: stage.text, reasoning: stage.reasoning })),
  };
}

export function viewFromDetail(detail: RunDetail): RunView {
  const byId = new Map<string, ParticipantView>();
  for (const participant of detail.participants ?? []) {
    if (isJudgeEntry(participant.id)) continue;
    byId.set(participant.id, viewFromParticipant(participant));
  }
  for (const result of detail.results ?? []) {
    if (isJudgeEntry(result.participantId)) continue;
    const existing = byId.get(result.participantId);
    const view = viewFromResult(result);
    byId.set(result.participantId, existing ? { ...existing, ...view, id: existing.id } : view);
  }
  const state: RunState =
    detail.status === "running" ? "running" : detail.status === "error" ? "error" : "done";
  return {
    id: detail.id,
    command: detail.command,
    mode: detail.mode,
    state,
    createdAt: detail.createdAt,
    finishedAt: detail.finishedAt,
    participants: [...byId.values()],
    stages: [],
    notices: detail.error ? [{ level: "error", message: detail.error, at: detail.finishedAt ?? Date.now() }] : [],
    finalText: detail.finalText ?? "",
    finalStreaming: false,
    usage: detail.usage,
    error: detail.error,
    origin: "history",
    judge: judgeFromDetail(detail),
    artifacts: detail.artifacts ?? [],
    contexts: [],
    coordination: detail.coordination,
    memoryInjected: memoryCountFromDetail(detail),
    cost: detail.cost?.totalCost,
    attachments: detail.attachments,
    guard: detail.guard,
    threadId: detail.threadId ?? detail.id,
    round: detail.round ?? 1,
    history: detail.history,
  };
}

/** 服务端若回传了本次注入的记忆 id，用它计数；没有就返回 undefined（UI 优雅降级）。 */
function memoryCountFromDetail(detail: RunDetail): number | undefined {
  const rec = detail as unknown as Record<string, unknown>;
  const options = rec.options as Record<string, unknown> | undefined;
  const memoryIds = rec.memoryIds ?? options?.memoryIds;
  if (Array.isArray(memoryIds)) return memoryIds.length;
  return undefined;
}

/* ---------------------------------------------------------------- reducer */

export type RunAction =
  | { type: "reset" }
  | { type: "loading"; id: string }
  | {
      type: "begin";
      id: string;
      command: string;
      mode: RunMode;
      participants: ParticipantSpec[];
      judge?: RunView["judge"];
      coordination?: CoordinationAssignment[];
      memoryInjected?: number;
      attachments?: import("@super-work/core").AttachmentMeta[];
      guard?: import("@super-work/core").RunGuardInfo;
      /** 多轮对话：所属工作与轮次 */
      threadId?: string;
      round?: number;
      now: number;
    }
  | { type: "hydrate"; view: RunView }
  | { type: "snapshot"; detail: RunDetail; now: number }
  | { type: "event"; event: RunEvent; now: number }
  | { type: "stream-status"; status: StreamStatusLabel }
  | { type: "effort-pending"; participantId: string; effort: EffortLevel }
  | { type: "effort-clear"; participantId: string }
  | { type: "memory-count"; count: number }
  | { type: "fail"; message: string; now: number };

function patchParticipant(
  participants: ParticipantView[],
  id: string,
  patch: (current: ParticipantView) => ParticipantView,
): ParticipantView[] {
  return participants.map((participant) => (participant.id === id ? patch(participant) : participant));
}

function appendStage(stages: StageMark[], event: Extract<RunEvent, { type: "stage" }>): StageMark[] {
  const last = stages[stages.length - 1];
  if (last && last.stage === event.stage) {
    return [...stages.slice(0, -1), { stage: event.stage, label: event.label, at: event.at }];
  }
  return [...stages, { stage: event.stage, label: event.label, at: event.at }];
}

function applyEvent(run: RunView, event: RunEvent): RunView {
  switch (event.type) {
    case "run.start": {
      const judgeParticipant = event.participants.find((participant) => isJudgeEntry(participant.id));
      const judge = judgeParticipant
        ? {
            label: cleanJudgeLabel(
              judgeParticipant.label || labelFor(judgeParticipant.provider, judgeParticipant.model),
            ),
            provider: judgeParticipant.provider,
            model: judgeParticipant.model,
          }
        : run.judge;
      const incoming = event.participants
        .filter((participant) => !isJudgeEntry(participant.id))
        .map(viewFromParticipant);
      const previous = new Map(run.participants.map((p) => [`${p.provider}:${p.model}`, p]));
      const participants = incoming.map((participant) => {
        const existing = previous.get(`${participant.provider}:${participant.model}`);
        if (!existing) return participant;
        return {
          ...participant,
          effort: participant.effort ?? existing.effort,
          effortNext: existing.effortNext,
          text: existing.text,
          reasoning: existing.reasoning,
          startedAt: existing.startedAt,
          state: existing.state,
        };
      });
      return {
        ...run,
        mode: event.mode,
        state: "running",
        participants,
        judge,
        stages: [],
        notices: [],
        error: undefined,
        finalText: "",
        finalStreaming: false,
        createdAt: run.createdAt || event.at,
      };
    }
    case "stage":
      return { ...run, stages: appendStage(run.stages, event) };
    case "model.start":
      return {
        ...run,
        participants: patchParticipant(run.participants, event.participantId, (p) => ({
          ...p,
          // 上一次切换的强度从这次调用开始生效
          effort: p.effortNext ?? p.effort,
          effortNext: undefined,
          state: "streaming",
          startedAt: event.at,
          error: undefined,
        })),
      };
    case "model.delta":
      return {
        ...run,
        participants: patchParticipant(run.participants, event.participantId, (p) =>
          event.channel === "reasoning"
            ? { ...p, reasoning: p.reasoning + event.text, state: "streaming", startedAt: p.startedAt ?? event.at }
            : { ...p, text: p.text + event.text, state: "streaming", startedAt: p.startedAt ?? event.at },
        ),
      };
    case "model.done":
      return {
        ...run,
        participants: patchParticipant(run.participants, event.participantId, (p) => ({
          ...p,
          // model.done.text 是服务端清洗文件块后的权威全文，即使比流式累积短也要采用
          text: event.text.length > 0 || p.text.length === 0 ? event.text : p.text,
          state: "done",
          usage: event.usage ?? p.usage,
          latencyMs: event.latencyMs ?? p.latencyMs,
          error: undefined,
        })),
      };
    case "model.error":
      return {
        ...run,
        participants: patchParticipant(run.participants, event.participantId, (p) => ({
          ...p,
          state: "error",
          error: event.message,
        })),
      };
    case "model.stopped":
      return {
        ...run,
        participants: patchParticipant(run.participants, event.participantId, (p) => ({
          ...p,
          // 停止不是失败：保留已生成内容，状态显示「已停止」。
          state: "stopped",
          text: event.text && event.text.length > p.text.length ? event.text : p.text,
          error: undefined,
          latencyMs: p.latencyMs ?? Date.now() - (p.startedAt ?? Date.now()),
        })),
        notices: [
          ...run.notices,
          {
            level: "warn",
            message: event.message ?? "已停止该模型，其余模型继续",
            at: event.at,
          },
        ],
      };
    case "final.delta":
      return {
        ...run,
        finalText: run.finalText + event.text,
        finalStreaming: true,
        stages: run.stages,
      };
    case "final":
      return {
        ...run,
        finalText: event.text || run.finalText,
        finalStreaming: false,
        usage: event.usage ?? run.usage,
      };
    case "notice": {
      const last = run.notices[run.notices.length - 1];
      if (last && last.message === event.message && last.level === event.level) return run;
      return {
        ...run,
        notices: [...run.notices, { level: event.level, message: event.message, at: event.at }],
      };
    }
    case "artifact": {
      const artifact = event.artifact;
      if (!artifact || !artifact.id) return run;
      const exists = run.artifacts.some((item) => item.id === artifact.id);
      return {
        ...run,
        artifacts: exists
          ? run.artifacts.map((item) => (item.id === artifact.id ? artifact : item))
          : [...run.artifacts, artifact],
      };
    }
    case "context": {
      const insight = event.insight;
      if (!insight) return run;
      const call = { ...insight, at: event.at };
      const key = `${insight.participantId}:${insight.stage}:${event.at}`;
      const exists = run.contexts.some(
        (item) => `${item.participantId}:${item.stage}:${item.at}` === key,
      );
      const contexts = exists
        ? run.contexts.map((item) =>
            `${item.participantId}:${item.stage}:${item.at}` === key ? call : item,
          )
        : [...run.contexts, call];
      const injected = new Set<string>();
      for (const item of contexts) {
        for (const id of item.injectedMemoryIds ?? []) injected.add(id);
      }
      return {
        ...run,
        contexts,
        memoryInjected: injected.size > 0 ? injected.size : run.memoryInjected,
      };
    }
    case "run.done":
      return {
        ...run,
        state: run.state === "error" ? "error" : "done",
        participants: run.participants.map((participant) =>
          participant.state === "streaming" || participant.state === "idle"
            ? { ...participant, state: "done" }
            : participant,
        ),
        finishedAt: event.at,
        usage: event.usage ?? run.usage,
        finalStreaming: false,
      };
    case "run.error":
      return {
        ...run,
        state: "error",
        error: event.message,
        participants: run.participants.map((participant) =>
          participant.state === "streaming"
            ? { ...participant, state: "error", error: participant.error ?? event.message }
            : participant,
        ),
        finishedAt: event.at,
        finalStreaming: false,
        notices: [...run.notices, { level: "error", message: event.message, at: event.at }],
      };
    default:
      return run;
  }
}

function applySnapshot(run: RunView, detail: RunDetail): RunView {
  const incoming = viewFromDetail(detail);
  const effortById = new Map((detail.efforts ?? []).map((item) => [item.participantId, item.effort]));
  const previous = new Map(run.participants.map((p) => [p.id, p]));
  const mergedById = new Map<string, ParticipantView>();
  for (const participant of incoming.participants) {
    const existing = previous.get(participant.id);
    if (!existing) {
      mergedById.set(participant.id, participant);
      continue;
    }
    const preferLive = existing.text.length > participant.text.length;
    mergedById.set(participant.id, {
      ...participant,
      role: existing.role || participant.role,
      text: preferLive ? existing.text : participant.text,
      reasoning: existing.reasoning || participant.reasoning,
      state:
        detail.status === "running"
          ? existing.state === "streaming"
            ? "streaming"
            : participant.state
          : detail.status === "error" && (existing.state === "streaming" || existing.state === "idle")
            ? "error"
            : participant.state,
      error:
        detail.status === "error" && existing.state === "streaming"
          ? existing.error ?? detail.error ?? "运行中断"
          : participant.error,
      startedAt: existing.startedAt,
      effort: effortById.get(participant.id) ?? participant.effort ?? existing.effort,
      effortNext: existing.effortNext ?? undefined,
      usage: participant.usage ?? existing.usage,
      latencyMs: participant.latencyMs ?? existing.latencyMs,
      stages: participant.stages && participant.stages.length > 0 ? participant.stages : existing.stages,
    });
  }
  // 保留尚未出现在快照里的乐观卡片
  for (const participant of run.participants) {
    if (isJudgeEntry(participant.id)) continue;
    if (!mergedById.has(participant.id) && run.state === "running") {
      mergedById.set(participant.id, participant);
    }
  }
  const finalText =
    (detail.finalText?.length ?? 0) >= run.finalText.length ? detail.finalText ?? "" : run.finalText;
  return {
    ...run,
    judge: judgeFromDetail(detail) ?? run.judge,
    command: detail.command || run.command,
    mode: detail.mode || run.mode,
    state: incoming.state,
    createdAt: detail.createdAt || run.createdAt,
    finishedAt: detail.finishedAt ?? run.finishedAt,
    participants: [...mergedById.values()],
    finalText,
    finalStreaming: false,
    usage: detail.usage ?? run.usage,
    error: detail.error ?? run.error,
    notices: incoming.notices.length > 0 ? incoming.notices : run.notices,
    artifacts: mergeArtifacts(run.artifacts, incoming.artifacts),
    contexts: mergeContexts(run.contexts, detail),
    coordination: detail.coordination ?? run.coordination,
    memoryInjected: incoming.memoryInjected ?? memoryCountFromDetail(detail) ?? run.memoryInjected,
    cost: detail.cost?.totalCost ?? run.cost,
    attachments: detail.attachments ?? run.attachments,
    guard: detail.guard ?? run.guard,
    threadId: detail.threadId ?? run.threadId,
    round: detail.round ?? run.round,
    history: detail.history ?? run.history,
  };
}

function mergeArtifacts(current: Artifact[], incoming: Artifact[]): Artifact[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, Artifact>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeContexts(
  current: RunView["contexts"],
  detail: RunDetail,
): RunView["contexts"] {
  // RunDetail 目前没有 contexts 字段；服务端新增时按可选字段读取，避免契约未就绪时报错。
  const rec = detail as unknown as Record<string, unknown>;
  const raw = rec.contexts;
  if (!Array.isArray(raw)) return current;
  const calls = raw
    .filter((item): item is ContextInsight & { at?: number } => !!item && typeof item === "object")
    .map((item) => ({ ...item, at: item.at ?? Date.now() }));
  const byKey = new Map<string, RunView["contexts"][number]>();
  for (const item of current) byKey.set(`${item.participantId}:${item.stage}:${item.at}`, item);
  for (const item of calls) byKey.set(`${item.participantId}:${item.stage}:${item.at}`, item);
  return [...byKey.values()];
}

export function runReducer(state: RunView | null, action: RunAction): RunView | null {
  switch (action.type) {
    case "reset":
      return null;
    case "loading":
      return {
        id: action.id,
        command: "",
        mode: "council",
        state: "loading",
        createdAt: Date.now(),
        participants: [],
        stages: [],
        notices: [],
        finalText: "",
        finalStreaming: false,
        origin: "history",
        streamStatus: "idle",
        artifacts: [],
        contexts: [],
      };
    case "begin":
      return {
        id: action.id,
        command: action.command,
        mode: action.mode,
        state: "running",
        createdAt: action.now,
        participants: viewFromSpecs(action.participants),
        stages: [],
        notices: [],
        finalText: "",
        finalStreaming: false,
        origin: "live",
        streamStatus: "connecting",
        judge: action.judge,
        artifacts: [],
        contexts: [],
        coordination: action.coordination,
        memoryInjected: action.memoryInjected,
        attachments: action.attachments,
        guard: action.guard,
        threadId: action.threadId,
        round: action.round,
      };
    case "hydrate":
      return action.view;
    case "snapshot":
      if (!state) return viewFromDetail(action.detail);
      if (state.id !== action.detail.id) return state;
      return applySnapshot(state, action.detail);
    case "event":
      if (!state) return state;
      return applyEvent(state, action.event);
    case "stream-status":
      if (!state) return state;
      return { ...state, streamStatus: action.status };
    case "effort-pending":
      if (!state) return state;
      return {
        ...state,
        participants: patchParticipant(state.participants, action.participantId, (participant) => ({
          ...participant,
          effortNext: action.effort,
        })),
      };
    case "effort-clear":
      if (!state) return state;
      return {
        ...state,
        participants: patchParticipant(state.participants, action.participantId, (participant) => ({
          ...participant,
          effortNext: undefined,
        })),
      };
    case "memory-count":
      if (!state) return state;
      return { ...state, memoryInjected: action.count };
    case "fail":
      if (!state) return state;
      return {
        ...state,
        state: "error",
        error: action.message,
        finishedAt: action.now,
        finalStreaming: false,
      };
    default:
      return state;
  }
}

/* ---------------------------------------------------------------- offline fallback */

/** 后端不可用时，用 core catalog 撑起左栏/右栏，绝不白屏。 */
export function fallbackProviders(): ProviderStatus[] {
  return PROVIDERS.map((meta) => ({
    id: meta.id,
    name: meta.name,
    short: meta.short,
    color: meta.color,
    kind: meta.kind,
    models: meta.models,
    authModes: meta.authModes,
    subscription: meta.subscription,
    purchase: PROVIDER_PURCHASE[meta.id],
    note: meta.note,
    connections: [],
    connected: false,
  }));
}

export function fallbackModels(): ModelOption[] {
  return PROVIDERS.flatMap((meta) =>
    meta.models.map((model) => ({
      ...model,
      available: meta.id === "mock",
      connections: 0,
      disabledReason: meta.id === "mock" ? undefined : "未连接",
    })),
  );
}

/**
 * 演示池：不依赖任何 key，第一次打开就能看到联合工作效果。
 * mock 目录里只有 mock-fast / mock-thinker 两个模型，这里允许同一模型多实例
 * （参与者身份由服务端 id 区分，角色不同即为不同视角），以便演示三方同屏。
 */
export function demoParticipants(): ParticipantSpec[] {
  return [
    { provider: "mock", model: "mock-fast", role: "深度分析" },
    { provider: "mock", model: "mock-thinker", role: "长文与代码" },
    { provider: "mock", model: "mock-fast", role: "风险审查" },
  ];
}

export const DEMO_COMMAND =
  "用三句话说明：多个模型联合工作相比单模型，在什么情况下真的更好？请给一个具体例子。";

let toastSeed = 0;
export function nextToastId(): number {
  toastSeed += 1;
  return toastSeed;
}
