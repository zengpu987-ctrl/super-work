import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PROVIDER_BY_ID,
  resolveCoordRole,
  estimateTokens,
  type AppSettings,
  type Artifact,
  type ConversationTurn,
  type CoordinationAssignment,
  type CreateRunRequest,
  type MemoryHit,
  type Participant,
  type ParticipantSpec,
  type RunDetail,
  type RunEvent,
  type RunListItem,
  type RunOptions,
  type RunRecord,
  type ThreadDetail,
  type ThreadSummary,
  type Usage,
  type AttachmentMeta,
  type KeywordHit,
  type RunGuardInfo,
} from "@super-work/core";
import { orchestrate } from "@super-work/orchestrator";
import type { RunRow, Storage } from "./storage.js";
import type { ModelRegistry } from "./registry.js";
import type { BillingService } from "./billing.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";
import { materializeOutputFile } from "./export.js";
import { directFetch, type Paths } from "./config.js";
import {
  UploadStoreLike,
  applyKeywords,
  composeAttachmentsContext,
  isKnownRole,
} from "./v3.js";

/** 只用到的记忆接口，避免 server 与实现包强耦合。 */
export interface MemoryReader {
  search(query: string, limit?: number): MemoryHit[];
  markUsed(ids: string[]): void;
}

/** 预算/角色校验失败：routes 用它映射 409/400。 */
export class RunRequestError extends Error {
  constructor(
    message: string,
    readonly code: "budget_exceeded" | "budget_confirm" | "unknown_role" | "attachment_error",
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RunRequestError";
  }
}

interface LiveRun {
  id: string;
  record: RunRecord;
  participants: Participant[];
  judge?: Participant;
  abort: AbortController;
  subscribers: Set<(entry: { seq: number; event: RunEvent }) => void>;
  lastSeq: number;
  done: boolean;
  lastModelError?: string;
  artifacts: Artifact[];
  coordination?: CoordinationAssignment[];
  options?: RunRecord["options"];
  guard?: RunGuardInfo;
  attachments?: AttachmentMeta[];
  /** 多轮对话：所属工作 id */
  threadId: string;
  /** 多轮对话：第几轮 */
  round: number;
  /** 运行期控制句柄：单独停止某个模型 */
  control?: import("@super-work/core").RunControl;
}

export interface RunManagerOptions {
  billing?: BillingService;
  memory?: MemoryReader;
  paths?: Paths;
  uploads?: UploadStoreLike;
}

const MAX_PARTICIPANTS = 16;

function mergeUsage(total: Usage, next?: Usage): Usage {
  if (!next) return total;
  return {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens:
      (total.totalTokens ?? 0) + (next.totalTokens ?? (next.inputTokens ?? 0) + (next.outputTokens ?? 0)),
    cachedInputTokens: (total.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  };
}

/** orchestrator 只关心文本/推理/usage 三类块，done 由它自己收尾。 */
async function* filterChunks(
  source: AsyncIterable<import("@super-work/core").ChatChunk>,
): AsyncIterable<
  { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "usage"; usage: Usage }
> {
  for await (const chunk of source) {
    if (chunk.type === "done") continue;
    yield chunk;
  }
}

function safeJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** 历史注入预算：最多占最紧模型上下文窗口的 55%，避免把本轮命令挤出去。 */
const HISTORY_WINDOW_SHARE = 0.55;
const HISTORY_MIN_BUDGET = 4_000;
const HISTORY_MAX_BUDGET = 600_000;

/**
 * 从最新一轮往前装历史，装不下就丢更旧的轮次；
 * 最新一轮本身超预算时截断正文（保留开头），并标记 truncated。
 */
function trimConversation(
  turns: ConversationTurn[],
  budgetTokens: number,
): { turns: ConversationTurn[]; truncated: boolean } {
  if (turns.length === 0) return { turns: [], truncated: false };
  const kept: ConversationTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const cost = estimateTokens(turn.command) + estimateTokens(turn.finalText) + 12;
    if (kept.length === 0 && cost > budgetTokens) {
      // 最新一轮必须保留：按预算截断最终答案正文
      const maxChars = Math.max(800, Math.floor(budgetTokens * 1.2));
      const cut = turn.finalText.length > maxChars;
      kept.unshift({
        ...turn,
        finalText: cut ? `${turn.finalText.slice(0, maxChars)}\n…（该轮答案过长，已按上下文预算截断）` : turn.finalText,
      });
      return { turns: kept, truncated: true };
    }
    if (used + cost > budgetTokens) break;
    kept.unshift(turn);
    used += cost;
  }
  return { turns: kept, truncated: kept.length < turns.length };
}

/** 本次注入的对话历史摘要（用于 UI 的上下文条与回看）。 */
function historyMeta(
  options: Pick<RunOptions, "conversation" | "conversationTruncated"> | undefined,
): RunDetail["history"] | undefined {
  const turns = options?.conversation;
  if (!turns || turns.length === 0) return undefined;
  let tokens = 0;
  for (const turn of turns) tokens += estimateTokens(turn.command) + estimateTokens(turn.finalText);
  return { rounds: turns.length, tokens, truncated: Boolean(options?.conversationTruncated) };
}


/** 同名文件自动加短 id 前缀，避免覆盖。 */
function uniqueArtifactName(dir: string, filename: string, id: string): string {
  const safe = filename.replace(/[/\\]/g, "_");
  if (!fs.existsSync(path.join(dir, safe))) return safe;
  const dot = safe.lastIndexOf(".");
  const suffix = id.slice(-6);
  return dot > 0 ? `${safe.slice(0, dot)}-${suffix}${safe.slice(dot)}` : `${safe}-${suffix}`;
}

