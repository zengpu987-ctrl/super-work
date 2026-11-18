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

const planner = makeParticipant("p1", { role: "规划师" });
const engineer = makeParticipant("p2", { role: "工程师" });
const reviewer = makeParticipant("p3", { role: "审校员" });

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

test("pipeline：严格串行，前一棒产物交给下一棒，最后一棒即 finalText", async () => {
  const { deps, calls } = createFakeDeps((_call, index) => ({ chunks: [`产物-`, `${index}`] }));
  const args = makeArgs({ mode: "pipeline", participants: [planner, engineer, reviewer] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["handoff", "handoff", "handoff"]);
  assert.equal(calls.length, 3, "每一棒一次调用");

  const labels = stages(events).map((stage) => stage.label);
  assert.ok(labels[0]?.includes("第 1 棒"));
  assert.ok(labels[1]?.includes("第 2 棒"));
  assert.ok(labels[2]?.includes("第 3 棒"));

  // 串行：第 2、3 棒的开始时间在前一棒结束后（通过 call 顺序 + 输入内容验证）
  assert.ok(calls[1]?.system?.includes("接力 · 第 2/3 棒"));
  assert.ok(calls[1]?.messages[0]?.content.includes("产物-0"), "第二棒看到第一棒产物");
  assert.ok(calls[1]?.messages[0]?.content.includes("本周上线计划"), "始终带原始命令");

  assert.ok(calls[2]?.system?.includes("接力 · 第 3/3 棒"));
  assert.ok(calls[2]?.messages[0]?.content.includes("产物-1"), "第三棒看到第二棒产物");
  // 最后一棒是审校角色 → 提示输出定稿
  assert.ok(calls[2]?.system?.includes("定稿"));
  assert.ok(calls[2]?.messages[0]?.content.includes("定稿"));

  assert.equal(result.finalText, "产物-2");
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);

  const startLabels = narrow(events, "model.start").map((event) => event.label);
  assert.deepEqual(startLabels, ["第 1 棒 · 模型 p1", "第 2 棒 · 模型 p2", "第 3 棒 · 模型 p3（定稿）"]);

  // 每棒一个 result：text = 本棒产出，stages 各一条 handoff
  assert.deepEqual(
    result.results.map((item) => [item.participantId, item.text, item.stages?.map((stage) => stage.stage)]),
    [
      ["p1", "产物-0", ["handoff"]],
      ["p2", "产物-1", ["handoff"]],
      ["p3", "产物-2", ["handoff"]],
    ],
  );
  assert.deepEqual(result.results[2]?.stages?.[0], { stage: "handoff", text: "产物-2" });
});

test("pipeline：中间一棒失败不中断，后续棒继续使用上一棒产物", async () => {
  const { deps, calls } = createFakeDeps((_call, index) => {
    if (index === 1) return { error: "第二棒模型崩了" };
    return { chunks: [`产物-${index}`] };
  });
  const args = makeArgs({ mode: "pipeline", participants: [planner, engineer, reviewer] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 3, "失败的一棒之后仍然继续");
  assert.equal(result.finalText, "产物-2");
  // 第三棒拿到的是第一棒（最后成功的一棒）的产物
  assert.ok(calls[2]?.messages[0]?.content.includes("产物-0"));
  assert.ok(calls[2]?.messages[0]?.content.includes("上一棒未产出内容") === false);

  const notices = narrow(events, "notice");
  assert.equal(notices.length, 1);
  assert.ok(notices[0]?.message.includes("第 2 棒"));
  assert.equal(narrow(events, "model.error").length, 1);
  assert.equal(narrow(events, "run.done").length, 1);
});

test("pipeline：单人时只跑一棒", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["唯一一棒"] }));
  const args = makeArgs({ mode: "pipeline", participants: [planner] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 1);
  assert.deepEqual(stageIds(events), ["handoff"]);
  assert.ok(stages(events)[0]?.label.includes("第 1 棒"));
  assert.equal(result.finalText, "唯一一棒");
});
