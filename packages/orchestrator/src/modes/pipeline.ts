/**
 * pipeline（接力）模式：严格串行。
 *   第 1 棒看到原始命令 → 第 2 棒看到「原始命令 + 上一棒产物（截断）」→ ……
 *   最后一棒的输出即 finalText（若最后一棒是审校角色，明确要求输出定稿）。
 * 每一棒开始前发一个 stage:handoff，label 带「第 N 棒」。
 */
import { DEFAULT_ROLE, buildSystemPrompt } from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { truncateText } from "../util.js";

/** 前一棒产物交给下一棒时的截断长度（避免上下文爆炸）。 */
const HANDOFF_LIMIT = 4000;

const REVIEW_ROLE_PATTERN =
  /审校|校对|终审|定稿|复核|审查|把关|review|proofread|editor|finali[sz]e/i;

/** 判断某个角色的字符串是否「审校 / 定稿」类。 */
export function isReviewRole(text: string): boolean {
  return REVIEW_ROLE_PATTERN.test(text || "");
}

function rodTask(index: number, total: number, isLast: boolean, review: boolean): string {
  if (total === 1) {
    return review
      ? "你是唯一的一棒，角色是审校 / 定稿：请输出最终定稿——完整成品，不要只给修改说明。"
      : "你是唯一的一棒：请直接输出完整、可直接交付的最终成果。";
  }
  if (index === 0) {
    return "你是第 1 棒：请直接开工，产出第一版完整成果，为后面的接力打好底子。";
  }
  if (!isLast) {
    return [
      "基于前一棒产物继续加工：补齐缺口、修正错误、把结果推进到更可用的状态。",
      "保留有用部分，不要从零重写；也不要只写一句「已完成」。",
    ].join("");
  }
  if (review) {
    return [
      "你是最后一棒，角色是审校 / 定稿：在上一棒产物基础上完成审校与最终修订，",
      "输出面向用户的最终定稿——必须是完整成品，不要只给修改说明或差异列表。",
    ].join("");
  }
  return "你是最后一棒：请在前一棒产物基础上输出完整、可直接交付的最终答案（不要只给改动说明）。";
}

export async function run(ctx: RunContext): Promise<string> {
  const participants = ctx.participants;
  if (participants.length === 0) return "";

  const total = participants.length;
  let carried = "";
  let carriedLabel = "";
  let lastText = "";

  for (let index = 0; index < total; index += 1) {
    if (ctx.aborted) break;
    const participant = participants[index];
    const isLast = index === total - 1;
    const review = isLast && isReviewRole(`${participant.role} ${participant.label}`);
    const stageLabel = `第 ${index + 1} 棒 · ${participant.label}${isLast ? "（定稿）" : ""}`;

    ctx.emit({
      type: "stage",
      stage: "handoff",
      label: stageLabel,
      at: Date.now(),
    });

    const task = rodTask(index, total, isLast, review);
    const carriedText = carried ? truncateText(carried, ctx.answerLimit(HANDOFF_LIMIT)) : "";
    const handoffBlock =
      index === 0
        ? "## 前一棒产物\n（无：你是第一棒，请直接开工）"
        : `## 前一棒产物（来自 ${carriedLabel}，已截断）\n${
            carriedText || "（上一棒未产出内容，请基于原始命令自行补全）"
          }`;

    const userContent = [
      "## 原始命令",
      ctx.command,
      "",
      handoffBlock,
      "",
      `## 你的这一棒\n${task}`,
    ].join("\n");

    const system = buildSystemPrompt({
      role: participant.role || DEFAULT_ROLE,
      stageTitle: `接力 · 第 ${index + 1}/${total} 棒`,
      task,
      command: ctx.command,
      language: ctx.language,
      extra: [handoffBlock, ctx.attachmentsContext].filter(Boolean).join("\n\n"),
    });

    const outcome = await ctx.call(participant, {
      system,
      messages: [{ role: "user", content: userContent }],
      label: stageLabel,
      stage: "handoff",
      reference: ctx.attachmentsContext,
    });

    if (ctx.aborted) break;
    if (outcome.ok && outcome.text.trim()) {
      carried = outcome.text;
      carriedLabel = participant.label;
      lastText = outcome.text;
    } else {
      ctx.emit({
        type: "notice",
        level: "warn",
        message: `${participant.label} 的第 ${index + 1} 棒失败，已跳过该棒；下一棒继续使用上一棒产物。`,
        at: Date.now(),
      });
    }
  }

  if (ctx.aborted) return lastText;
  return lastText;
}
