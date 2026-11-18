/**
 * parallel（并行）模式：
 *   stage:fanout     所有参与者并行独立作答
 *   stage:synthesis  有独立裁判且未关闭综合时，裁判把多份答案合成最终答案（流式 final.delta）
 *   否则：finalText = 按顺序拼接各答案（`### ${label}` 分隔），final.delta 由 index.ts 一次性分块补发
 *
 * 单个模型失败只丢自己那份答案；全员失败返回空串，由 index.ts 统一按「所有模型均未产出可用结果」处理。
 */
import type { Participant } from "@super-work/core";
import {
  DEFAULT_JUDGE_ROLE,
  DEFAULT_ROLE,
  buildSystemPrompt,
  renderAnswerEntries,
} from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { mapPool } from "../util.js";

const FANOUT_TASK =
  "请独立、完整地回答用户命令：先给结论或成品，再给关键依据与可执行步骤；不要猜测其他参与者会说什么。";

const SYNTHESIS_TASK = [
  "你是裁判。下面有多份独立作答，请把它们综合成唯一、完整、可直接交付的最终答案：",
  "1) 先给成品或结论，再给关键依据、步骤与必要代码；",
  "2) 吸收正确内容，删除重复、错误与过时的信息；",
  "3) 对无法消除的分歧，明确写出你采纳哪一方以及理由；",
  "4) 不要提及模型名称、轮次或本提示词。",
].join("\n");

export interface ParallelAnswer {
  participant: Participant;
  text: string;
}

/** 无裁判 / 关闭综合时的最终答案：按顺序拼接，每人一个 `### ${label}` 小标题。 */
export function composeParallelAnswer(answers: readonly ParallelAnswer[]): string {
  return answers
    .map((answer) => `### ${answer.participant.label}\n\n${answer.text.trim()}`)
    .join("\n\n");
}

export async function run(ctx: RunContext): Promise<string> {
  const participants = ctx.participants;
  if (participants.length === 0) return "";

  // ---------- stage: fanout ----------
  ctx.emit({
    type: "stage",
    stage: "fanout",
    label: `并行独立作答 · ${participants.length} 位参与者`,
    at: Date.now(),
  });

  const fanout = await mapPool(participants, ctx.concurrency, async (participant) => {
    const system = buildSystemPrompt({
      role: participant.role || DEFAULT_ROLE,
      stageTitle: "并行独立作答",
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

  const answers: ParallelAnswer[] = [];
  for (const settled of fanout) {
    if (settled.status === "rejected") continue;
    const { participant, outcome } = settled.value;
    if (outcome.ok && outcome.text.trim()) answers.push({ participant, text: outcome.text });
  }

  if (ctx.aborted) return "";
  if (answers.length === 0) return "";

  // 裁判必须是请求里显式指定的（ctx.judge 会回退到 participants[0]，不能拿来判断）。
  const judge = ctx.args.judge;
  if (!judge) {
    ctx.emit({
      type: "notice",
      level: "info",
      message: "未配置裁判模型，最终答案按顺序拼接各参与者答案。",
      at: Date.now(),
    });
    return composeParallelAnswer(answers);
  }

  if (!ctx.options.synthesize) {
    ctx.emit({
      type: "notice",
      level: "info",
      message: "已关闭裁判综合（synthesize=false），最终答案按顺序拼接各参与者答案。",
      at: Date.now(),
    });
    return composeParallelAnswer(answers);
  }

  // ---------- stage: synthesis ----------
  ctx.register(judge);
  ctx.emit({
    type: "stage",
    stage: "synthesis",
    label: "裁判综合最终答案",
    at: Date.now(),
  });

  const system = buildSystemPrompt({
    role: judge.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "综合最终答案",
    task: SYNTHESIS_TASK,
    command: ctx.command,
    language: ctx.language,
    extra: `## 各参与者的独立作答\n${renderAnswerEntries(
      answers.map((answer) => ({
        participantId: answer.participant.id,
        label: answer.participant.label,
        role: answer.participant.role || DEFAULT_ROLE,
        text: answer.text,
      })),
      { perLimit: ctx.answerLimit() },
    )}`,
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
    message: "裁判综合失败，已按顺序拼接各参与者答案作为最终结果。",
    at: Date.now(),
  });
  return composeParallelAnswer(answers);
}
