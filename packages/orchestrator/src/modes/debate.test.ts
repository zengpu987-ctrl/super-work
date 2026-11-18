import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  runOrchestrator,
  stageIds,
  stages,
} from "./testkit.js";

const p1 = makeParticipant("p1", { role: "产品经理" });
const p2 = makeParticipant("p2", { role: "安全专家" });
const p3 = makeParticipant("p3", { role: "工程师" });
const p4 = makeParticipant("p4", { role: "运维" });
const judge = makeParticipant("j1", { role: "独立裁判" });

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function debateHandler(call: { system?: string }, index: number) {
  const system = call.system ?? "";
  if (system.includes("裁判裁决")) return { chunks: ["胜方：正方", "；", "最终结论"], usage: { inputTokens: 1, outputTokens: 1 } };
  if (system.includes("轮反驳")) return { chunks: [`反驳-${index}`] };
  return { chunks: [`立论-${index}`] };
}

test("debate：立论 → 2 轮反驳 → 裁决，轮次与正反方正确", async () => {
  const { deps, calls } = createFakeDeps(debateHandler);
  const args = makeArgs({ mode: "debate", participants: [p1, p2, p3, p4], judge });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["opening", "rebuttal", "rebuttal", "judge"]);
  assert.equal(calls.length, 13, "4 立论 + 2×4 反驳 + 1 裁决");
  assert.equal(result.finalText, "胜方：正方；最终结论");
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);

  // 裁判裁决同步流式：3 个块 → 3 个 final.delta
  const finalDeltas = narrow(events, "final.delta");
  assert.deepEqual(
    finalDeltas.map((event) => event.text),
    ["胜方：正方", "；", "最终结论"],
  );

  const openingCalls = calls.slice(0, 4);
  assert.ok(openingCalls[0]?.system?.includes("立论 · 正方"));
  assert.ok(openingCalls[0]?.system?.includes("产品经理"));
  assert.ok(openingCalls[1]?.system?.includes("立论 · 反方"));
  assert.ok(openingCalls[1]?.system?.includes("安全专家"));
  assert.ok(openingCalls[2]?.system?.includes("立论 · 正方"));
  assert.ok(openingCalls[3]?.system?.includes("立论 · 反方"));

  // 第 2 轮反驳：p1（正方）必须看到对手（p2、p4）第 1 轮的最新论点
  const round2First = calls[8];
  assert.ok(round2First?.system?.includes("第 2 轮反驳"));
  assert.ok(round2First?.system?.includes("反驳-5"), "看到 p2 的第 1 轮论点");
  assert.ok(round2First?.system?.includes("反驳-7"), "看到 p4 的第 1 轮论点");
  assert.ok(round2First?.system?.includes("反驳-4"), "看到自己第 1 轮反驳");

  // 裁决只调用一次，且 final 事件跟随
  const judgeCalls = calls.filter((call) => (call.system ?? "").includes("裁判裁决"));
  assert.equal(judgeCalls.length, 1);
  assert.equal(narrow(events, "final")[0]?.text, "胜方：正方；最终结论");

  // 辩论阶段标签
  assert.deepEqual(
    stages(events).map((stage) => stage.stage),
    ["opening", "rebuttal", "rebuttal", "judge"],
  );
  assert.ok(stages(events)[1]?.label.includes("第 1 轮"));
  assert.ok(stages(events)[2]?.label.includes("第 2 轮"));
});

test("debate：rounds=1 时只有 1 轮反驳", async () => {
  const { deps, calls } = createFakeDeps(debateHandler);
  const args = makeArgs({
    mode: "debate",
    participants: [p1, p2],
    judge,
    options: { rounds: 1 },
  });
  const { events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["opening", "rebuttal", "judge"]);
  assert.equal(calls.length, 2 + 2 + 1);
});

test("debate：只有 1 位参与者时降级为 council 单人并 notice", async () => {
  const { deps, calls } = createFakeDeps((call, index) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { chunks: ["单人最终答案"] };
    if (system.includes("互相补充与批判")) return { chunks: [`互评-${index}`] };
    return { chunks: [`独立-${index}`] };
  });
  const args = makeArgs({ mode: "debate", participants: [p1] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "synthesis"], "降级为议会行为");
  assert.equal(calls.length, 2);
  assert.equal(result.finalText, "单人最终答案");

  const notices = narrow(events, "notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.level, "warn");
  assert.ok(notices[0]?.message.includes("降级为议会模式"));
});

test("results.stages：同一 participant 多轮 rebuttal 以最后一次为准，不重复追加", async () => {
  const { deps } = createFakeDeps((call, index) => {
    const system = call.system ?? "";
    if (system.includes("裁判裁决")) return { chunks: ["裁决"] };
    if (system.includes("轮反驳")) return { chunks: [`反驳-${index}`] };
    return { chunks: [`立论-${index}`] };
  });
  const args = makeArgs({ mode: "debate", participants: [p1, p2], judge });
  const { result } = await runOrchestrator(args, deps);

  const p1Result = result.results.find((item) => item.participantId === "p1");
  assert.equal(p1Result?.text, "立论-0", "text 保留首次立论");
  assert.deepEqual(
    p1Result?.stages?.map((stage) => stage.stage),
    ["opening", "rebuttal"],
    "两轮反驳只留一条 rebuttal",
  );
  assert.equal(p1Result?.stages?.find((stage) => stage.stage === "opening")?.text, "立论-0");
  assert.equal(
    p1Result?.stages?.find((stage) => stage.stage === "rebuttal")?.text,
    "反驳-4",
    "rebuttal 取最后一轮（p1 第 2 轮 rebuttal 是第 5 次调用）",
  );
  assert.equal(p1Result?.stages?.length, 2);
});
