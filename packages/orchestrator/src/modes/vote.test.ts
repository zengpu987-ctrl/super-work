import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { chooseBest, parseScores } from "./vote.js";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  runOrchestrator,
  stageIds,
} from "./testkit.js";

const p1 = makeParticipant("p1", { role: "方案甲" });
const p2 = makeParticipant("p2", { role: "方案乙" });
const p3 = makeParticipant("p3", { role: "方案丙" });
const judge = makeParticipant("j1", { role: "独立裁判" });

const SCORE_TABLE = [
  "- p1：6/10 —— 尚可\n",
  "- p2：9/10 —— 最完整\n",
  "- p3：7/10 —— 一般\n",
  "选择理由：p2 的答案最完整、可执行。",
];

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function voteHandler(call: { system?: string; model: string }) {
  const system = call.system ?? "";
  if (system.includes("评分择优")) return { chunks: SCORE_TABLE };
  if (system.includes("融合终稿")) return { chunks: ["融合", "终稿"] };
  if (call.model === "mock-p2") return { chunks: ["答案-B"] };
  if (call.model === "mock-p3") return { chunks: ["答案-C", "答案-C", "答案-C"] };
  return { chunks: ["答案-A"] };
}

test("vote：并行作答 → 裁判评分 → 融合终稿，最高分答案参与终稿", async () => {
  const { deps, calls } = createFakeDeps(voteHandler);
  const args = makeArgs({ mode: "vote", participants: [p1, p2, p3], judge });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "judge", "synthesis"]);
  assert.equal(calls.length, 5, "3 次作答 + 1 次评分 + 1 次融合");
  assert.equal(result.finalText, "融合终稿");
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);

  // synthesize 融合终稿的块同步成 final.delta（"融合" + "终稿"）
  const streamedFinal = narrow(events, "final.delta");
  assert.deepEqual(
    streamedFinal.map((event) => event.text),
    ["融合", "终稿"],
  );

  const scoringCall = calls.find((call) => (call.system ?? "").includes("评分择优"));
  assert.ok(scoringCall?.system?.includes("1-10"), "评分任务说明包含 1-10 分");
  assert.ok(scoringCall?.system?.includes("p1"));
  assert.ok(scoringCall?.system?.includes("p2"));
  assert.ok(scoringCall?.system?.includes("p3"));

  const synthesisCall = calls.find((call) => (call.system ?? "").includes("融合终稿"));
  assert.ok(synthesisCall?.system?.includes("答案-B"), "融合时带上各答案");
  assert.ok(synthesisCall?.system?.includes("9/10"), "融合时带上评分表");
  assert.ok(synthesisCall?.system?.includes("p2"));
});

test("vote：synthesize=false 时最终答案 = 最高分答案 + 裁判评语附录", async () => {
  const { deps, calls } = createFakeDeps(voteHandler);
  const args = makeArgs({
    mode: "vote",
    participants: [p1, p2, p3],
    judge,
    options: { synthesize: false },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "judge"]);
  assert.equal(calls.length, 4, "3 次作答 + 1 次评分，不再融合");
  assert.ok(result.finalText.startsWith("答案-B"), "最高分 p2 的答案在前");
  assert.ok(result.finalText.includes("## 裁判评语"));
  assert.ok(result.finalText.includes("选择理由：p2 的答案最完整、可执行。"));
  assert.equal(finalDeltaMismatch(events), undefined);

  // 非 synthesis 路径：final.delta 在收尾时一次性按 48 字分块补发
  const finalDeltas = narrow(events, "final.delta");
  assert.equal(finalDeltas.length, Math.ceil(result.finalText.length / 48));
  assert.equal(finalDeltas.map((event) => event.text).join(""), result.finalText);
  const lastModelDone = events.findLastIndex((event) => event.type === "model.done");
  const firstFinalDelta = events.findIndex((event) => event.type === "final.delta");
  assert.ok(lastModelDone < firstFinalDelta, "final.delta 全部在所有 model.done 之后");
});

test("vote：评分表解析失败 → 按最长答案兜底并 notice", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("评分择优")) return { chunks: ["各有所长，难分高下。"] };
    if (system.includes("融合终稿")) return { chunks: ["不应被调用的融合终稿"] };
    if (call.model === "mock-p2") return { chunks: ["答案-B"] };
    if (call.model === "mock-p3") return { chunks: ["答案-C", "答案-C", "答案-C"] };
    return { chunks: ["答案-A"] };
  });
  const args = makeArgs({
    mode: "vote",
    participants: [p1, p2, p3],
    judge,
    options: { synthesize: false },
  });
  const { result, events } = await runOrchestrator(args, deps);

  const notices = narrow(events, "notice");
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.message.includes("兜底"));
  assert.ok(result.finalText.startsWith("答案-C答案-C答案-C"), "最长答案兜底");
  assert.ok(result.finalText.includes("各有所长，难分高下。"));
  assert.equal(
    narrow(events, "final.delta").map((event) => event.text).join(""),
    result.finalText,
  );
});

test("parseScores：支持多种评分写法并避免 id 前缀误配", () => {
  const basic = parseScores("p1：8/10 —— 好\np2：9/10 —— 更好", ["p1", "p2"]);
  assert.equal(basic.get("p1"), 8);
  assert.equal(basic.get("p2"), 9);

  const table = parseScores("| p1 | 7 |\n| p2 | 4 |", ["p1", "p2"]);
  assert.equal(table.get("p1"), 7);
  assert.equal(table.get("p2"), 4);

  const keyword = parseScores("p1 得分 8 分，理由充分", ["p1"]);
  assert.equal(keyword.get("p1"), 8);

  const prefix = parseScores("p10：9/10", ["p1", "p10"]);
  assert.equal(prefix.get("p10"), 9);
  assert.equal(prefix.get("p1"), undefined, "p1 不能从 p10 里误配");

  const none = parseScores("都很好，没有分数", ["p1", "p2"]);
  assert.equal(none.size, 0);
});

test("chooseBest：按分数选优，同分取更长，无分数取最长", () => {
  const answers = [
    { participant: p1, text: "短答案" },
    { participant: p2, text: "更长一些的答案-B" },
    { participant: p3, text: "答案-C" },
  ];
  assert.equal(chooseBest(answers, new Map([["p1", 9]]))?.participant.id, "p1");
  assert.equal(chooseBest(answers, new Map())?.participant.id, "p2");
  assert.equal(
    chooseBest(answers, new Map([["p1", 8], ["p2", 8]]))?.participant.id,
    "p2",
    "同分取更长",
  );
});
