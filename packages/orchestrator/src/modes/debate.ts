/**
 * debate（辩论）模式：
 *   stage:opening    参与者按顺序分正/反两方，各自立论（并行）
 *   stage:rebuttal   第 1..rounds 轮互相反驳（每轮并行，看到对方最新论点）
 *   stage:judge      裁判裁决（明确胜方、关键分歧、最终结论）→ 作为 finalText
 *
 * 只有 1 位参与者时降级为 council 单人并 notice。
 */
import type { Participant } from "@super-work/core";
import { DEFAULT_JUDGE_ROLE, DEFAULT_ROLE, buildSystemPrompt, renderAnswerEntries } from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { mapPool, truncateText } from "../util.js";
import { run as runCouncil } from "./council.js";

export type DebateSide = "正方" | "反方";

export interface DebateAssignment {
  participant: Participant;
  side: DebateSide;
}

/** 按参与者顺序分方：偶数索引正方，奇数索引反方。 */
export function assignSides(participants: readonly Participant[]): DebateAssignment[] {
  return participants.map((participant, index) => ({
    participant,
    side: index % 2 === 0 ? "正方" : "反方",
  }));
}

function openingTask(side: DebateSide): string {
  if (side === "正方") {
    return [
      "你属于【正方】。请为用户命令所要求的做法做最有力的立论：",
      "它为什么可行、值得执行，落地要点、前置条件与成功标准是什么。",
      "给出可验证的论据（事实、机制、成本收益），不要空喊口号。",
    ].join("\n");
  }
  return [
    "你属于【反方】。请审慎质疑用户命令所要求的做法：",
    "指出风险、隐含成本、逻辑漏洞、反例与更优替代方案，并给出可验证的论据。",
    "不要为了反对而反对：你的目标是在被说服之前把问题问清楚。",
  ].join("\n");
}

function rebuttalTask(round: number, rounds: number): string {
  return [
    `这是第 ${round} 轮反驳（共 ${rounds} 轮）。`,
    "针对对手的具体论断逐条反驳：指出事实错误、逻辑漏洞或收益/成本问题；",
    "同时修正你自己上一轮被证明有误的地方。",
    "只写增量与反驳，不要复述原文，不要展开新的无关话题。",
  ].join("\n");
}

const JUDGE_TASK = [
  "你是辩论裁判，不属于任何一方。请严格按以下结构输出裁决：",
  "1) 胜方：明确写出「胜方：正方」或「胜方：反方」；",
  "2) 关键分歧：列出双方最关键的 2~3 个分歧点，并说明哪一方更站得住脚、为什么；",
  "3) 最终结论：面向用户命令的可执行答案（可以采纳某一方或折中），",
  "   不要在结论里写「正方认为」这类转述，直接给用户可用的内容。",
].join("\n");

interface Argument {
  participant: Participant;
  side: DebateSide;
  text: string;
}

function longestArgument(arguments_: Iterable<Argument>): string {
  let best = "";
  for (const argument of arguments_) {
    if (argument.text.length > best.length) best = argument.text;
  }
  return best;
}

function argumentEntry(argument: Argument): {
  participantId: string;
  label: string;
  role: string;
  text: string;
} {
  return {
    participantId: argument.participant.id,
    label: `${argument.participant.label}（${argument.side}）`,
    role: argument.participant.role || DEFAULT_ROLE,
    text: argument.text,
  };
}

