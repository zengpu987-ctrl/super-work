/**
 * 运行上下文：事件发射、单次模型调用（含超时 / 取消 / usage / 记录）、
 * 以及给各模式共用的状态。
 *
 * 约束（DESIGN §6）：
 * - onEvent 必须同步调用，禁止 await；
 * - 每个调用前 model.start，逐块 model.delta，结束 model.done 或 model.error；
 * - model.done.text === 该次调用所有 model.delta(text) 的累加；
 * - 取消时尽快返回，不把取消异常抛给调用方。
 */
import type {
  CoordinationAssignment,
  CustomRoleDef,
  EffortLevel,
  ImageResult,
  OrchestrateArgs,
  OrchestratorDeps,
  Participant,
  ParticipantResult,
  ProviderId,
  ParticipantStageResult,
  PerformanceSettings,
  ConversationTurn,
  RunEvent,
  RunMode,
  RunOptions,
  StageId,
  Usage,
} from "@super-work/core";
import {
  EFFORT_BY_ID,
  applyEffortToMaxTokens,
  findModel,
  normalizeEffort,
  resolveCoordRole,
} from "@super-work/core";
import { buildContextInsight } from "./context.js";
import { extractFileArtifacts } from "./artifacts.js";
import { withFileOutputHint } from "./prompts.js";
import {
  CHEAP_PER_ANSWER_LIMIT,
  DEFAULT_TIMEOUT_MS,
  PER_ANSWER_LIMIT,
  errorMessage,
  hasUsage,
  isAbortLike,
  isAsyncIterable,
  makeCallSignal,
  mergeUsage,
} from "./util.js";

/** KIMI 慢模型（尤其 highspeed / 会员通道）的调用超时下限。 */
export const KIMI_MIN_CALL_TIMEOUT_MS = 180_000;

/** 按平台/模型计算实际调用超时；KIMI 永远不短于 180s。 */
export function effectiveCallTimeoutMs(
  provider: ProviderId,
  _model: string,
  configured: number,
): number {
  const base = Math.max(1, Math.floor(configured));
  return provider === "kimi" ? Math.max(base, KIMI_MIN_CALL_TIMEOUT_MS) : base;
}

export interface ModelCallRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** model.start / stage 上展示的标签，例如「并行作答」「第 2 棒」 */
  label: string;
  /** 本次调用所属阶段，写进 ParticipantResult.stages */
  stage: StageId;
  maxTokens?: number;
  temperature?: number;
  /**
   * 本次调用是否就是「最终答案」的产出者（裁判综合 / 裁决 / 融合 / 汇总）。
   * 为 true 时，每个 text 块在发 model.delta 的同时同步发 final.delta，
   * 让 UI 的最终答案卡片实时流式；最终一致性由 index.ts 的 emitFinal 兜底。
   */
  streamFinal?: boolean;
  /** 本次调用实际注入 system 的记忆文本（计入 context 事件 memory 段）；不传视为未注入 */
  memory?: string;
  /** 本次调用附带的参考资料（计入 context 事件 reference 段） */
  reference?: string;
  /** 本次调用附带的历史对话（计入 context 事件 history 段） */
  history?: string;
}

export interface ImageCallRequest {
  prompt: string;
  size?: string;
  /** model.start 上展示的标签 */
  label: string;
  /** 本次调用所属阶段（context / results.stages 用） */
  stage: StageId;
  /** 注入 context 事件 memory 段；不传视为未注入 */
  memory?: string;
}

export interface ImageCallOutcome {
  ok: boolean;
  aborted: boolean;
  result?: ImageResult;
  /** 同步发过的 model.delta(text) 内容 */
  text: string;
  latencyMs: number;
  error?: string;
}

export interface ModelCallOutcome {
  ok: boolean;
  /** 是否因为外部取消（signal）而中断；true 时不得继续 emit 阶段事件 */
  aborted: boolean;
  text: string;
  reasoning: string;
  usage?: Usage;
  latencyMs: number;
  error?: string;
}

export interface ResolvedOptions {
  critique: boolean;
  rounds: number;
  language: "zh" | "en";
  synthesize: boolean;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  /** 记忆召回注入文本（配合模式下注入发令官与执行角色） */
  memoryContext?: string;
  /** 本次注入记忆的 id 列表（用于上下文洞察） */
  memoryIds?: string[];
  /** 生图尺寸（配合模式 image 角色） */
  imageSize?: string;
  /** 默认强度档位（参与者未单独指定时使用，缺省 medium） */
  defaultEffort?: EffortLevel;
  /** 省钱模式：默认档位 low、关闭互评、参考材料每人截断 2000 字 */
  cheapMode: boolean;
  /** 单次调用输出上限（预算守卫） */
  perCallMaxTokens?: number;
  /** 性能设置快照（并发 / 超时 / 默认输出 / 节流） */
  performance?: PerformanceSettings;
  /** 并发池大小（1~8，默认 3） */
  concurrency: number;
  /** 单次运行 token 预算；超出后停止剩余调用 */
  budgetLimitTokens?: number;
  /** 附件提取文本（server 拼好，注入 commander/specialist） */
  attachmentsContext?: string;
  /** 自定义角色定义（配合模式） */
  customRoles?: CustomRoleDef[];
  /** 多轮对话历史（server 按预算组装）；以 user/assistant 消息注入每次调用 */
  conversation?: ConversationTurn[];
  /** 历史是否因预算被截断 */
  conversationTruncated?: boolean;
}

type ModelChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage };

/** 解析 RunOptions，给出各模式的默认值。 */
export function resolveOptions(raw?: RunOptions): ResolvedOptions {
  const roundsRaw =
    typeof raw?.rounds === "number" && Number.isFinite(raw.rounds) ? Math.floor(raw.rounds) : 2;
  const performance = raw?.performance;
  // 超时：性能设置优先，其次旧的 options.timeoutMs，最后默认 180s。
  const timeoutRaw = firstFinite(performance?.timeoutMs, raw?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const cheapMode = raw?.cheapMode === true;
  const concurrencyRaw =
    firstFinite(raw?.concurrency, performance?.concurrency) ?? DEFAULT_CONCURRENCY;
  return {
    // 省钱模式关闭互评轮（council / debate 的额外上下文开销）。
    critique: raw?.critique !== false && !cheapMode,
    rounds: Math.max(1, Math.min(roundsRaw, 8)),
    language: raw?.language === "en" ? "en" : "zh",
    synthesize: raw?.synthesize !== false,
    timeoutMs: Math.max(1, Math.floor(timeoutRaw)),
    maxTokens: raw?.maxTokens,
    temperature: raw?.temperature,
    memoryContext: raw?.memoryContext,
    memoryIds: Array.isArray(raw?.memoryIds) ? raw.memoryIds.filter((id) => typeof id === "string") : undefined,
    imageSize: raw?.imageSize,
    defaultEffort: normalizeEffort(raw?.defaultEffort),
    cheapMode,
    perCallMaxTokens: positiveNumber(raw?.perCallMaxTokens),
    performance,
    concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(concurrencyRaw))),
    budgetLimitTokens: positiveNumber(raw?.budgetLimitTokens),
    attachmentsContext: typeof raw?.attachmentsContext === "string" ? raw.attachmentsContext : undefined,
    customRoles: Array.isArray(raw?.customRoles) ? raw.customRoles : undefined,
    conversation: Array.isArray(raw?.conversation) ? raw.conversation : undefined,
    conversationTruncated: raw?.conversationTruncated === true,
  };
}

/** 把前几轮对话拼成 user/assistant 消息（真正进入模型请求，而不是只做展示）。 */
function conversationMessages(
  conversation: ConversationTurn[] | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!conversation || conversation.length === 0) return [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const turn of conversation) {
    if (!turn.command.trim() || !turn.finalText.trim()) continue;
    out.push({ role: "user", content: turn.command });
    out.push({ role: "assistant", content: turn.finalText });
  }
  return out;
}

/** 历史文本仅用于上下文洞察的 token 估算（与注入的消息同源）。 */
function conversationText(conversation: ConversationTurn[] | undefined): string {
  if (!conversation || conversation.length === 0) return "";
  return conversation
    .map((turn) => `【第 ${turn.round} 轮】\n用户：${turn.command}\n最终答案：${turn.finalText}`)
    .join("\n\n");
}

/** 取第一个有限的正数（并发/超时/上限等）。 */
function firstFinite(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 取所有已定义正数的最小值（maxTokens 多重夹紧）。 */
function minPositive(...values: Array<number | undefined>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    result = result === undefined ? value : Math.min(result, value);
  }
  return result;
}

