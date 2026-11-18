/**
 * vote（投票）模式：
 *   stage:fanout     并行独立作答
 *   stage:judge      裁判输出评分表（每个 participantId 1-10 分 + 一句理由 + 选择理由）
 *   stage:synthesis  裁判融合终稿（synthesize !== false 时）→ 作为 finalText
 *                    synthesize === false 时：最高分答案 + 裁判评语附录
 * 评分表解析失败 → 按最长答案兜底。
 */
import type { Participant } from "@super-work/core";
import { DEFAULT_JUDGE_ROLE, DEFAULT_ROLE, buildSystemPrompt, renderAnswerEntries } from "../prompts.js";
import type { RunContext } from "../runtime.js";
import { mapPool, truncateText } from "../util.js";

export interface VoteAnswer {
  participant: Participant;
  text: string;
}

const TEN_PATTERN = /(\d{1,3}(?:\.\d+)?)\s*(?:\/|／|out\s+of)\s*10/i;
const KEYWORD_PATTERN = /(?:得分|分数|评分|打分|总分|score|rating)\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)/i;
const NUMBER_PATTERN = /(?:^|[^\d.])(\d{1,2}(?:\.\d+)?)(?![\d.])/;

function clampScore(value: number): number {
  return Math.min(10, Math.max(0, value));
}

function scoreFromSegment(segment: string): number | undefined {
  const ten = TEN_PATTERN.exec(segment);
  if (ten) {
    const value = Number.parseFloat(ten[1]);
    if (Number.isFinite(value)) return clampScore(value);
  }
  const keyword = KEYWORD_PATTERN.exec(segment);
  if (keyword) {
    const value = Number.parseFloat(keyword[1]);
    if (Number.isFinite(value)) return clampScore(value);
  }
  const plain = NUMBER_PATTERN.exec(segment);
  if (plain) {
    const value = Number.parseFloat(plain[1]);
    if (Number.isFinite(value)) return clampScore(value);
  }
  return undefined;
}

function isWordyChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

function findIdIndex(line: string, id: string): number {
  let from = 0;
  for (;;) {
    const index = line.indexOf(id, from);
    if (index < 0) return -1;
    const before = index > 0 ? line[index - 1] : undefined;
    const after = index + id.length < line.length ? line[index + id.length] : undefined;
    if (!isWordyChar(before) && !isWordyChar(after)) return index;
    from = index + 1;
  }
}

/**
 * 从裁判的评分表里解析 { participantId → 分数(0-10) }。
 * 支持 `p1: 8/10`、`p1 得分 8`、`| p1 | 8 |`、`p1：8 分` 等常见写法。
 */
export function parseScores(text: string, ids: readonly string[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (!text || ids.length === 0) return scores;
  const sortedIds = [...ids].sort((a, b) => b.length - a.length);

  for (const line of text.split(/\r?\n/)) {
    const hits: Array<{ id: string; index: number }> = [];
    for (const id of sortedIds) {
      const index = findIdIndex(line, id);
      if (index >= 0) hits.push({ id, index });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.index - b.index);

    // 同一个位置被长短两个 id 命中时只保留长的那个。
    const filtered: Array<{ id: string; index: number }> = [];
    for (const hit of hits) {
      const inside = filtered.some(
        (kept) => hit.index >= kept.index && hit.index < kept.index + kept.id.length,
      );
      if (!inside) filtered.push(hit);
    }

    filtered.forEach((hit, position) => {
      const start = hit.index + hit.id.length;
      const end = position + 1 < filtered.length ? filtered[position + 1].index : line.length;
      let score = scoreFromSegment(line.slice(start, end));
      if (score === undefined && filtered.length === 1) {
        score = scoreFromSegment(line.split(hit.id).join(" "));
      }
      if (score !== undefined) scores.set(hit.id, score);
    });
  }

  return scores;
}

/** 选出胜出答案：最高分；无分数时按最长答案兜底；同分取更长的那份。 */
export function chooseBest(
  answers: readonly VoteAnswer[],
  scores: Map<string, number>,
): VoteAnswer | undefined {
  if (answers.length === 0) return undefined;
  let best: VoteAnswer | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const answer of answers) {
    const score = scores.get(answer.participant.id);
    if (score === undefined) continue;
    if (best === undefined || score > bestScore || (score === bestScore && answer.text.length > best.text.length)) {
      best = answer;
      bestScore = score;
    }
  }
  if (best) return best;
  let longest: VoteAnswer | undefined;
  for (const answer of answers) {
    if (longest === undefined || answer.text.length > longest.text.length) longest = answer;
  }
  return longest;
}

/** synthesize === false / 融合失败时的终稿：胜出答案 + 裁判评语附录。 */
export function composeVoteResult(answerText: string, scoringText: string | undefined): string {
  const body = answerText.trim();
  const review = (scoringText ?? "").trim();
  if (!review) return body;
  return `${body}\n\n---\n\n## 裁判评语\n${review}`;
}

