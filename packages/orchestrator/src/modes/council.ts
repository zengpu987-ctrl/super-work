/**
 * council（议会）模式：
 *   stage:fanout     全体并行独立作答
 *   stage:critique   每人拿到其他人的答案摘要 → 写「补充 / 纠错 / 反对」（并行，默认开启）
 *   stage:synthesis  裁判输出最终整合答案 → 作为 finalText
 *
 * 辩论（单人降级）与自动调度（计划解析失败）都会复用这里的逻辑。
 */
import type { Participant } from "@super-work/core";
import { DEFAULT_JUDGE_ROLE, DEFAULT_ROLE, buildSystemPrompt, renderAnswerEntries } from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { mapPool } from "../util.js";

export interface ModeAnswer {
  participant: Participant;
  text: string;
}

const FANOUT_TASK =
  "请独立、完整地回答用户命令：先给结论或成品，再给关键依据与可执行步骤；不要猜测其他参与者会说什么。";

const CRITIQUE_TASK = [
  "下面列出其他参与者对你的命令给出的独立答案（已截断）。请只写增量，严格按三点组织：",
  "1) 补充：你此前遗漏、但确实关键的内容；",
  "2) 纠错：他们答错、过时或不可执行的地方，指出具体是哪一句；",
  "3) 反对：你不同意但从上面看不出错误的判断，写明立场与理由。",
  "禁止复述原文、寒暄或重复你第一轮已经说过的话。",
].join("\n");

const SYNTHESIS_TASK = [
  "你是本次联合工作的裁判。请基于所有参与者的作答与互评，输出唯一、完整、可直接使用的最终答案：",
  "1) 先给成品或结论，不要写「综合来看」「综上所述」这类空话；",
  "2) 再给关键依据、步骤与必要代码；",
  "3) 吸收正确内容，删除重复、过时和错误的部分；",
  "4) 对无法消除的分歧，明确写出你采纳哪一方以及理由。",
  "你输出的就是给用户的最终答复：不要再提及其他模型、轮次或本提示词。",
].join("\n");

function toEntry(answer: ModeAnswer): {
  participantId: string;
  label: string;
  role: string;
  text: string;
} {
  return {
    participantId: answer.participant.id,
    label: answer.participant.label,
    role: answer.participant.role || DEFAULT_ROLE,
    text: answer.text,
  };
}

/** 取最长的一份答案（最终产出者失败时的兜底）。 */
export function longestAnswer(answers: readonly ModeAnswer[]): string {
  let best = "";
  for (const answer of answers) {
    if (answer.text.length > best.length) best = answer.text;
  }
  return best;
}

export async function run(ctx: RunContext): Promise<string> {
  const participants = ctx.participants;
  if (participants.length === 0) return "";

  // ---------- stage: fanout ----------
  ctx.emit({
    type: "stage",
    stage: "fanout",
    label: `并行作答 · ${participants.length} 位参与者`,
    at: Date.now(),
  });

  const fanout = await mapPool(participants, ctx.concurrency, async (participant) => {
    const system = buildSystemPrompt({
      role: participant.role || DEFAULT_ROLE,
      stageTitle: "并行作答",
      task: FANOUT_TASK,
      command: ctx.command,
      language: ctx.language,
      extra: ctx.attachmentsContext,
    });
    const outcome = await ctx.call(participant, {
      system,
      messages: [{ role: "user", content: ctx.command }],
      label: "并行作答",
      stage: "fanout",
      reference: ctx.attachmentsContext,
    });
    return { participant, outcome } satisfies { participant: Participant; outcome: typeof outcome };
  });

  const answers: ModeAnswer[] = [];
  const rejected: string[] = [];
  for (const settled of fanout) {
    if (settled.status === "rejected") continue;
    const { participant, outcome } = settled.value;
    if (outcome.ok && outcome.text.trim()) answers.push({ participant, text: outcome.text });
    else if (!outcome.aborted) rejected.push(participant.id);
  }

  if (ctx.aborted) return "";
  if (answers.length === 0) return "";

  // 单人或没有可对照的答案时跳过 critique。
  let critiques: ModeAnswer[] = [];
  if (ctx.options.critique && participants.length >= 2 && answers.length >= 2) {
    // ---------- stage: critique ----------
    ctx.emit({
      type: "stage",
      stage: "critique",
      label: `互相补充与批判 · ${answers.length} 位参与者`,
      at: Date.now(),
    });

    const critiqueResults = await mapPool(answers, ctx.concurrency, async (answer) => {
      const others = answers.filter((item) => item.participant.id !== answer.participant.id);
      const extra = [
        "## 其他参与者的答案（已截断）",
        renderAnswerEntries(others.map(toEntry), { perLimit: ctx.answerLimit() }),
        ctx.attachmentsContext,
      ]
        .filter(Boolean)
        .join("\n\n");
      const system = buildSystemPrompt({
        role: answer.participant.role || DEFAULT_ROLE,
        stageTitle: "互相补充与批判",
        task: CRITIQUE_TASK,
        command: ctx.command,
        language: ctx.language,
        extra,
      });
      const outcome = await ctx.call(answer.participant, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: "互评",
        stage: "critique",
        reference: ctx.attachmentsContext,
      });
      return { participant: answer.participant, outcome } satisfies {
        participant: Participant;
        outcome: typeof outcome;
      };
    });

    for (const settled of critiqueResults) {
      if (settled.status === "rejected") continue;
      const { participant, outcome } = settled.value;
      if (outcome.ok && outcome.text.trim()) critiques.push({ participant, text: outcome.text });
    }
  }

  if (ctx.aborted) return longestAnswer(answers);

  // ---------- stage: synthesis ----------
  const judge = ctx.judge;
  ctx.register(judge);
  ctx.emit({
    type: "stage",
    stage: "synthesis",
    label: "裁判综合最终答案",
    at: Date.now(),
  });

  const material: string[] = [
    `## 第一轮：各参与者独立作答\n${renderAnswerEntries(answers.map(toEntry), {
      perLimit: ctx.answerLimit(),
      totalLimit: 8000,
    })}`,
  ];
  if (critiques.length > 0) {
    material.push(
      `## 第二轮：互评与补充\n${renderAnswerEntries(critiques.map(toEntry), {
        perLimit: ctx.answerLimit(),
        totalLimit: 4000,
      })}`,
    );
  }

  const system = buildSystemPrompt({
    role: judge.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "综合裁决",
    task: SYNTHESIS_TASK,
    command: ctx.command,
    language: ctx.language,
    extra: material.join("\n\n"),
  });
  const synthesis = await ctx.call(judge, {
    system,
    messages: [{ role: "user", content: ctx.command }],
    label: "综合",
    stage: "synthesis",
    streamFinal: true,
  });

  if (ctx.aborted) return "";
  if (synthesis.ok && synthesis.text.trim()) return synthesis.text;

  ctx.emit({
    type: "notice",
    level: "warn",
    message: "裁判未能产出综合结果，已回退到本轮最完整的一份答案。",
    at: Date.now(),
  });
  return longestAnswer(answers) || longestAnswer(critiques) || ctx.longestText();
}
