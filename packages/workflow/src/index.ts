/**
 * @super-work/workflow —— 多步骤模型编排执行器（v0.0.2）。
 *
 * 执行语义（DESIGN-v0.0.2 §5）：
 * - 按 `parallelGroup` 分组：同组并行、组间串行。
 *   `undefined` 的步骤各成一个独占组；数字组按组号升序，且保持其声明槽位。
 * - 步骤输入：`command`=原始命令 / `previous`=上一组全部输出 / `all`=到目前为止全部输出（带步骤标题）。
 * - 单步失败只标记该步 `error` 并继续；失败步骤在下游输入里以错误说明出现，不带半成品正文。
 * - 每个步骤发 `model.start / model.delta / model.done|model.error`，participantId=`wf_<stepId>`；
 *   整次运行开头发一次 `stage{stage:"workflow", label:def.name}`。
 * - 返回 `finalText`（最后一个成功步骤的输出，全失败则为空串）、`steps`、`usage`。
 * - `options.signal` 取消：不再发起新调用；进行中的步骤标 `error`（error="已取消"，保留半成品文本），
 *   未开始的步骤标 `skipped`；Promise 正常 resolve，便于 server 保存运行记录。
 */
import type {
  ParticipantSpec,
  ProviderId,
  RunEvent,
  Usage,
  WorkflowDef,
  WorkflowStep,
  WorkflowStepRun,
} from "@super-work/core";

export type {
  WorkflowDef,
  WorkflowStep,
  WorkflowStepRun,
} from "@super-work/core";

/** 单步默认 maxTokens。 */
export const DEFAULT_STEP_MAX_TOKENS = 4096;

export interface WorkflowCallRequest {
  provider: ProviderId;
  model: string;
  relayId?: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  reasoning?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

export type WorkflowModelChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage };

export interface WorkflowDeps {
  callModel(request: WorkflowCallRequest): AsyncIterable<WorkflowModelChunk>;
}

export interface RunWorkflowOptions {
  /** 只跑这些步骤（按原声明顺序）；不填 = 全部。 */
  stepIds?: string[];
  signal?: AbortSignal;
  /** 预留：事件里可带运行 id（server 使用）。 */
  runId?: string;
}

export interface RunWorkflowResult {
  finalText: string;
  steps: WorkflowStepRun[];
  usage: Usage;
}

interface StepGroup {
  steps: WorkflowStep[];
  /** 是否为无 parallelGroup 的独占组。 */
  exclusive: boolean;
  groupNumber?: number;
}

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const;

function mergeUsage(target: Usage = {}, add?: Usage): Usage {
  const out: Usage = { ...target };
  if (!add) return out;
  for (const key of USAGE_KEYS) {
    const value = add[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = (out[key] ?? 0) + value;
    }
  }
  return out;
}

function hasUsage(usage?: Usage): boolean {
  if (!usage) return false;
  return USAGE_KEYS.some((key) => typeof usage[key] === "number");
}

function finalizeUsage(usage: Usage): Usage {
  if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    return { ...usage, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) };
  }
  return usage;
}