function scoringTask(ids: readonly string[]): string {
  return [
    "你是裁判。请给下面每一份独立作答打分（1-10 分），并且只输出评分表，格式严格如下：",
    "- <participantId>：X/10 —— 一句话理由",
    "……",
    "最后另起一段写「选择理由：……」，说明你为什么选最高分的那份答案。",
    `必须点评到每一个 participantId（${ids.join("、")}），不得遗漏、不得编造不存在的 id。`,
    "评分只看答案对用户命令的完成度、正确性与可执行性，不要被篇幅或语气影响。",
  ].join("\n");
}

function synthesisTask(winner: VoteAnswer | undefined, hasScores: boolean): string {
  const head = winner
    ? `你是裁判。评分表显示 ${winner.participant.label}（id: ${winner.participant.id}）的答案得分最高。`
    : "你是裁判。评分结果不可用，请直接综合下面所有答案。";
  return [
    head,
    "请以它为最大权重，融合其他答案中的正确补充，输出唯一的最终终稿：",
    "1) 先给成品或结论，再给关键依据、步骤与必要代码；",
    "2) 删除重复、过时和错误的内容；",
    `3) 不要提及${hasScores ? "评分过程、" : ""}模型名称或「某模型认为」这类转述。`,
  ].join("\n");
}

function entryOf(answer: VoteAnswer): {
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
      task: "请独立、完整地回答用户命令，给出你的最佳方案与关键依据。这份答案会被匿名比较打分，请直接给成品。",
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
    return { participant, outcome };
  });

  const answers: VoteAnswer[] = [];
  for (const settled of fanout) {
    if (settled.status === "rejected") continue;
    const { participant, outcome } = settled.value;
    if (outcome.ok && outcome.text.trim()) answers.push({ participant, text: outcome.text });
  }
  if (ctx.aborted) return "";
  if (answers.length === 0) return "";

  const judge = ctx.judge;
  ctx.register(judge);

  // ---------- stage: judge（评分表） ----------
  ctx.emit({
    type: "stage",
    stage: "judge",
    label: "裁判评分与择优",
    at: Date.now(),
  });

  const ids = answers.map((answer) => answer.participant.id);
  const scoringSystem = buildSystemPrompt({
    role: judge.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "评分择优",
    task: scoringTask(ids),
    command: ctx.command,
    language: ctx.language,
    extra: `## 待评分的独立作答\n${renderAnswerEntries(answers.map(entryOf), {
      perLimit: ctx.answerLimit(3000),
      totalLimit: 9000,
    })}`,
  });
  const scoring = await ctx.call(judge, {
    system: scoringSystem,
    messages: [{ role: "user", content: ctx.command }],
    label: "裁判评分",
    stage: "judge",
  });

  if (ctx.aborted) return "";

  const scores = scoring.ok ? parseScores(scoring.text, ids) : new Map<string, number>();
  const winner = chooseBest(answers, scores);

  if (!scoring.ok) {
    ctx.emit({
      type: "notice",
      level: "warn",
      message: "裁判评分调用失败，已按最长答案兜底。",
      at: Date.now(),
    });
  } else if (scores.size === 0) {
    ctx.emit({
      type: "notice",
      level: "warn",
      message: "裁判评分表解析失败，已按最长答案兜底。",
      at: Date.now(),
    });
  }

  const scoreTable = scoring.ok && scoring.text.trim() ? scoring.text : undefined;

  // ---------- synthesize === false：答案 + 评语附录 ----------
  if (!ctx.options.synthesize) {
    return composeVoteResult(winner?.text ?? "", scoreTable);
  }

  // ---------- stage: synthesis（融合终稿） ----------
  ctx.emit({
    type: "stage",
    stage: "synthesis",
    label: "裁判融合终稿",
    at: Date.now(),
  });

  const material = [
    `## 各参与者答案\n${renderAnswerEntries(answers.map(entryOf), {
      perLimit: ctx.answerLimit(3000),
      totalLimit: 9000,
    })}`,
    scoreTable ? `## 评分表\n${truncateText(scoreTable, 2500)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const synthesisSystem = buildSystemPrompt({
    role: judge.role || DEFAULT_JUDGE_ROLE,
    stageTitle: "融合终稿",
    task: synthesisTask(winner, scores.size > 0),
    command: ctx.command,
    language: ctx.language,
    extra: material,
  });
  const synthesis = await ctx.call(judge, {
    system: synthesisSystem,
    messages: [{ role: "user", content: ctx.command }],
    label: "融合终稿",
    stage: "synthesis",
    streamFinal: true,
  });

  if (ctx.aborted) return "";
  if (synthesis.ok && synthesis.text.trim()) return synthesis.text;

  ctx.emit({
    type: "notice",
    level: "warn",
    message: "裁判融合失败，已使用胜出答案 + 评语作为最终结果。",
    at: Date.now(),
  });
  return composeVoteResult(winner?.text ?? ctx.longestText(), scoreTable);
}
