/**
 * auto（自动调度）模式：
 *   stage:plan       裁判输出 JSON 计划 { subtasks: [{ title, assignee, instruction, dependsOn? }] }
 *   stage:handoff    按计划执行子任务（无依赖并行、有依赖分波次；每棒独立 model.start/delta/done）
 *   stage:synthesis  裁判汇总各子任务产出 → 最终答案
 *
 * 计划解析失败（或规划模型不可用）→ 发 notice 并降级到 council 行为。
 * 计划里的 assignee 非法 → 顺序分派；dependsOn 无解 → 忽略该项。
 */
import type { Participant } from "@super-work/core";
import { DEFAULT_JUDGE_ROLE, DEFAULT_ROLE, buildSystemPrompt } from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { mapPool, truncateText } from "../util.js";
import { run as runCouncil } from "./council.js";

export interface SubTask {
  index: number;
  title: string;
  instruction: string;
  assignee: Participant;
  dependsOn: number[];
}

export interface PlanParseResult {
  subtasks: SubTask[];
  warnings: string[];
  error?: string;
}

const MAX_SUBTASKS = 8;

const SYNTHESIS_TASK = [
  "你是本次自动调度的总协调者。请把各子任务的产出汇总裁决为面向用户的最终答案：",
  "1) 吸收正确内容、消除冲突、补全缺口；",
  "2) 输出可直接使用的完整答案（该给成品给成品，该给代码给可运行代码）；",
  "3) 不要罗列子任务编号，也不要提及其他模型或调度过程。",
].join("\n");

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 从文本里抠出第一个完整的 JSON 对象（字符串感知的花括号配对）。 */
function findBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * 提取文本里的 JSON 计划对象：优先 ```json 代码块，其次全文，最后第一个 {…} 片段。
 * 不依赖模型一定给纯 JSON。
 */
export function extractJsonObject(text: string): unknown {
  if (!text) return undefined;
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
    const balanced = findBalancedObject(candidate);
    if (balanced) {
      const fromBalanced = tryParseJson(balanced);
      if (fromBalanced !== undefined) return fromBalanced;
    }
  }
  return undefined;
}

function resolveAssignee(
  requested: string,
  participants: readonly Participant[],
  index: number,
  warnings: string[],
): Participant {
  const wanted = requested.trim();
  if (wanted) {
    const byId = participants.find((participant) => participant.id === wanted);
    if (byId) return byId;
    const byLabel = participants.find((participant) => participant.label === wanted);
    if (byLabel) return byLabel;
    const byModel = participants.find(
      (participant) =>
        participant.model === wanted || `${participant.provider}/${participant.model}` === wanted,
    );
    if (byModel) return byModel;
    warnings.push(`计划中的执行者「${wanted}」不在参与者列表中，已按顺序改为 ${
      participants[index % participants.length]?.id ?? "第一位参与者"
    }。`);
  }
  return participants[index % participants.length] as Participant;
}

function resolveDepends(
  raw: unknown,
  subtasks: readonly SubTask[],
  warnings: string[],
): number[] {
  if (!Array.isArray(raw)) return [];
  const deps: number[] = [];
  for (const entry of raw) {
    let target: number | undefined;
    if (typeof entry === "number" && Number.isFinite(entry)) {
      const value = Math.floor(entry);
      if (value >= 0 && value < subtasks.length) target = value;
      else if (value >= 1 && value <= subtasks.length) target = value - 1;
    } else if (typeof entry === "string") {
      const text = entry.trim();
      if (text) {
        const byTitle = subtasks.findIndex((subtask) => subtask.title === text);
        if (byTitle >= 0) target = byTitle;
        else {
          const numeric = /^(\d+)$/.exec(text);
          if (numeric) {
            const value = Number(numeric[1]);
            if (value >= 1 && value <= subtasks.length) target = value - 1;
            else if (value >= 0 && value < subtasks.length) target = value;
          } else {
            const byInclude = subtasks.findIndex(
              (subtask) => subtask.title.includes(text) || text.includes(subtask.title),
            );
            if (byInclude >= 0) target = byInclude;
          }
        }
      }
    }
    if (target === undefined) warnings.push(`忽略了无法识别的依赖项「${String(entry)}」。`);
    else deps.push(target);
  }
  return Array.from(new Set(deps));
}

/** 解析裁判给出的计划；解析失败时返回 error，由调用方降级。 */
export function parsePlan(text: string, participants: readonly Participant[]): PlanParseResult {
  const warnings: string[] = [];
  if (participants.length === 0) return { subtasks: [], warnings, error: "没有可用参与者" };

  const parsed = extractJsonObject(text);
  if (typeof parsed !== "object" || parsed === null) {
    return { subtasks: [], warnings, error: "没有找到合法 JSON" };
  }
  const record = parsed as Record<string, unknown>;
  const rawList = Array.isArray(record.subtasks)
    ? record.subtasks
    : Array.isArray(record.tasks)
      ? record.tasks
      : undefined;
  if (!rawList || rawList.length === 0) {
    return { subtasks: [], warnings, error: "计划里缺少 subtasks 数组" };
  }

  const items = rawList
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, MAX_SUBTASKS);
  if (items.length === 0) return { subtasks: [], warnings, error: "subtasks 里没有可用对象" };

  // 第一遍：标题 / 指令 / 执行者。
  const drafts = items.map((item, index) => {
    const title = asText(item.title) || asText(item.name) || `子任务 ${index + 1}`;
    const instruction =
      asText(item.instruction) || asText(item.task) || asText(item.detail) || title;
    const requested =
      asText(item.assignee) || asText(item.assigneeId) || asText(item.owner) || "";
    const assignee = resolveAssignee(requested, participants, index, warnings);
    return { title, instruction, assignee, rawDepends: item.dependsOn ?? item.deps, index };
  });

  const subtasks: SubTask[] = drafts.map((draft) => ({
    index: draft.index,
    title: draft.title,
    instruction: draft.instruction,
    assignee: draft.assignee,
    dependsOn: [],
  }));

  // 第二遍：依赖（标题 / 序号），此时所有标题都已就绪。
  drafts.forEach((draft, position) => {
    const subtask = subtasks[position];
    subtask.dependsOn = resolveDepends(draft.rawDepends, subtasks, warnings).filter(
      (dependency) => dependency !== subtask.index,
    );
  });

  return { subtasks, warnings };
}

interface SubtaskOutcome {
  index: number;
  text: string;
  ok: boolean;
}

/** 子任务按依赖分波执行；没有依赖的一波并行。 */
async function executeSubtasks(ctx: RunContext, subtasks: readonly SubTask[]): Promise<Map<number, string>> {
  const done = new Map<number, string>();
  const attempted = new Set<number>();
  let pending = subtasks.map((subtask) => subtask.index);

  while (pending.length > 0) {
    if (ctx.aborted) break;
    const ready = subtasks.filter(
      (subtask) =>
        pending.includes(subtask.index) &&
        subtask.dependsOn.every((dependency) => attempted.has(dependency)),
    );
    // 循环依赖或依赖全部指向已失败任务时，退化为顺序放行，避免卡死。
    const batch = ready.length > 0 ? ready : subtasks.filter((subtask) => pending.includes(subtask.index));

    const outcomes = await mapPool(batch, ctx.concurrency, async (subtask): Promise<SubtaskOutcome> => {
      if (ctx.aborted) return { index: subtask.index, text: "", ok: false };
      const stageLabel = `子任务 ${subtask.index + 1}/${subtasks.length}：${subtask.title}`;
      ctx.emit({ type: "stage", stage: "handoff", label: stageLabel, at: Date.now() });

      const dependencyMaterial = subtask.dependsOn
        .map((dependency) => {
          const subtaskDependency = subtasks.find((item) => item.index === dependency);
          const text = done.get(dependency) ?? "";
          return `### ${subtaskDependency?.title ?? `子任务 ${dependency + 1}`}\n${
            text.trim() ? truncateText(text, ctx.answerLimit(3000)) : "（该前置子任务未产出内容）"
          }`;
        })
        .join("\n\n");

      const task = [
        `你负责的子任务：${subtask.title}`,
        `具体要求：${subtask.instruction}`,
        "只完成这个子任务，不要替其他子任务作答；输出可直接并入最终答案的成品内容。",
      ].join("\n");
      const extra = [dependencyMaterial ? `## 已完成的前置子任务\n${dependencyMaterial}` : "", ctx.attachmentsContext]
        .filter(Boolean)
        .join("\n\n");
      const system = buildSystemPrompt({
        role: subtask.assignee.role || DEFAULT_ROLE,
        stageTitle: "子任务执行",
        task,
        command: ctx.command,
        language: ctx.language,
        extra: extra || undefined,
      });
      const userContent = [
        "## 原始命令",
        ctx.command,
        "",
        dependencyMaterial
          ? `## 已完成的前置子任务\n${dependencyMaterial}`
          : "## 前置子任务\n（无：本子任务可以独立完成）",
        "",
        `## 你的子任务\n${subtask.title}\n${subtask.instruction}`,
      ].join("\n");

      const outcome = await ctx.call(subtask.assignee, {
        system,
        messages: [{ role: "user", content: userContent }],
        label: stageLabel,
        stage: "handoff",
        reference: ctx.attachmentsContext,
      });
      if (!outcome.ok) {
        ctx.emit({
          type: "notice",
          level: "warn",
          message: `${subtask.assignee.label} 执行子任务「${subtask.title}」失败，已跳过。`,
          at: Date.now(),
        });
      }
      return { index: subtask.index, text: outcome.text, ok: outcome.ok };
    });

    for (const settled of outcomes) {
      if (settled.status === "rejected") continue;
      attempted.add(settled.value.index);
      if (settled.value.ok && settled.value.text.trim()) done.set(settled.value.index, settled.value.text);
    }
    pending = pending.filter((index) => !attempted.has(index));
  }

  return done;
}