export async function run(ctx: RunContext): Promise<string> {
  const participants = ctx.participants;
  if (participants.length === 0) return "";
  if (participants.length < 2) {
    ctx.emit({
      type: "notice",
      level: "warn",
      message: "辩论模式至少需要 2 位参与者，已降级为议会模式（单人作答 + 综合）。",
      at: Date.now(),
    });
    return runCouncil(ctx);
  }

  const assignments = assignSides(participants);
  /** participantId → 最新一次论点 */
  const latest = new Map<string, Argument>();

  // ---------- stage: opening ----------
  ctx.emit({
    type: "stage",
    stage: "opening",
    label: `立论 · 正方 ${Math.ceil(participants.length / 2)} 人 vs 反方 ${Math.floor(
      participants.length / 2,
    )} 人`,
    at: Date.now(),
  });

  const opening = await mapPool(assignments, ctx.concurrency, async ({ participant, side }) => {
    const system = buildSystemPrompt({
      role: participant.role || DEFAULT_ROLE,
      stageTitle: `立论 · ${side}`,
      task: openingTask(side),
      command: ctx.command,
      language: ctx.language,
      extra: ctx.attachmentsContext,
    });
    const outcome = await ctx.call(participant, {
      system,
      messages: [{ role: "user", content: ctx.command }],
      label: `立论 · ${side}`,
      stage: "opening",
      reference: ctx.attachmentsContext,
    });
    return { participant, side, outcome };
  });

  for (const settled of opening) {
    if (settled.status === "rejected") continue;
    const { participant, side, outcome } = settled.value;
    if (outcome.ok && outcome.text.trim()) latest.set(participant.id, { participant, side, text: outcome.text });
  }

  if (ctx.aborted) return "";
  if (latest.size === 0) return "";

  // ---------- stage: rebuttal ----------
  const rounds = ctx.options.rounds;
  for (let round = 1; round <= rounds; round += 1) {
    if (ctx.aborted) break;
    ctx.emit({
      type: "stage",
      stage: "rebuttal",
      label: `第 ${round} 轮反驳`,
      at: Date.now(),
    });

    const roundResults = await mapPool(assignments, ctx.concurrency, async ({ participant, side }) => {
      const opponents = [...latest.values()].filter((argument) => argument.side !== side);
      const own = latest.get(participant.id);
      const extraParts = [
        opponents.length > 0
          ? `## 对手最新论点\n${renderAnswerEntries(opponents.map(argumentEntry), {
              perLimit: ctx.answerLimit(2500),
              totalLimit: 8000,
            })}`
          : "## 对手最新论点\n（对手尚未给出有效论点，请补强你自己的立论）",
      ];
      if (own) extraParts.push(`## 你上一轮的论点（已截断）\n${truncateText(own.text, 1500)}`);
      if (ctx.attachmentsContext) extraParts.push(ctx.attachmentsContext);
      const system = buildSystemPrompt({
        role: participant.role || DEFAULT_ROLE,
        stageTitle: `第 ${round} 轮反驳 · ${side}`,
        task: rebuttalTask(round, rounds),
        command: ctx.command,
        language: ctx.language,
        extra: extraParts.join("\n\n"),
      });
      const outcome = await ctx.call(participant, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: `第 ${round} 轮反驳 · ${side}`,
        stage: "rebuttal",
        reference: ctx.attachmentsContext,
      });
      return { participant, side, outcome };
    });

    for (const settled of roundResults) {
      if (settled.status === "rejected") continue;
      const { participant, side, outcome } = settled.value;
      if (outcome.ok && outcome.text.trim()) {
        latest.set(participant.id, { participant, side, text: outcome.text });
      }
    }
  }

  if (ctx.aborted) return longestArgument(latest.values());

  // ---------- stage: judge ----------
  const judge = ctx.judge;
  ctx.register(judge);
  ctx.emit({
    type: "stage",
    stage: "judge",
    label: "裁判裁决与最终结论",
    at: Date.now(),
  });

  const pro = [...latest.values()].filter((argument) => argument.side === "正方");
  const con = [...latest.values()].filter((argument) => argument.side === "反方");
  const material = [
    `## 正方论点\n${renderAnswerEntries(pro.map(argumentEntry), {
      perLimit: ctx.answerLimit(3000),
      totalLimit: 6000,
      emptyHint: "（正方未产出有效论点）",
    })}`,
    `## 反方论点\n${renderAnswerEntries(con.map(argumentEntry), {
      perLimit: ctx.answerLimit(3000),
      totalLimit: 6000,
      emptyHint: "（反方未产出有效论点）",
    })}`,
  ].join("\n\n");

  const system = buildSystemPrompt({
    role: judge.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "裁判裁决",
    task: JUDGE_TASK,
    command: ctx.command,
    language: ctx.language,
    extra: material,
  });
  const verdict = await ctx.call(judge, {
    system,
    messages: [{ role: "user", content: ctx.command }],
    label: "裁判裁决",
    stage: "judge",
    streamFinal: true,
  });

  if (ctx.aborted) return "";
  if (verdict.ok && verdict.text.trim()) return verdict.text;

  ctx.emit({
    type: "notice",
    level: "warn",
    message: "裁判未能产出裁决，已回退到当前最完整的立场陈述。",
    at: Date.now(),
  });
  return longestArgument(latest.values()) || ctx.longestText();
}