export class RunManager {
  private live = new Map<string, LiveRun>();
  private settings: AppSettings;
  private billing?: BillingService;
  private memory?: MemoryReader;
  private paths?: Paths;
  private uploads?: UploadStoreLike;
  private guard?: RunGuardInfo;

  constructor(
    private registry: ModelRegistry,
    private storage: Storage,
    settings: AppSettings,
    private log: Logger,
    options: RunManagerOptions = {},
  ) {
    this.settings = settings;
    this.billing = options.billing;
    this.memory = options.memory;
    this.paths = options.paths;
    this.uploads = options.uploads;
  }

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  setMemory(memory: MemoryReader): void {
    this.memory = memory;
  }

  private resolveParticipant(spec: ParticipantSpec, id: string, fallbackRole: string, defaultEffort?: Participant["effort"]): Participant {
    const meta = PROVIDER_BY_ID[spec.provider];
    if (!meta) throw new Error(`未知模型平台：${spec.provider}`);
    if (!spec.model || spec.model.trim() === "") throw new Error("参与者缺少模型 ID");
    const modelInfo = this.registry.findModel(spec.provider, spec.model);
    const label = `${meta.name} · ${modelInfo?.name ?? spec.model}`;
    return {
      id,
      provider: spec.provider,
      model: spec.model,
      label,
      role: spec.role?.trim() || fallbackRole,
      effort: spec.effort ?? defaultEffort,
    };
  }

  private normalizeCoordination(req: CreateRunRequest): CoordinationAssignment[] {
    const raw = req.coordination ?? [];
    const out: CoordinationAssignment[] = [];
    for (const assignment of raw) {
      if (!assignment?.role) continue;
      if (!isKnownRole(this.settings, assignment.role)) {
        throw new RunRequestError(`未知角色：${assignment.role}`, "unknown_role");
      }
      const participants = (assignment.participants ?? []).filter((p) => p && p.model);
      if (participants.length === 0) continue;
      out.push({ role: assignment.role, participants });
    }
    return out;
  }

  private recallMemory(command: string): { context?: string; ids: string[]; hits: MemoryHit[] } {
    if (!this.memory) return { ids: [], hits: [] };
    try {
      const hits = this.memory.search(command, 6).filter((h) => h.memory.enabled);
      if (hits.length === 0) return { ids: [], hits: [] };
      const lines = hits.map((h, i) => `${i + 1}. [${h.memory.kind}] ${h.memory.content}`);
      const context = `以下是与本任务相关的长期记忆（来自用户历史，可参考但不要照抄）：\n${lines.join("\n")}`;
      return { context, ids: hits.map((h) => h.memory.id), hits };
    } catch (error) {
      this.log.warn("记忆召回失败", { message: safeErrorMessage(error) });
      return { ids: [], hits: [] };
    }
  }