export async function run(ctx: RunContext): Promise<string> {
  const participants = ctx.participants;
  if (participants.length === 0) return "";

  const planner = ctx.judge;
  ctx.register(planner);

  // ---------- stage: plan ----------
  ctx.emit({ type: "stage", stage: "plan", label: "任务规划：拆解子任务", at: Date.now() });

  const participantList = participants
    .map(
      (participant) =>
        `- participantId: ${participant.id}；模型：${participant.label}；角色：${
          participant.role || "未指定"
        }`,
    )
    .join("\n");
  const planTask = [
    "你是本次联合工作的调度者。请把用户命令拆成 2~5 个可执行子任务，并为每个子任务指定最合适的执行者。",
    "只输出一个 JSON 对象（可以放在 ```json 代码块里），格式：",
    '{"subtasks":[{"title":"子任务标题","assignee":"执行者的 participantId","instruction":"给执行者的具体指令","dependsOn":["前置子任务标题"]}]}',
    "assignee 必须来自下面列出的 participantId；dependsOn 可选，省略表示可以并行执行。",
    "除 JSON 之外不要输出任何解释。",
  ].join("\n");

  const planSystem = buildSystemPrompt({
    role: planner.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "任务规划",
    task: planTask,
    command: ctx.command,
    language: ctx.language,
    extra: `## 可选执行者\n${participantList}`,
  });
  const planOutcome = await ctx.call(planner, {
    system: planSystem,
    messages: [{ role: "user", content: ctx.command }],
    label: "任务规划",
    stage: "plan",
  });

  if (ctx.aborted) return "";
  if (!planOutcome.ok || !planOutcome.text.trim()) {
    ctx.emit({
      type: "notice",
      level: "warn",
      message: "规划模型未能产出计划，已降级为议会模式。",
      at: Date.now(),
    });
    return runCouncil(ctx);
  }

  const parsed = parsePlan(planOutcome.text, participants);
  for (const warning of parsed.warnings) {
    ctx.emit({ type: "notice", level: "warn", message: warning, at: Date.now() });
  }
  if (parsed.error || parsed.subtasks.length === 0) {
    ctx.emit({
      type: "notice",
      level: "warn",
      message: `任务计划解析失败（${parsed.error ?? "没有可执行子任务"}），已降级为议会模式。`,
      at: Date.now(),
    });
    return runCouncil(ctx);
  }

  // ---------- 执行子任务 ----------
  const produced = await executeSubtasks(ctx, parsed.subtasks);
  if (ctx.aborted) return "";

  const hasAny = [...produced.values()].some((text) => text.trim());
  if (!hasAny) {
    ctx.emit({
      type: "notice",
      level: "error",
      message: "所有子任务均未产出有效内容。",
      at: Date.now(),
    });
    return "";
  }

  // ---------- stage: synthesis ----------
  ctx.emit({ type: "stage", stage: "synthesis", label: "汇总裁决", at: Date.now() });

  const material = parsed.subtasks
    .map((subtask) => {
      const text = produced.get(subtask.index) ?? "";
      return `### 子任务 ${subtask.index + 1}：${subtask.title}（执行者：${
        subtask.assignee.label
      }）\n${text.trim() ? truncateText(text, ctx.answerLimit(4000)) : "（该子任务未产出内容）"}`;
    })
    .join("\n\n");

  const synthesisSystem = buildSystemPrompt({
    role: planner.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "汇总裁决",
    task: SYNTHESIS_TASK,
    command: ctx.command,
    language: ctx.language,
    extra: `## 子任务产出\n${material}`,
  });
  const synthesis = await ctx.call(planner, {
    system: synthesisSystem,
    messages: [{ role: "user", content: ctx.command }],
    label: "汇总裁决",
    stage: "synthesis",
    streamFinal: true,
  });

  if (ctx.aborted) return "";
  if (synthesis.ok && synthesis.text.trim()) return synthesis.text;

  ctx.emit({
    type: "notice",
    level: "warn",
    message: "总协调模型未能产出汇总裁决，已回退到最完整的子任务产出。",
    at: Date.now(),
  });
  let best = "";
  for (const text of produced.values()) if (text.length > best.length) best = text;
  return best || ctx.longestText();
}