/** 累计 token（优先 totalTokens，缺失时用 input + output）。 */
export function usageTokens(usage: Usage): number {
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
    return usage.totalTokens;
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/**
 * 解析本次调用生效的强度档位。
 * 必须每次调用重新读 participant.effort：server 运行中会直接改这个对象，
 * 缓存到 run 开始就会让「下一次调用生效」失效。
 * 省钱模式：未显式指定档位的参与者默认 low。
 */
export function resolveEffort(
  participant: Pick<Participant, "effort">,
  options: Pick<ResolvedOptions, "defaultEffort" | "cheapMode">,
): EffortLevel {
  const explicit = normalizeEffort(participant.effort);
  // 省钱模式：把「默认档位 medium」降到 low（server/web 会把默认值预填成 medium）；
  // 用户显式选择的 low/fast/max/ultra 保持不动。
  if (options.cheapMode && (!explicit || explicit === "medium")) return "low";
  if (explicit) return explicit;
  return options.defaultEffort ?? "medium";
}

/** 在 system prompt 末尾追加当前强度档位说明（不改动原有提示词结构）。 */
export function withEffortHint(system: string, effort: EffortLevel): string {
  const meta = EFFORT_BY_ID[effort];
  const hint = `## 强度档位\n${meta.name}：${meta.hint}`;
  const base = (system ?? "").trimEnd();
  return base ? `${base}\n\n${hint}` : hint;
}

/** 默认单次输出上限基数（未配置 options.maxTokens 时）。 */
const DEFAULT_MAX_TOKENS = 4096;
/** 默认并发池大小（DESIGN v0.0.3 §4）。 */
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

/**
 * 参与者的唯一来源是 args.participants（带 id）；若上游只填了 request.participants，
 * 这里按顺序补出稳定 id，避免整轮空转。
 *
 * 注意：args.participants 是 server 传进来的运行态对象，运行中 server 会原地修改
 * `participant.effort`（POST /api/runs/:id/effort）。因此这里只补缺省字段，
 * **不复制对象**——复制会让热调对 orchestrator 不可见。
 */
export function normalizeParticipants(args: OrchestrateArgs): Participant[] {
  const given = Array.isArray(args.participants) ? args.participants : [];
  if (given.length > 0) {
    return given.map((participant, index) => {
      if (!participant.id) participant.id = `p${index + 1}`;
      if (!participant.label) participant.label = `${participant.provider}/${participant.model}`;
      if (!participant.role) participant.role = "";
      return participant;
    });
  }
  const specs = Array.isArray(args.request?.participants) ? args.request.participants : [];
  return specs.map((spec, index) => ({
    id: `p${index + 1}`,
    provider: spec.provider,
    model: spec.model,
    label: `${spec.provider}/${spec.model}`,
    role: spec.role || "",
    effort: spec.effort,
  }));
}

/** 解析后的一个配合模式角色（内置或自定义）。 */
export interface CoordinationRole {
  /** 角色 id：内置 8 个之一，或 customRoles 里的 id */
  id: string;
  /** 展示名（事件 label / 产物标题用，不再硬编码 8 个） */
  name: string;
  /** 角色职责说明（自定义角色提示词用） */
  description: string;
  kind: "text" | "image";
  order: number;
  builtin: boolean;
  participants: Participant[];
}

export class RunContext {
  readonly args: OrchestrateArgs;
  readonly deps: OrchestratorDeps;
  readonly options: ResolvedOptions;
  readonly participants: Participant[];
  readonly judge: Participant;
  readonly mode: RunMode;
  readonly command: string;
  readonly language: "zh" | "en";
  readonly signal?: AbortSignal;

  private readonly onEvent: (event: RunEvent) => void;
  private readonly records = new Map<string, ParticipantResult>();
  private readonly participantMap = new Map<string, Participant>();
  private readonly emptyTextNoticed = new Set<string>();
  private rawCoordinationCache?: CoordinationAssignment[];
  private coordinationRoleCache?: CoordinationRole[];
  private unknownRoleCache?: string[];
  private budgetStopped = false;
  private totalUsage: Usage = {};
  private streamedFinal = "";
  /** 每个参与者当前的调用中止器（单独停止某个模型用） */
  private readonly callStops = new Map<string, AbortController>();
  /** 被用户单独停止的参与者：后续调用直接跳过 */
  private readonly userStopped = new Set<string>();

  constructor(
    args: OrchestrateArgs,
    deps: OrchestratorDeps,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
  ) {
    this.args = args;
    this.deps = deps;
    this.onEvent = onEvent;
    this.signal = signal;
    this.options = resolveOptions({ ...args.request?.options, ...args.options });
    this.mode = (args.request?.mode ?? "council") as RunMode;
    this.command = args.request?.command ?? "";
    this.language = this.options.language;
    this.participants = normalizeParticipants(args);
    this.judge = (args.judge ?? this.participants[0]) as Participant;
    for (const participant of this.participants) this.register(participant);
    if (this.judge) this.register(this.judge);
  }

  get usage(): Usage {
    return this.totalUsage;
  }

  get aborted(): boolean {
    return this.signal?.aborted === true;
  }

  /**
   * 单独停止某个参与模型：
   * - 正在进行的调用立即中断（保留已生成内容）；
   * - 还在排队的调用被标记，轮到时直接跳过（发 model.stopped）；
   * - 其余模型照常跑。
   * 返回 false 表示该 id 不在本次运行里或已经停止过。
   */
  stopParticipant(participantId: string): boolean {
    const participant = this.participantMap.get(participantId);
    if (!participant) return false;
    if (this.userStopped.has(participantId)) return false;
    this.userStopped.add(participantId);
    const active = this.callStops.get(participantId);
    active?.abort();
    this.emit({
      type: "notice",
      level: "warn",
      message: `已停止 ${participant.label || participantId}，其余模型继续`,
      at: Date.now(),
    });
    return true;
  }

  stoppedParticipants(): string[] {
    return [...this.userStopped];
  }

  /** 单个参与者是否已被用户停止。 */
  isParticipantStopped(participantId: string): boolean {
    return this.userStopped.has(participantId);
  }

  get hasParticipants(): boolean {
    return this.participants.length > 0;
  }

  /** 并发池大小（性能设置，1~8，默认 3）。 */
  get concurrency(): number {
    return this.options.concurrency;
  }

  /** 省钱模式（默认档位 low / 关闭互评 / 参考材料截断 2000 字）。 */
  get cheapMode(): boolean {
    return this.options.cheapMode;
  }

  /**
   * 附件上下文（server 拼好）：注入所有模式的非裁判参与者 system，
   * 并计入 context 事件的 reference 段。
   */
  get attachmentsContext(): string {
    return (this.options.attachmentsContext ?? "").trim();
  }

  /**
   * 参考材料每人保留的字数：
   * 省钱模式统一截断到 2000 字，否则沿用调用方给的上限（默认 4000）。
   */
  answerLimit(defaultLimit = PER_ANSWER_LIMIT): number {
    return this.options.cheapMode ? Math.min(defaultLimit, CHEAP_PER_ANSWER_LIMIT) : defaultLimit;
  }

  /** 预算守卫是否已经触发（触发后剩余模型调用直接跳过）。 */
  get budgetExceeded(): boolean {
    return this.budgetStopped;
  }

  /** 配合模式下真正配置了角色的编排（只过滤掉空参与者数组）。 */
  get coordination(): CoordinationAssignment[] {
    if (this.rawCoordinationCache) return this.rawCoordinationCache;
    const raw = this.args.request?.coordination;
    const list = Array.isArray(raw)
      ? raw.filter(
          (assignment) =>
            assignment &&
            typeof assignment.role === "string" &&
            Array.isArray(assignment.participants) &&
            assignment.participants.length > 0,
        )
      : [];
    this.rawCoordinationCache = list;
    return list;
  }

  get hasCoordination(): boolean {
    return this.coordination.length > 0;
  }

  /**
   * 未知角色（既非 8 个内置，也不在 options.customRoles 里）。
   * index.ts 会在任何模型调用前用它发 run.error，保证 0 调用。
   */
  unknownCoordinationRoles(): string[] {
    if (this.unknownRoleCache) return this.unknownRoleCache;
    const unknown: string[] = [];
    for (const assignment of this.coordination) {
      const meta = resolveCoordRole(assignment.role, this.options.customRoles);
      if (!meta.builtin && !meta.custom && !unknown.includes(assignment.role)) {
        unknown.push(assignment.role);
      }
    }
    this.unknownRoleCache = unknown;
    return unknown;
  }

  get hasUnknownCoordinationRoles(): boolean {
    return this.unknownCoordinationRoles().length > 0;
  }

  /**
   * 把 coordination 解析成按角色分组的结果（内置 + 自定义角色）。
   * - 能在 args.participants 里按 provider+model 对上号时复用（id / label 一致，热调档位可见）；
   * - 否则合成一个稳定 id（coord-role-n），保证未出现在 participants 里的角色也能跑；
   * - 解析结果会注册进 results，方便 UI 展示全部配置角色。
   */
  coordinationRoles(): CoordinationRole[] {
    if (this.coordinationRoleCache) return this.coordinationRoleCache;
    const map = new Map<string, CoordinationRole>();
    const used = new Set<string>();
    for (const assignment of this.coordination) {
      const meta = resolveCoordRole(assignment.role, this.options.customRoles);
      // 未知角色由 index.ts 提前报错；这里防御性地跳过，保证 0 调用。
      if (!meta.builtin && !meta.custom) continue;
      let role = map.get(assignment.role);
      if (!role) {
        role = {
          id: assignment.role,
          name: meta.name,
          description: meta.description,
          kind: meta.kind,
          order: meta.order,
          builtin: meta.builtin,
          participants: [],
        };
        map.set(assignment.role, role);
      }
      for (const spec of assignment.participants) {
        if (!spec || !spec.provider || !spec.model) continue;
        const match = this.participants.find(
          (candidate) =>
            !used.has(candidate.id) &&
            candidate.provider === spec.provider &&
            candidate.model === spec.model,
        );
        let participant: Participant;
        if (match) {
          used.add(match.id);
          participant = match;
        } else {
          participant = {
            id: `coord-${assignment.role}-${role.participants.length + 1}`,
            provider: spec.provider,
            model: spec.model,
            label: `${spec.provider}/${spec.model}`,
            role: spec.role || meta.name,
            effort: spec.effort,
          };
        }
        this.register(participant);
        role.participants.push(participant);
      }
    }
    const roles = [...map.values()].filter((role) => role.participants.length > 0);
    this.coordinationRoleCache = roles;
    return roles;
  }

  /**
   * 已经通过 final.delta 实时发出的最终答案文本。
   * 非空表示最终产出者已经把内容流出来了，index.ts 只补发差异部分。
   */
  get streamedFinalText(): string {
    return this.streamedFinal;
  }

  /** run.start 里展示的参与者：参赛者（配合模式含各角色）+ 独立裁判（若不在列表里）。 */
  announcedParticipants(): Participant[] {
    const list = [...this.participants];
    if (this.mode === "coordinate") {
      for (const role of this.coordinationRoles()) {
        for (const participant of role.participants) {
          if (!list.some((item) => item.id === participant.id)) list.push(participant);
        }
      }
    }
    if (this.judge && !list.some((participant) => participant.id === this.judge.id)) {
      list.push(this.judge);
    }
    return list;
  }

  participantById(id: string): Participant | undefined {
    const known = this.participantMap.get(id);
    if (known) return known;
    return this.participants.find((participant) => participant.id === id) ?? this.judge;
  }

  /** 记一个参与者，保证 results 顺序稳定、失败也有条目。 */
  register(participant: Participant): void {
    if (!participant || !participant.id) return;
    this.participantMap.set(participant.id, participant);
    if (this.records.has(participant.id)) return;
    this.records.set(participant.id, {
      participantId: participant.id,
      provider: participant.provider,
      model: participant.model,
      label: participant.label,
      role: participant.role || "",
      text: "",
      latencyMs: 0,
    });
  }

  /** 同步发射事件；监听器抛错不影响主流程。 */
  emit(event: RunEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // 监听器（SSE 写入等）失败不应打断联合工作。
    }
  }

  listResults(): ParticipantResult[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      stages: record.stages ? record.stages.map((stage) => ({ ...stage })) : undefined,
    }));
  }

  /** 已有成功产出的最长文本（兜底最终答案用）。 */
  longestText(): string {
    let best = "";
    for (const record of this.records.values()) {
      if (record.text.length > best.length) best = record.text;
    }
    return best;
  }

  /** 所有成功产出（按记录顺序）。 */
  successfulTexts(): Array<{ participantId: string; label: string; text: string }> {
    const out: Array<{ participantId: string; label: string; text: string }> = [];
    for (const record of this.records.values()) {
      if (record.text.trim()) {
        out.push({ participantId: record.participantId, label: record.label, text: record.text });
      }
    }
    return out;
  }

  /**
   * 执行一次模型调用：负责 model.start / model.delta / model.done|error 事件与超时。
   * 永不抛异常（监听器异常已被 emit 吞掉）。
   */
  async call(participant: Participant, request: ModelCallRequest): Promise<ModelCallOutcome> {
    this.register(participant);
    // 预算已超限：剩余调用直接跳过（不再发 context/model.start，也不产生费用）。
    if (this.budgetStopped) {
      return { ok: false, aborted: true, text: "", reasoning: "", latencyMs: 0 };
    }
    // 已被用户单独停止：排队中的模型跳过本次调用（其余模型继续）。
    if (this.userStopped.has(participant.id)) {
      const message = "已被用户停止，本次调用跳过";
      this.emit({ type: "model.stopped", participantId: participant.id, message, at: Date.now() });
      this.markStopped(participant, "", "", undefined, 0, message);
      return { ok: false, aborted: false, text: "", reasoning: "", latencyMs: 0, error: message };
    }
    const startedAt = Date.now();
    // 强度档位：每次调用重新读 participant.effort（server 可运行中热改），不做缓存。
    const effort = resolveEffort(participant, this.options);
    const effortMeta = EFFORT_BY_ID[effort];
    const system = withEffortHint(withFileOutputHint(request.system), effort);
    // 多轮对话：把前几轮作为 user/assistant 消息放在本轮消息之前，
    // 上下文洞察按 history 段计量，和实际进入请求的文本同源。
    const historyMessages = conversationMessages(this.options.conversation);
    const historyText = historyMessages.length > 0 ? conversationText(this.options.conversation) : "";
    const messages = historyMessages.length > 0 ? [...historyMessages, ...request.messages] : request.messages;
    const baseMaxTokens = request.maxTokens ?? this.options.maxTokens ?? DEFAULT_MAX_TOKENS;
    // 多重夹紧：档位倍率 → 单次调用上限 → 性能默认上限 → 模型自身输出上限。
    const maxTokens = minPositive(
      applyEffortToMaxTokens(effort, baseMaxTokens),
      this.options.perCallMaxTokens,
      this.options.performance?.defaultMaxTokens,
      findModel(participant.provider, participant.model)?.maxOutputTokens,
    );
    // 每次 chat 调用开始前先发上下文洞察（与 model.start 紧邻，顺序稳定）。
    this.emit({
      type: "context",
      participantId: participant.id,
      stage: request.stage,
      insight: buildContextInsight({
        participantId: participant.id,
        provider: participant.provider,
        model: participant.model,
        stage: request.stage,
        texts: {
          system,
          command: this.command,
          memory: request.memory ?? "",
          reference: request.reference ?? "",
          history: request.history ?? historyText,
        },
        injectedMemoryIds: this.options.memoryIds,
      }),
      at: startedAt,
    });
    this.emit({
      type: "model.start",
      participantId: participant.id,
      at: startedAt,
      label: request.label,
    });

    if (this.aborted) {
      return { ok: false, aborted: true, text: "", reasoning: "", latencyMs: 0 };
    }

    const callTimeoutMs = effectiveCallTimeoutMs(
      participant.provider,
      participant.model,
      this.options.timeoutMs,
    );
    const { signal: baseSignal, timeoutSignal } = makeCallSignal(this.signal, callTimeoutMs);
    // 单独的模型停止沿用同一条调用链：stop.signal 只作用于这一个参与者。
    const stop = new AbortController();
    this.callStops.set(participant.id, stop);
    const signal = AbortSignal.any([baseSignal, stop.signal]);
    let text = "";
    let reasoning = "";
    let usage: Usage = {};
    let failure: string | undefined;
    let aborted = false;

    try {
      const raw = this.deps.callModel({
        provider: participant.provider,
        model: participant.model,
        relayId: participant.relayId,
        system,
        messages,
        maxTokens,
        temperature: effortMeta.temperature,
        reasoning: effortMeta.reasoning ?? undefined,
        effort,
        signal,
      });
      const stream: AsyncIterable<ModelChunk> = isAsyncIterable<ModelChunk>(raw)
        ? raw
        : await (raw as unknown as Promise<AsyncIterable<ModelChunk>>);

      for await (const chunk of stream) {
        if (this.aborted) {
          aborted = true;
          break;
        }
        if (chunk.type === "text") {
          if (!chunk.text) continue;
          text += chunk.text;
          this.emit({
            type: "model.delta",
            participantId: participant.id,
            channel: "text",
            text: chunk.text,
            at: Date.now(),
          });
          // 最终答案的产出者：与 model.delta 同步把同一块发给 final.delta。
          if (request.streamFinal) {
            this.streamedFinal += chunk.text;
            this.emit({ type: "final.delta", text: chunk.text, at: Date.now() });
          }
        } else if (chunk.type === "reasoning") {
          if (!chunk.text) continue;
          reasoning += chunk.text;
          this.emit({
            type: "model.delta",
            participantId: participant.id,
            channel: "reasoning",
            text: chunk.text,
            at: Date.now(),
          });
        } else if (chunk.type === "usage") {
          usage = mergeUsage(usage, chunk.usage);
        }
      }
    } catch (error) {
      if (this.aborted) aborted = true;
      else if (timeoutSignal.aborted) failure = `模型调用超时（${callTimeoutMs}ms）`;
      else if (isAbortLike(error) && timeoutSignal.aborted) {
        failure = `模型调用超时（${callTimeoutMs}ms）`;
      } else failure = errorMessage(error);
    } finally {
      this.callStops.delete(participant.id);
    }

    const latencyMs = Date.now() - startedAt;

    // 用户单方面停止了这个模型：不算失败，也不停止整轮，只把这一个标记为「已停止」。
    if (stop.signal.aborted && !aborted) {
      const message = "用户停止了该模型的本次调用（已保留部分输出）";
      this.emit({ type: "model.stopped", participantId: participant.id, text, message, at: Date.now() });
      this.markStopped(participant, text, reasoning, usage, latencyMs, message);
      return { ok: false, aborted: false, text, reasoning, latencyMs, error: message };
    }

    if (aborted) {
      return { ok: false, aborted: true, text, reasoning, latencyMs };
    }
    if (!failure && timeoutSignal.aborted) {
      failure = `模型调用超时（${callTimeoutMs}ms）`;
    }
    if (failure) {
      this.emit({
        type: "model.error",
        participantId: participant.id,
        message: failure,
        at: Date.now(),
      });
      this.markFailure(participant, failure);
      return { ok: false, aborted: false, text, reasoning, latencyMs, error: failure };
    }

    // 模型用 ```file name="..."``` 交付成品：解析成 artifact，正文从回答里剔除。
    const extracted = extractFileArtifacts(text);
    if (extracted.files.length > 0) {
      for (const file of extracted.files) {
        this.emit({
          type: "artifact",
          participantId: participant.id,
          artifact: {
            id: `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            kind: "file",
            title: file.title,
            mime: file.mime,
            text: file.content,
            meta: { ext: file.ext, size: file.content.length, source: "model", participantId: participant.id },
            createdAt: Date.now(),
          },
          at: Date.now(),
        });
      }
      text = extracted.text;
      // 已经流出去的原文包含文件块；把「已流出」对齐到清洗后的文本，收尾时 final 事件会用干净文本覆盖。
      if (request.streamFinal) this.streamedFinal = text;
    }

    const outcomeUsage = hasUsage(usage) ? usage : undefined;
    this.emit({
      type: "model.done",
      participantId: participant.id,
      text,
      usage: outcomeUsage,
      latencyMs,
      at: Date.now(),
      effort,
    });
    this.totalUsage = mergeUsage(this.totalUsage, outcomeUsage);
    // 预算守卫：累计 token 超限 → 停掉剩余调用（已产出内容由上层正常收尾）。
    this.enforceBudget();
    this.markSuccess(participant, request.stage, text, reasoning, outcomeUsage, latencyMs, effort);
    // 思考吃光 token 预算：有 reasoning、没正文，UI 会显示「已完成但空答案」，给一句提示。
    if (!text.trim() && reasoning.trim()) this.noticeReasoningOnly(participant);
    return { ok: true, aborted: false, text, reasoning, usage: outcomeUsage, latencyMs };
  }

  /**
   * 执行一次生图调用（配合模式 image 角色）：事件语义与 call() 对齐，
   * 但它走 deps.generateImage，不产生 chat 流式正文。
   * 未配置生图能力 / 调用失败时只发 model.error 并返回失败，不抛异常。
   */
  async image(participant: Participant, request: ImageCallRequest): Promise<ImageCallOutcome> {
    this.register(participant);
    // 预算已超限：剩余生图调用也跳过。
    if (this.budgetStopped) {
      return { ok: false, aborted: true, text: "", latencyMs: 0 };
    }
    // 已被用户单独停止：跳过这次生图（其余角色继续）。
    if (this.userStopped.has(participant.id)) {
      const message = "已被用户停止，本次调用跳过";
      this.emit({ type: "model.stopped", participantId: participant.id, message, at: Date.now() });
      this.markStopped(participant, "", "", undefined, 0, message);
      return { ok: false, aborted: false, text: "", latencyMs: 0, error: message };
    }
    const startedAt = Date.now();
    // 同 call()：每次调用重新读档位；生图接口没有 effort 参数，只记录生效档位。
    const effort = resolveEffort(participant, this.options);
    this.emit({
      type: "context",
      participantId: participant.id,
      stage: request.stage,
      insight: buildContextInsight({
        participantId: participant.id,
        provider: participant.provider,
        model: participant.model,
        stage: request.stage,
        texts: { command: this.command, memory: request.memory ?? "" },
        injectedMemoryIds: this.options.memoryIds,
      }),
      at: startedAt,
    });
    this.emit({
      type: "model.start",
      participantId: participant.id,
      at: startedAt,
      label: request.label,
    });

    if (this.aborted) {
      return { ok: false, aborted: true, text: "", latencyMs: 0 };
    }

    const generate = this.deps.generateImage?.bind(this.deps);
    if (!generate) {
      const failure = `未配置生图能力（${participant.provider}/${participant.model}）`;
      this.emit({ type: "model.error", participantId: participant.id, message: failure, at: Date.now() });
      this.markFailure(participant, failure);
      return { ok: false, aborted: false, text: "", latencyMs: Date.now() - startedAt, error: failure };
    }

    const stop = new AbortController();
    this.callStops.set(participant.id, stop);
    const imageSignal = this.signal ? AbortSignal.any([this.signal, stop.signal]) : stop.signal;
    try {
      const result = await generate({
        provider: participant.provider,
        model: participant.model,
        relayId: participant.relayId,
        prompt: request.prompt,
        size: request.size,
        signal: imageSignal,
      });
      const latencyMs = Date.now() - startedAt;
      if (this.aborted) return { ok: false, aborted: true, text: "", latencyMs };
      if (stop.signal.aborted) {
        const message = "用户停止了该模型的生图调用";
        this.emit({ type: "model.stopped", participantId: participant.id, message, at: Date.now() });
        this.markStopped(participant, "", "", undefined, latencyMs, message);
        return { ok: false, aborted: false, text: "", latencyMs, error: message };
      }
      const count = result?.images?.length ?? 0;
      const text = count > 0 ? `已生成 ${count} 张图片` : "生图完成，但未返回图片";
      this.emit({
        type: "model.delta",
        participantId: participant.id,
        channel: "text",
        text,
        at: Date.now(),
      });
      this.emit({
        type: "model.done",
        participantId: participant.id,
        text,
        latencyMs,
        at: Date.now(),
        effort,
      });
      this.markSuccess(participant, request.stage, text, "", undefined, latencyMs, effort);
      return { ok: true, aborted: false, result, text, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (this.aborted) return { ok: false, aborted: true, text: "", latencyMs };
      if (stop.signal.aborted) {
        const message = "用户停止了该模型的生图调用";
        this.emit({ type: "model.stopped", participantId: participant.id, message, at: Date.now() });
        this.markStopped(participant, "", "", undefined, latencyMs, message);
        return { ok: false, aborted: false, text: "", latencyMs, error: message };
      }
      const failure = errorMessage(error);
      this.emit({ type: "model.error", participantId: participant.id, message: failure, at: Date.now() });
      this.markFailure(participant, failure);
      return { ok: false, aborted: false, text: "", latencyMs, error: failure };
    } finally {
      this.callStops.delete(participant.id);
    }
  }

  /**
   * 预算守卫：累计 token 超过 options.budgetLimitTokens 时停止剩余调用。
   * 已完成的调用与产出保留，index.ts 照常发 final（不把整轮判失败）。
   */
  private enforceBudget(): void {
    if (this.budgetStopped) return;
    const limit = this.options.budgetLimitTokens;
    if (limit === undefined) return;
    const used = usageTokens(this.totalUsage);
    if (used <= limit) return;
    this.budgetStopped = true;
    this.emit({
      type: "notice",
      level: "error",
      message: "本次运行已超出预算上限，已停止剩余调用",
      at: Date.now(),
    });
  }

  /** 每个参与者在一次运行里最多提示一次「只有思考没有正文」。 */
  private noticeReasoningOnly(participant: Participant): void {
    if (this.emptyTextNoticed.has(participant.id)) return;
    this.emptyTextNoticed.add(participant.id);
    this.emit({
      type: "notice",
      level: "warn",
      message: `${participant.label} 的思考内容用尽了本次调用的 token 预算，未产出正文；建议提高 maxTokens 或改用非推理模型。`,
      at: Date.now(),
    });
  }

  private markSuccess(
    participant: Participant,
    stage: StageId,
    text: string,
    reasoning: string,
    usage: Usage | undefined,
    latencyMs: number,
    effort: EffortLevel,
  ): void {
    const record = this.records.get(participant.id);
    if (!record) return;
    // 先到先得：results.text / reasoning 保留首个非空的成功作答，后续阶段不覆盖。
    if (!record.text.trim() && text.trim()) record.text = text;
    if (!record.reasoning?.trim() && reasoning.trim()) record.reasoning = reasoning;
    if (usage) record.usage = mergeUsage(record.usage ?? {}, usage);
    record.latencyMs = (record.latencyMs ?? 0) + latencyMs;
    // 档位取最近一次成功调用（运行中热改后，历史详情显示最终生效档位）。
    record.effort = effort;
    delete record.error;
    this.recordStage(record, stage, text, reasoning);
  }

  /**
   * 记录某个阶段的发言（UI 用来在卡片里切换「作答 / 互评 / 反驳」）：
   * - 同一 stage 再次成功（重试 / 多轮）以最后一次为准，不重复追加；
   * - 只有思考、没有正文的调用不产生空 stage。
   */
  private recordStage(
    record: ParticipantResult,
    stage: StageId,
    text: string,
    reasoning: string,
  ): void {
    if (!text.trim()) return;
    const stages = (record.stages ??= []);
    const entry: ParticipantStageResult = { stage, text };
    if (reasoning.trim()) entry.reasoning = reasoning;
    const existing = stages.findIndex((item) => item.stage === stage);
    if (existing >= 0) stages[existing] = entry;
    else stages.push(entry);
  }

  private markFailure(participant: Participant, message: string): void {
    const record = this.records.get(participant.id);
    if (!record) return;
    // 已经成功产出过的参与者不因后续阶段失败被标成失败。
    if (!record.text.trim()) record.error = message;
  }

  /** 单独停止：保留已生成内容，但记录里标为已停止（历史回看能看出来）。 */
  private markStopped(
    participant: Participant,
    text: string,
    reasoning = "",
    usage?: Usage,
    latencyMs = 0,
    message = "已被用户停止",
  ): void {
    const record = this.records.get(participant.id);
    if (!record) return;
    if (text.trim() && text.length > record.text.length) record.text = text;
    if (reasoning.trim() && !record.reasoning?.trim()) record.reasoning = reasoning;
    if (usage) record.usage = mergeUsage(record.usage ?? {}, usage);
    if (latencyMs > 0) record.latencyMs = (record.latencyMs ?? 0) + latencyMs;
    record.error = message;
  }
}

/** 构造运行上下文。 */
export function createRunContext(
  args: OrchestrateArgs,
  deps: OrchestratorDeps,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): RunContext {
  return new RunContext(args, deps, onEvent, signal);
}