function errorMessage(error: unknown, limit = 400): string {
  let raw: string;
  if (error instanceof Error) raw = error.message || error.name;
  else if (typeof error === "string") raw = error;
  else raw = String(error);
  raw = raw.trim() || "未知错误";
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function abortError(): Error {
  const error = new Error("已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 把步骤按 parallelGroup 分组：独占组按声明顺序，数字组按组号升序（槽位不变）。 */
export function groupWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[][] {
  const groups: StepGroup[] = [];
  const byNumber = new Map<number, StepGroup>();

  for (const step of steps) {
    const groupNumber = step.parallelGroup;
    if (groupNumber === undefined) {
      groups.push({ steps: [step], exclusive: true });
      continue;
    }
    const existing = byNumber.get(groupNumber);
    if (existing) {
      existing.steps.push(step);
    } else {
      const group: StepGroup = { steps: [step], exclusive: false, groupNumber };
      byNumber.set(groupNumber, group);
      groups.push(group);
    }
  }

  // 数字组按组号升序，但保持在声明顺序里的槽位；独占组位置不动。
  const slots: number[] = [];
  const numeric: StepGroup[] = [];
  groups.forEach((group, index) => {
    if (!group.exclusive) {
      slots.push(index);
      numeric.push(group);
    }
  });
  numeric.sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0));
  slots.forEach((slot, index) => {
    const group = numeric[index];
    if (group) groups[slot] = group;
  });

  return groups.map((group) => group.steps);
}

/** 真正给下游看的文本：失败步骤只给错误说明；超过 maxOutputChars 先截断。 */
function renderRunText(run: WorkflowStepRun, defs: Map<string, WorkflowStep>): string {
  if (run.status === "error") return `（步骤「${run.name}」执行失败：${run.error ?? "未知错误"}）`;
  const limit = defs.get(run.stepId)?.maxOutputChars;
  const text = run.text;
  if (!limit || limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字）`;
}

function renderRuns(runs: WorkflowStepRun[], defs: Map<string, WorkflowStep>): string {
  if (!runs.length) return "（暂无前置输出）";
  if (runs.length === 1) {
    const only = runs[0]!;
    return renderRunText(only, defs);
  }
  return runs.map((run) => `## ${run.name}\n\n${renderRunText(run, defs)}`).join("\n\n");
}

function renderAll(runs: WorkflowStepRun[], defs: Map<string, WorkflowStep>): string {
  if (!runs.length) return "（暂无前置输出）";
  return runs.map((run) => `## ${run.name}\n\n${renderRunText(run, defs)}`).join("\n\n");
}

function formatJsonOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

interface RunStepArgs {
  step: WorkflowStep;
  inputText: string;
  deps: WorkflowDeps;
  emit: (event: RunEvent) => void;
  signal?: AbortSignal;
}

async function runStep({ step, inputText, deps, emit, signal }: RunStepArgs): Promise<WorkflowStepRun> {
  const participantId = `wf_${step.id}`;
  const startedAt = Date.now();
  const base = { stepId: step.id, name: step.name, startedAt };
  const model: ParticipantSpec | undefined = step.model;

  if (signal?.aborted) {
    return { ...base, status: "skipped", text: "" };
  }

  if (!model) {
    const message = "未指定模型";
    const finishedAt = Date.now();
    emit({ type: "model.error", participantId, message, at: finishedAt });
    return {
      ...base,
      status: "error",
      text: "",
      error: message,
      finishedAt,
      latencyMs: finishedAt - startedAt,
    };
  }

  const system = step.role ?? model.role;
  const request: WorkflowCallRequest = {
    provider: model.provider,
    model: model.model,
    relayId: model.relayId,
    messages: [
      {
        role: "user",
        content: `${step.instruction}\n\n## 输入\n${inputText}`,
      },
    ],
    maxTokens: DEFAULT_STEP_MAX_TOKENS,
    signal,
  };
  if (system) request.system = system;

  emit({ type: "model.start", participantId, label: step.name, at: startedAt });

  let text = "";
  let reasoning = "";
  let usage: Usage | undefined;

  try {
    for await (const chunk of deps.callModel(request)) {
      throwIfAborted(signal);
      if (chunk.type === "text") {
        text += chunk.text;
        emit({ type: "model.delta", participantId, channel: "text", text: chunk.text, at: Date.now() });
      } else if (chunk.type === "reasoning") {
        reasoning += chunk.text;
        emit({
          type: "model.delta",
          participantId,
          channel: "reasoning",
          text: chunk.text,
          at: Date.now(),
        });
      } else if (chunk.type === "usage") {
        usage = mergeUsage(usage, chunk.usage);
      }
    }
    throwIfAborted(signal);

    const finishedAt = Date.now();
    const finalText = step.outputMode === "json" ? formatJsonOutput(text) : text;
    const stepUsage = hasUsage(usage) ? usage : undefined;
    emit({
      type: "model.done",
      participantId,
      text: finalText,
      usage: stepUsage,
      latencyMs: finishedAt - startedAt,
      at: finishedAt,
    });
    const run: WorkflowStepRun = {
      ...base,
      status: "done",
      text: finalText,
      usage: stepUsage,
      finishedAt,
      latencyMs: finishedAt - startedAt,
    };
    if (reasoning) run.reasoning = reasoning;
    return run;
  } catch (error) {
    const finishedAt = Date.now();
    const message = signal?.aborted ? "已取消" : errorMessage(error);
    emit({ type: "model.error", participantId, message, at: finishedAt });
    const run: WorkflowStepRun = {
      ...base,
      status: "error",
      text,
      error: message,
      finishedAt,
      latencyMs: finishedAt - startedAt,
    };
    if (reasoning) run.reasoning = reasoning;
    if (hasUsage(usage)) run.usage = usage;
    return run;
  }
}

/**
 * 执行一个工作流定义。
 * @param def 工作流定义（步骤顺序与 parallelGroup 决定分组）
 * @param command 原始命令（input=command 的步骤收到它）
 * @param deps 模型调用能力（server 注入 providers 适配器）
 * @param onEvent 运行事件回调（RunEvent）
 * @param options stepIds / signal / runId
 */
export async function runWorkflow(
  def: WorkflowDef,
  command: string,
  deps: WorkflowDeps,
  onEvent: (event: RunEvent) => void,
  options: RunWorkflowOptions = {},
): Promise<RunWorkflowResult> {
  const emit = (event: RunEvent): void => onEvent(event);
  const signal = options.signal;
  const defs = new Map<string, WorkflowStep>(def.steps.map((item) => [item.id, item]));

  const requested = options.stepIds?.length ? new Set(options.stepIds) : undefined;
  const steps = requested ? def.steps.filter((item) => requested.has(item.id)) : def.steps;
  const groups = groupWorkflowSteps(steps);

  emit({ type: "stage", stage: "workflow", label: def.name, at: Date.now() });

  const runs: WorkflowStepRun[] = [];
  const executed = new Set<string>();
  let completed: WorkflowStepRun[] = [];
  let previousGroup: WorkflowStepRun[] = [];
  let usage: Usage = {};

  for (const group of groups) {
    if (signal?.aborted) break;
    const groupInputs = group.map((item) => {
      const input = item.input ?? "command";
      if (input === "command") return command;
      if (input === "previous") return renderRuns(previousGroup, defs);
      return renderAll(completed, defs);
    });

    const groupRuns = await Promise.all(
      group.map((item, index) =>
        runStep({ step: item, inputText: groupInputs[index] ?? command, deps, emit, signal }),
      ),
    );

    for (const run of groupRuns) {
      executed.add(run.stepId);
      runs.push(run);
      if (hasUsage(run.usage)) usage = mergeUsage(usage, run.usage);
    }
    completed = [...completed, ...groupRuns];
    previousGroup = groupRuns;
    if (signal?.aborted) break;
  }

  // 取消 / 提前停止：未开始的步骤补 skipped，保持执行顺序。
  for (const step of steps) {
    if (executed.has(step.id)) continue;
    runs.push({ stepId: step.id, name: step.name, status: "skipped", text: "" });
  }

  const done = [...runs].reverse().find((run) => run.status === "done");
  const finalText = done?.text ?? "";
  const resultUsage = finalizeUsage(usage);
  return { finalText, steps: runs, usage: resultUsage };
}