  create(req: CreateRunRequest): { id: string; detail: RunDetail } {
    const command = req.command?.trim();
    if (!command) throw new Error("命令不能为空");
    if (command.length > 20_000) throw new Error("命令过长（上限 20000 字）");

    // 1) 关键词规则：可改变模式/默认档位/记忆/省钱/追加角色/裁判
    const keyword = applyKeywords(command, this.settings.keywords);
    const mode = keyword.mode ?? req.mode ?? "parallel";
    const budgets = this.settings.budgets;
    const performance = this.settings.performance;
    const cheapMode = Boolean(keyword.cheapMode ?? budgets?.cheapMode ?? req.options?.cheapMode);
    const defaultEffort = cheapMode ? "low" : (keyword.effort ?? req.options?.defaultEffort ?? "medium");

    // 2) 附件：从上传存储取文本，汇总成注入上下文（防 token 额外消耗：限 12000 字）
    const attachments: AttachmentMeta[] = [];
    const attachmentTexts: Array<{ name: string; kind: string; text: string }> = [];
    for (const input of (req.attachments ?? []).slice(0, 8)) {
      const stored = this.uploads?.get(input.id);
      const text = stored?.text ?? input.text ?? "";
      if (!stored && !input.name) continue;
      attachments.push({
        id: input.id,
        name: stored?.name ?? input.name,
        mime: stored?.mime ?? input.mime,
        kind: stored?.kind ?? input.kind,
        size: stored?.size ?? input.size ?? 0,
        chars: text.length || undefined,
        preview: stored?.preview ?? (text ? text.slice(0, 500) : undefined),
        dataUrl: stored?.dataUrl,
        path: stored?.path ?? input.path,
        error: stored?.error,
      });
      if (text) attachmentTexts.push({ name: stored?.name ?? input.name, kind: stored?.kind ?? input.kind, text });
    }
    const attachmentsContext = composeAttachmentsContext(attachmentTexts, cheapMode ? 6000 : 12_000);

    // 3) 角色编排：请求 + 关键词追加；未知角色直接拒绝
    const isCoordinate = mode === "coordinate";
    let coordination = isCoordinate ? this.normalizeCoordination(req) : undefined;
    if (isCoordinate && keyword.roles.length > 0) {
      const next = [...(coordination ?? [])];
      for (const addition of keyword.roles) {
        if (!isKnownRole(this.settings, addition.role)) {
          throw new RunRequestError(`关键词规则指向未知角色：${addition.role}`, "unknown_role");
        }
        const existing = next.find((a) => a.role === addition.role);
        if (existing) {
          const seen = new Set(existing.participants.map((p) => `${p.provider}:${p.model}`));
          for (const p of addition.participants) {
            if (!seen.has(`${p.provider}:${p.model}`)) existing.participants.push(p);
          }
        } else {
          next.push({ role: addition.role, participants: [...addition.participants] });
        }
      }
      coordination = next;
    }

    const participants: Participant[] = [];
    if (isCoordinate) {
      if (!coordination || coordination.length === 0) throw new Error("配合模式至少要配置一个角色");
      for (const assignment of coordination) {
        const meta = resolveCoordRole(assignment.role, this.settings.customRoles);
        assignment.participants.forEach((spec, i) => {
          participants.push(this.resolveParticipant(spec, `${assignment.role}_${i + 1}`, meta.name, defaultEffort));
        });
      }
    } else {
      if (!Array.isArray(req.participants) || req.participants.length === 0) throw new Error("至少选择一个模型");
      req.participants.forEach((p, i) => {
        participants.push(this.resolveParticipant(p, `p${i + 1}`, "联合分析", defaultEffort));
      });
    }
    if (participants.length > MAX_PARTICIPANTS) throw new Error(`最多 ${MAX_PARTICIPANTS} 个模型同时参与`);
    // Chat：每次只能有一个模型；不能带配合编排。
    if (mode === "chat") {
      if (participants.length !== 1) throw new Error("Chat 模式每次只能选择一个模型");
      if (coordination && coordination.length > 0) throw new Error("Chat 模式不能同时使用配合角色编排");
    }

    // 4) 预算守卫：每日上限拦截；单次预估超过确认阈值需 force
    const budgetCheck = this.checkBudget(participants, budgets, req.force === true);
    const perCallMaxTokens = budgets?.perCallMaxTokens ?? performance?.defaultMaxTokens ?? 4096;

    let judge: Participant | undefined;
    if (!isCoordinate && mode !== "chat") {
      const explicitJudge = keyword.judge ?? req.judge ?? this.settings.judge;
      if (explicitJudge) {
        const meta = PROVIDER_BY_ID[explicitJudge.provider];
        const modelName =
          this.registry.findModel(explicitJudge.provider, explicitJudge.model)?.name ?? explicitJudge.model;
        judge = {
          ...this.resolveParticipant(explicitJudge, "judge", "总协调 / 裁判"),
          label: `${meta?.name ?? explicitJudge.provider} · ${modelName}（裁判）`,
          role: "总协调 / 裁判",
        };
      } else if (!["pipeline", "parallel", "coordinate"].includes(mode) && participants.length > 0) {
        const base = participants[0]!;
        judge = { ...base, id: "judge", label: `${base.label}（裁判）`, role: "总协调 / 裁判" };
      }
    }

    const memoryAllowed = keyword.memory !== false && req.options?.useMemory !== false;
    const memory = memoryAllowed
      ? this.recallMemory(command)
      : { ids: [] as string[], hits: [] as MemoryHit[], context: undefined };

    const id = `run_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const createdAt = Date.now();

    // 5) 多轮对话：解析所属工作、计算轮次、按预算组装前几轮历史
    const requestedThread = req.threadId?.trim();
    let threadId = requestedThread || id;
    let round = 1;
    let conversation: ConversationTurn[] = [];
    let conversationTruncated = false;
    if (requestedThread) {
      const rows = this.storage.getThreadRunRows(requestedThread);
      if (rows.length === 0) throw new Error("该工作不存在，无法继续下一轮");
      round = Math.max(...rows.map((row) => row.round_index ?? 1)) + 1;
      const turns: ConversationTurn[] = [];
      for (const row of rows) {
        const shape = this.storage.runRowToShape(row);
        if (!shape.finalText.trim()) continue;
        turns.push({
          runId: shape.id,
          round: row.round_index ?? 1,
          command: shape.command,
          finalText: shape.finalText,
          at: shape.createdAt,
        });
      }
      const windows = [...participants, ...(judge ? [judge] : [])]
        .map((participant) => this.registry.findModel(participant.provider, participant.model)?.contextWindow)
        .filter((size): size is number => typeof size === "number" && size > 0);
      const tightest = windows.length > 0 ? Math.min(...windows) : 128_000;
      const budget = Math.max(
        HISTORY_MIN_BUDGET,
        Math.min(HISTORY_MAX_BUDGET, Math.round(tightest * HISTORY_WINDOW_SHARE)),
      );
      const trimmed = trimConversation(turns, budget);
      conversation = trimmed.turns;
      conversationTruncated = trimmed.truncated;
      // v0.0.2 的历史运行没有 thread_id：把它归入自己的工作并补齐第 1 轮
      this.storage.setRunThread(rows[0]!.id, requestedThread, rows[0]!.round_index ?? 1);
    }

    this.storage.ensureThreadMeta(threadId, createdAt);
    const threadMemory = this.storage.getThreadMeta(threadId)?.memory?.trim();
    const combinedMemoryContext = [memory.context, threadMemory ? `【本对话记忆】\n${threadMemory}` : ""]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n") || undefined;

    const options = {
      critique: cheapMode ? false : true,
      rounds: cheapMode ? 1 : 2,
      synthesize: true,
      language: this.settings.language,
      timeoutMs: performance?.timeoutMs ?? this.settings.timeoutMs,
      ...req.options,
      conversation,
      conversationTruncated,
      defaultEffort,
      cheapMode,
      customRoles: this.settings.customRoles,
      attachmentsContext,
      perCallMaxTokens,
      concurrency: performance?.concurrency,
      performance,
      memoryContext: combinedMemoryContext,
      memoryIds: memory.ids,
      budgetLimitTokens: budgets?.perRunTokenLimit,
      budgetLimitCost: budgets?.perRunCostLimit,
      budgetCurrency: budgets?.currency ?? "CNY",
    };

    const guard: RunGuardInfo = {
      cheapMode,
      matchedKeywords: keyword.hits,
      attachments,
      budgets: budgetCheck,
    };

    const record: RunRecord = {
      id,
      command,
      mode,
      status: "running",
      createdAt,
      finalText: "",
      participants: [],
      usage: {},
      options,
      artifacts: [],
    };

    this.storage.insertRun(
      {
        id,
        command,
        mode,
        status: "running",
        createdAt,
        finalText: "",
        optionsJson: JSON.stringify(options),
        threadId,
        round,
      },
      { participantsJson: JSON.stringify(participants) },
    );
    if (coordination && coordination.length > 0) this.storage.saveRunCoordination(id, coordination);
    this.storage.saveRunGuard(id, guard, attachments);

    const state: LiveRun = {
      id,
      record,
      participants,
      judge,
      abort: new AbortController(),
      subscribers: new Set(),
      lastSeq: 0,
      done: false,
      artifacts: [],
      coordination,
      options,
      guard,
      attachments,
      threadId,
      round,
    };
    this.live.set(id, state);

    void this.execute(state, {
      command,
      mode,
      participants: isCoordinate ? [] : req.participants,
      coordination,
      judge: req.judge,
      options,
    });

    return { id, detail: this.toDetail(state) };
  }

  /** 每日预算 + 单次预估确认。抛 RunRequestError 让 routes 映射 409。 */
  private checkBudget(
    participants: Participant[],
    budgets: import("@super-work/core").BudgetSettings | undefined,
    force: boolean,
  ): RunGuardInfo["budgets"] {
    if (!budgets) return undefined;
    const currency = budgets.currency ?? "CNY";
    let todayTokens = 0;
    let todayCost = 0;
    try {
      const summary = this.billing?.summary() ?? undefined;
      if (summary) {
        todayTokens = summary.today.totalTokens;
        todayCost = summary.today.cost;
      }
    } catch {
      /* ignore */
    }
    if (budgets.dailyTokenLimit && todayTokens >= budgets.dailyTokenLimit) {
      throw new RunRequestError(
        `今日 token 已用 ${todayTokens.toLocaleString()}，达到上限 ${budgets.dailyTokenLimit.toLocaleString()}；请明天再试或调高预算`,
        "budget_exceeded",
        { todayTokens, limit: budgets.dailyTokenLimit },
      );
    }
    if (budgets.dailyCostLimit && todayCost >= budgets.dailyCostLimit) {
      throw new RunRequestError(
        `今日成本已用 ¥${todayCost.toFixed(2)}，达到上限 ¥${budgets.dailyCostLimit.toFixed(2)}；请明天再试或调高预算`,
        "budget_exceeded",
        { todayCost, limit: budgets.dailyCostLimit },
      );
    }
    // 单次预估：按每模型 perCall 上限（保守 2 倍输入）估算
    const perCall = budgets.perCallMaxTokens ?? this.settings.performance?.defaultMaxTokens ?? 4096;
    let estCost = 0;
    let estTokens = 0;
    for (const p of participants) {
      const cost = this.billing?.costFor(p.provider, p.model, perCall * 2, perCall);
      estTokens += perCall * 3;
      if (cost?.priced) estCost += cost.totalCost;
    }
    if (budgets.perRunTokenLimit && estTokens > budgets.perRunTokenLimit) {
      throw new RunRequestError(
        `本次预估 ${estTokens.toLocaleString()} token，超过单次运行上限 ${budgets.perRunTokenLimit.toLocaleString()}；请减少参与模型或调高上限`,
        "budget_exceeded",
        { estTokens, limit: budgets.perRunTokenLimit },
      );
    }
    if (budgets.confirmAboveCost && estCost > budgets.confirmAboveCost && !force) {
      throw new RunRequestError(
        `本次预估成本约 ¥${estCost.toFixed(2)}，超过确认阈值 ¥${budgets.confirmAboveCost.toFixed(2)}；确认后请带 force=true 重试`,
        "budget_confirm",
        { estCost, threshold: budgets.confirmAboveCost },
      );
    }
    const limitCost = budgets.dailyCostLimit;
    const percent = limitCost && limitCost > 0 ? Math.round((todayCost / limitCost) * 100) : undefined;
    return {
      perRunTokens: budgets.perRunTokenLimit,
      perRunCost: budgets.perRunCostLimit,
      currency,
      blocked: false,
      message: percent !== undefined && percent >= (budgets.warnAtPercent ?? 80) ? `今日预算已用 ${percent}%` : undefined,
    };
  }

  private appendAndBroadcast(state: LiveRun, event: RunEvent): void {
    if (event.type === "model.error") state.lastModelError = event.message;
    const seq = this.storage.appendEvent(state.id, event);
    state.lastSeq = Math.max(state.lastSeq, seq);
    if (event.type === "artifact" && event.artifact) {
      state.artifacts.push(event.artifact);
    }
    for (const listener of state.subscribers) {
      try {
        listener({ seq, event });
      } catch (error) {
        this.log.warn("推送事件失败", { message: safeErrorMessage(error) });
      }
    }
  }

  private emit(state: LiveRun, event: RunEvent): void {
    if (event.type !== "artifact" || !event.artifact) {
      this.appendAndBroadcast(state, event);
      return;
    }
    const artifact = event.artifact;
    const needsProcessing =
      Boolean(artifact.meta?.url) ||
      (artifact.kind === "image" && !artifact.path) ||
      (artifact.kind === "code3d" && !artifact.path) ||
      (artifact.kind === "file" && !artifact.path) ||
      ((artifact.kind === "video" || artifact.kind === "audio") && !artifact.path);
    if (!needsProcessing) {
      this.appendAndBroadcast(state, event);
      return;
    }
    void this.processArtifact(state, artifact, event.participantId)
      .then((processed) => {
        this.appendAndBroadcast(state, { type: "artifact", participantId: event.participantId, artifact: processed, at: event.at });
        this.storage.saveRunArtifacts(state.id, state.artifacts);
      })
      .catch((error) => {
        this.log.warn("产物落盘失败", { message: safeErrorMessage(error) });
        this.appendAndBroadcast(state, event);
      });
  }

  private artifactDir(runId: string): string {
    const home = this.paths?.home ?? path.join(process.env.HOME ?? ".", ".super-work");
    const dir = path.join(home, "artifacts", runId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async processArtifact(state: LiveRun, artifact: Artifact, participantId?: string): Promise<Artifact> {
    const dir = this.artifactDir(state.id);
    const id = artifact.id || `art_${crypto.randomBytes(5).toString("hex")}`;
    const next: Artifact = { ...artifact, id };
    const url = typeof artifact.meta?.url === "string" ? artifact.meta.url : undefined;

    if (artifact.kind === "image") {
      let bytes: Buffer | undefined;
      let mime = artifact.mime ?? "image/png";
      if (artifact.dataUrl) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(artifact.dataUrl);
        if (m) {
          mime = m[1]!;
          bytes = Buffer.from(m[2]!, "base64");
        }
      } else if (url) {
        let res: Response | undefined;
        try {
          res = await directFetch(url, { signal: AbortSignal.timeout(60_000) });
        } catch {
          // 极少数 CDN 需要代理；直连失败再走全局 fetch
          res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        }
        if (res.ok) {
          bytes = Buffer.from(await res.arrayBuffer());
          mime = res.headers.get("content-type") ?? mime;
        } else {
          throw new Error(`下载图片失败（HTTP ${res.status}）`);
        }
      }
      if (!bytes) throw new Error("产物里没有图片数据");
      const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
      next.path = `/api/artifacts/${state.id}/${file}`;
      next.mime = mime;
      next.dataUrl = undefined;
      delete next.meta?.url;
    } else if (artifact.kind === "video" || artifact.kind === "audio") {
      let bytes: Buffer | undefined;
      let mime = artifact.mime ?? (artifact.kind === "video" ? "video/mp4" : "audio/mpeg");
      if (artifact.dataUrl) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(artifact.dataUrl);
        if (m) {
          mime = m[1]!;
          bytes = Buffer.from(m[2]!, "base64");
        }
      } else if (url) {
        const res = await directFetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`下载${artifact.kind === "video" ? "视频" : "音频"}失败（HTTP ${res.status}）`);
        bytes = Buffer.from(await res.arrayBuffer());
        mime = res.headers.get("content-type") ?? mime;
      }
      if (!bytes) throw new Error("产物里没有媒体数据");
      const ext = mime.includes("webm")
        ? "webm"
        : mime.includes("quicktime")
          ? "mov"
          : mime.includes("mpeg")
            ? "mp3"
            : mime.includes("wav")
              ? "wav"
              : artifact.kind === "video"
                ? "mp4"
                : "mp3";
      const file = `${id}.${ext}`;
      fs.writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
      next.path = `/api/artifacts/${state.id}/${file}`;
      next.mime = mime;
      next.meta = { ...(next.meta ?? {}), size: bytes.length };
      next.dataUrl = undefined;
      delete next.meta?.url;
    } else if (artifact.kind === "code3d" && artifact.text) {
      const file = `${id}.html`;
      const html = buildPreviewHtml(artifact.title, artifact.text);
      fs.writeFileSync(path.join(dir, file), html, { mode: 0o600 });
      next.path = `/api/artifacts/${state.id}/${file}`;
    } else if (artifact.kind === "file") {
      const source = artifact.text ?? "";
      try {
        const materialized = await materializeOutputFile(artifact.title, source);
        const file = uniqueArtifactName(dir, materialized.filename, id);
        fs.writeFileSync(path.join(dir, file), materialized.bytes, { mode: 0o600 });
        next.title = file;
        next.path = `/api/artifacts/${state.id}/${encodeURIComponent(file)}`;
        next.mime = materialized.mime;
        next.meta = {
          ...(next.meta ?? {}),
          size: materialized.bytes.length,
          ext: file.split(".").pop()?.toLowerCase() ?? "txt",
          converted: materialized.converted,
        };
      } catch (error) {
        // 转换失败也保留文本，前端可复制内容并提供错误提示
        next.meta = { ...(next.meta ?? {}), error: safeErrorMessage(error), size: Buffer.byteLength(source) };
      }
    }
    if (participantId) next.meta = { ...(next.meta ?? {}), participantId };
    return next;
  }

  private async execute(
    state: LiveRun,
    request: {
      command: string;
      mode: CreateRunRequest["mode"];
      participants: ParticipantSpec[];
      coordination?: CoordinationAssignment[];
      judge?: ParticipantSpec;
      options: NonNullable<RunRecord["options"]>;
    },
  ): Promise<void> {
    const started = Date.now();
    try {
      const result = await orchestrate(
        {
          runId: state.id,
          request: {
            command: request.command,
            mode: request.mode,
            participants: request.participants,
            coordination: request.coordination,
            judge: request.judge,
            options: request.options,
          },
          participants: state.participants,
          judge: state.judge,
          options: request.options,
          signal: state.abort.signal,
          onControl: (control) => {
            state.control = control;
          },
        },
        {
          callModel: (callReq) =>
            filterChunks(
              this.registry.chat({
                provider: callReq.provider,
                model: callReq.model,
                relayId: (callReq as { relayId?: string }).relayId,
                system: callReq.system,
                messages: callReq.messages,
                maxTokens: callReq.maxTokens,
                temperature: callReq.temperature,
                reasoning: callReq.reasoning,
                effort: (callReq as { effort?: import("@super-work/core").EffortLevel }).effort,
                signal: callReq.signal ?? state.abort.signal,
              }),
            ),
          generateImage: (req) =>
            this.registry.generateImage({
              provider: req.provider,
              model: req.model,
              prompt: req.prompt,
              size: req.size,
              signal: req.signal ?? state.abort.signal,
            }),
        },
        (event) => this.emit(state, event),
        state.abort.signal,
      );

      if (state.abort.signal.aborted) throw new Error("运行已取消");

      let finalText = result.finalText?.trim() ? result.finalText : "";
      if (!finalText) {
        const longest = [...result.results]
          .filter((r) => (r.text ?? "").trim().length > 0)
          .sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0))[0];
        finalText = longest?.text ?? "";
      }
      if (!finalText) {
        const detail = state.lastModelError ? `：${state.lastModelError}` : "";
        state.record.status = "error";
        state.record.finishedAt = Date.now();
        state.record.error =
          (state.lastModelError ? "所有模型调用都失败了" : "所有模型都没有产出内容（检查连接状态或提高 maxTokens）") + detail;
        this.storage.updateRun(state.id, {
          status: "error",
          finishedAt: state.record.finishedAt,
          error: state.record.error,
          resultsJson: JSON.stringify(result.results),
        });
        this.emit(state, { type: "notice", level: "error", message: state.record.error, at: Date.now() });
        this.emit(state, { type: "run.error", message: state.record.error, at: Date.now() });
        this.emit(state, { type: "run.done", runId: state.id, at: Date.now(), usage: result.usage ?? {} });
        return;
      }

      const usage = result.usage ?? {};
      const cost = this.billing?.runCost({ results: result.results });
      if (cost) {
        const imageCredit = state.artifacts.reduce((sum, a) => {
          const c = typeof a.meta?.credit === "number" ? a.meta.credit : 0;
          return sum + c;
        }, 0);
        if (imageCredit > 0) cost.credit = imageCredit;
      }
      state.record.status = "done";
      state.record.finishedAt = Date.now();
      state.record.finalText = finalText;
      state.record.participants = result.results;
      state.record.usage = usage;
      state.record.artifacts = state.artifacts;
      this.storage.updateRun(state.id, {
        status: "done",
        finishedAt: state.record.finishedAt,
        finalText,
        resultsJson: JSON.stringify(result.results),
        usage,
      });
      this.storage.saveRunArtifacts(state.id, state.artifacts);
      if (cost && cost.priced) this.storage.saveRunCost(state.id, cost);
      if (state.options?.memoryIds && state.options.memoryIds.length > 0) {
        try {
          this.memory?.markUsed(state.options.memoryIds);
        } catch {
          /* ignore */
        }
      }
      this.log.info("运行完成", {
        id: state.id,
        mode: state.record.mode,
        ms: Date.now() - started,
        chars: finalText.length,
        artifacts: state.artifacts.length,
      });
    } catch (error) {
      const aborted = state.abort.signal.aborted;
      const message = aborted ? "运行已取消" : safeErrorMessage(error);
      state.record.status = "error";
      state.record.finishedAt = Date.now();
      state.record.error = message;
      state.record.finalText = "";
      state.record.artifacts = state.artifacts;
      this.storage.updateRun(state.id, {
        status: "error",
        finishedAt: state.record.finishedAt,
        error: message,
        finalText: "",
      });
      this.storage.saveRunArtifacts(state.id, state.artifacts);
      this.emit(state, { type: "run.error", message, at: Date.now() });
      this.emit(state, { type: "run.done", runId: state.id, at: Date.now(), usage: state.record.usage });
      this.log.warn("运行失败", { id: state.id, message });
    } finally {
      state.done = true;
      state.subscribers.clear();
    }
  }

  private toDetail(state: LiveRun): RunDetail {
    const cost = this.billing?.runCost({ results: state.record.participants });
    if (cost) {
      const imageCredit = state.artifacts.reduce((sum, a) => {
        const c = typeof a.meta?.credit === "number" ? a.meta.credit : 0;
        return sum + c;
      }, 0);
      if (imageCredit > 0) cost.credit = imageCredit;
    }
    return {
      id: state.record.id,
      command: state.record.command,
      mode: state.record.mode,
      status: state.record.status,
      createdAt: state.record.createdAt,
      finishedAt: state.record.finishedAt,
      finalText: state.record.finalText,
      results: state.record.participants,
      usage: state.record.usage,
      error: state.record.error,
      participants: state.participants.map((p) => ({
        id: p.id,
        provider: p.provider,
        model: p.model,
        label: p.label,
        role: p.role,
        effort: p.effort,
      })),
      efforts: state.participants.map((p) => ({ participantId: p.id, effort: p.effort ?? "medium" })),
      coordination: state.coordination,
      artifacts: state.artifacts,
      cost: cost?.priced ? cost : undefined,
      guard: state.guard,
      attachments: state.attachments,
      threadId: state.threadId,
      round: state.round,
      history: historyMeta(state.options),
    };
  }

  detail(id: string): RunDetail | undefined {
    const live = this.live.get(id);
    if (live) return this.toDetail(live);
    const row = this.storage.getRunRow(id);
    if (!row) return undefined;
    const shape = this.storage.runRowToShape(row);
    let participants: RunDetail["participants"] = [];
    let results: RunDetail["results"] = [];
    let artifacts: Artifact[] = [];
    let coordination: CoordinationAssignment[] | undefined;
    let guard: RunGuardInfo | undefined;
    let attachments: AttachmentMeta[] = [];
    if (shape.participantsJson) participants = safeJson(shape.participantsJson, []);
    if (shape.resultsJson) results = safeJson(shape.resultsJson, []);
    if (row.artifacts_json) artifacts = safeJson(row.artifacts_json, []);
    if (row.coordination_json) coordination = safeJson(row.coordination_json, undefined);
    if (row.guard_json) guard = safeJson(row.guard_json, undefined);
    if (row.attachments_json) attachments = safeJson(row.attachments_json, []);
    const storedOptions = safeJson<RunOptions | undefined>(row.options_json, undefined);
    const cost = this.billing?.runCost({ results });
    return {
      id: shape.id,
      command: shape.command,
      mode: shape.mode,
      status: shape.status,
      createdAt: shape.createdAt,
      finishedAt: shape.finishedAt,
      finalText: shape.finalText,
      results,
      usage: shape.usage,
      error: shape.error,
      participants,
      efforts: participants.map((p) => ({ participantId: p.id, effort: p.effort ?? "medium" })),
      coordination,
      artifacts,
      cost: cost?.priced ? cost : undefined,
      guard,
      attachments,
      threadId: shape.threadId ?? shape.id,
      round: shape.round ?? 1,
      history: historyMeta(storedOptions),
    };
  }

  list(limit = 30): RunListItem[] {
    return this.storage.listRunRows(limit).map((row) => {
      const shape = this.storage.runRowToShape(row);
      let participantCount = 0;
      if (shape.participantsJson) {
        try {
          participantCount = (JSON.parse(shape.participantsJson) as unknown[]).length;
        } catch {
          participantCount = 0;
        }
      }
      const cost = this.billing?.runCost({ results: safeJson(shape.resultsJson ?? "[]", []) });
      return {
        id: shape.id,
        command: shape.command,
        mode: shape.mode,
        status: shape.status,
        createdAt: shape.createdAt,
        finishedAt: shape.finishedAt,
        participantCount,
        preview: (shape.finalText || shape.error || "").slice(0, 160),
        usage: shape.usage,
        cost: cost?.priced ? cost.totalCost : undefined,
        threadId: shape.threadId ?? shape.id,
        round: shape.round ?? 1,
      };
    });
  }

  /** 一个工作（多轮对话）由若干轮运行组成；这里把运行记录聚合成工作列表。 */
  listThreads(limit = 30, includeArchived = false): ThreadSummary[] {
    const rows = this.storage.listRunRows(Math.max(60, Math.min(800, limit * 8)));
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.thread_id ?? row.id;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const metas = new Map(this.storage.listThreadMetas().map((meta) => [meta.thread_id, meta]));
    const summaries: ThreadSummary[] = [];
    for (const group of groups.values()) {
      const threadId = group[0]!.thread_id ?? group[0]!.id;
      const meta = metas.get(threadId);
      if (meta?.deleted_at) continue;
      if (meta?.archived && !includeArchived) continue;
      const summary = this.threadSummaryFromRows(group, meta);
      if (summary) summaries.push(summary);
    }
    return summaries
      .sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  /** 工作详情：轮次摘要 + 按轮次升序的完整运行。 */
  threadDetail(threadId: string): ThreadDetail | undefined {
    const rows = this.storage.getThreadRunRows(threadId);
    if (rows.length === 0) return undefined;
    const meta = this.storage.getThreadMeta(threadId);
    if (meta?.deleted_at) return undefined;
    const thread = this.threadSummaryFromRows(rows, meta);
    if (!thread) return undefined;
    const runs: RunDetail[] = [];
    for (const row of rows) {
      const detail = this.detail(row.id);
      if (detail) runs.push(detail);
    }
    return { thread, runs };
  }

  /** 归档 / 取消归档。归档线程默认不出现在历史列表。 */
  setThreadArchived(threadId: string, archived: boolean): ThreadSummary | undefined {
    const rows = this.storage.getThreadRunRows(threadId);
    if (rows.length === 0) return undefined;
    this.storage.updateThreadMeta(threadId, { archived });
    return this.threadSummaryFromRows(rows, this.storage.getThreadMeta(threadId));
  }

  /** 软删除：从历史隐藏；运行与产物保留，避免误删文件引用。 */
  deleteThread(threadId: string): boolean {
    const rows = this.storage.getThreadRunRows(threadId);
    if (rows.length === 0) return false;
    this.storage.updateThreadMeta(threadId, { deletedAt: Date.now(), archived: false });
    return true;
  }

  saveThreadMemory(threadId: string, memory: string): ThreadSummary | undefined {
    const rows = this.storage.getThreadRunRows(threadId);
    if (rows.length === 0) return undefined;
    const text = memory.trim();
    this.storage.updateThreadMeta(threadId, { memory: text || null });
    return this.threadSummaryFromRows(rows, this.storage.getThreadMeta(threadId));
  }

  /**
   * 从某条对话的指定轮次创建分支：复制截至该轮的运行（含产物路径）到新工作。
   * 分支是完整可继续的对话，不依赖原对话后续是否归档/删除。
   */
  branchThread(threadId: string, fromRunId?: string): ThreadDetail | undefined {
    const rows = this.storage.getThreadRunRows(threadId);
    if (rows.length === 0) return undefined;
    const end = fromRunId ? rows.findIndex((row) => row.id === fromRunId) : rows.length - 1;
    if (end < 0) throw new Error("分支来源轮次不存在");
    const selected = rows.slice(0, end + 1);
    if (selected.length === 0) return undefined;
    const sourceMeta = this.storage.getThreadMeta(threadId);
    const newThreadId = `thread_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    this.storage.ensureThreadMeta(newThreadId);
    this.storage.updateThreadMeta(newThreadId, {
      parentThreadId: threadId,
      branchedFromRunId: selected[selected.length - 1]!.id,
      memory: sourceMeta?.memory ?? null,
    });
    for (const row of selected) {
      const newRunId = `run_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
      const artifactsJson = this.copyArtifactsForBranch(row.id, newRunId, row.artifacts_json);
      this.storage.copyRunRow(row, newRunId, newThreadId, artifactsJson);
    }
    return this.threadDetail(newThreadId);
  }

  private copyArtifactsForBranch(
    sourceRunId: string,
    newRunId: string,
    artifactsJson: string | null,
  ): string | null {
    const home = this.paths?.home ?? path.join(process.env.HOME ?? ".", ".super-work");
    const sourceDir = path.join(home, "artifacts", sourceRunId);
    const targetDir = path.join(home, "artifacts", newRunId);
    try {
      if (fs.existsSync(sourceDir)) {
        fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
        fs.cpSync(sourceDir, targetDir, { recursive: true });
      }
    } catch (error) {
      this.log.warn("分支产物复制失败", { sourceRunId, message: safeErrorMessage(error) });
    }
    if (!artifactsJson) return artifactsJson;
    return artifactsJson.replaceAll(`/api/artifacts/${sourceRunId}/`, `/api/artifacts/${newRunId}/`);
  }

  private threadSummaryFromRows(rows: RunRow[], meta?: import("./storage.js").ThreadMetaRow): ThreadSummary | undefined {
    if (rows.length === 0) return undefined;
    const sorted = [...rows].sort(
      (a, b) => (a.round_index ?? 1) - (b.round_index ?? 1) || a.created_at - b.created_at,
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const lastShape = this.storage.runRowToShape(last);
    let usage: Usage = {};
    let cost = 0;
    let priced = false;
    let participantCount = 0;
    for (const row of sorted) {
      const shape = row.id === last.id ? lastShape : this.storage.runRowToShape(row);
      usage = mergeUsage(usage, shape.usage);
      if (row.id === first.id && shape.participantsJson) {
        try {
          participantCount = (JSON.parse(shape.participantsJson) as unknown[]).length;
        } catch {
          participantCount = 0;
        }
      }
      const rowCost = this.billing?.runCost({ results: safeJson(shape.resultsJson ?? "[]", []) });
      if (rowCost?.priced) {
        cost += rowCost.totalCost;
        priced = true;
      }
    }
    return {
      id: first.thread_id ?? first.id,
      title: first.command,
      mode: lastShape.mode,
      rounds: Math.max(...sorted.map((row) => row.round_index ?? 1)),
      status: lastShape.status,
      createdAt: first.created_at,
      updatedAt: last.finished_at ?? last.created_at,
      lastRunId: last.id,
      preview: (lastShape.finalText || lastShape.error || "").slice(0, 160),
      participantCount,
      usage: Object.keys(usage).length > 0 ? usage : undefined,
      cost: priced ? cost : undefined,
      archived: Boolean(meta?.archived),
      parentThreadId: meta?.parent_thread_id ?? undefined,
      branchedFromRunId: meta?.branched_from_run_id ?? undefined,
      memory: meta?.memory ?? undefined,
      memoryUpdatedAt: meta?.memory_updated_at ?? undefined,
    };
  }

  /** 运行中热调强度：改运行态 participant，下一次调用生效。 */
  setEffort(id: string, participantId: string, effort: import("@super-work/core").EffortLevel): boolean {
    const live = this.live.get(id);
    if (!live || live.done) return false;
    const participant = live.participants.find((p) => p.id === participantId);
    if (!participant) return false;
    participant.effort = effort;
    this.emit(live, {
      type: "notice",
      level: "info",
      message: `已将 ${participant.label} 调整为 ${effort.toUpperCase()}，下一次调用生效`,
      at: Date.now(),
    });
    return true;
  }

  /**
   * 运行中单独停止某个参与模型：只中断这一个模型的调用，其余继续。
   * 返回 false 表示运行不存在 / 已结束 / 该参与者不在本次运行里 / 已停止过。
   */
  stopParticipant(id: string, participantId: string): boolean {
    const live = this.live.get(id);
    if (!live || live.done) return false;
    if (!live.participants.some((p) => p.id === participantId) && live.judge?.id !== participantId) return false;
    return live.control?.stopParticipant(participantId) === true;
  }

  /** 已被用户单独停止的模型 id 列表（用于回读运行态）。 */
  stoppedParticipants(id: string): string[] {
    const live = this.live.get(id);
    if (!live || live.done) return [];
    return live.control?.stoppedParticipants() ?? [];
  }

  cancel(id: string): boolean {
    const live = this.live.get(id);
    if (!live || live.done) return false;
    live.abort.abort();
    this.log.info("已请求取消运行", { id });
    return true;
  }

  replay(id: string, afterSeq: number): Array<{ seq: number; event: RunEvent }> {
    return this.storage.eventsAfter(id, afterSeq);
  }

  subscribe(id: string, listener: (entry: { seq: number; event: RunEvent }) => void): () => void {
    const live = this.live.get(id);
    if (!live || live.done) return () => {};
    live.subscribers.add(listener);
    return () => {
      live.subscribers.delete(listener);
    };
  }

  isRunning(id: string): boolean {
    const live = this.live.get(id);
    return Boolean(live && !live.done);
  }

  activeCount(): number {
    let n = 0;
    for (const live of this.live.values()) if (!live.done) n += 1;
    return n;
  }

  totalUsage(): Usage {
    let usage: Usage = {};
    for (const row of this.storage.listRunRows(500)) {
      usage = mergeUsage(usage, this.storage.runRowToShape(row).usage);
    }
    return usage;
  }
}

/** 3D 产物预览：离线 three.js 模块 + 沙箱 iframe 约定。 */
function buildPreviewHtml(title: string, code: string): string {
  const escapedTitle = title.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const raw = code.includes("<html") || code.includes("<!doctype") ? code : code;
  if (code.trim().startsWith("<!doctype") || code.trim().startsWith("<html")) {
    return raw;
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapedTitle}</title>
<style>html,body{margin:0;height:100%;background:#0a0b10;color:#e6e8ef;font-family:system-ui}
#hud{position:fixed;left:12px;bottom:12px;font-size:11px;opacity:.6;z-index:9}</style>
<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>
</head><body>
<div id="hud">Super Work 3D 预览 · ${escapedTitle}</div>
<script type="module">
import * as THREE from "three";
window.THREE = THREE;
try {
${code}
} catch (error) {
  document.getElementById("hud").textContent = "运行出错：" + (error && error.message ? error.message : error);
}
</script>
</body></html>`;
}
