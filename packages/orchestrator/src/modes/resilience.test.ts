import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { orchestrate } from "../index.js";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  repeat,
  runOrchestrator,
  stageIds,
} from "./testkit.js";

const p1 = makeParticipant("p1", { role: "参与者一" });
const p2 = makeParticipant("p2", { role: "参与者二" });
const judge = makeParticipant("j1", { role: "独立裁判" });

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

test("容错：单模型失败只发 model.error，整轮继续并产出最终答案", async () => {
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (call.model === "mock-p1") return { error: "p1 崩了" };
    if (system.includes("综合裁决")) return { chunks: ["最终答案"], usage: { inputTokens: 10, outputTokens: 5 } };
    return { chunks: ["可用答案"], usage: { inputTokens: 10, outputTokens: 5 } };
  });
  const args = makeArgs({ mode: "council", participants: [p1, p2], judge });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 3, "p1 失败、p2 一次作答、裁判综合一次");
  assert.equal(result.finalText, "最终答案");
  assert.deepEqual(stageIds(events), ["fanout", "synthesis"], "只剩 1 份答案时不互评");

  const errors = narrow(events, "model.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.participantId, "p1");
  assert.equal(errors[0]?.message, "p1 崩了");

  const p1Result = result.results.find((item) => item.participantId === "p1");
  assert.equal(p1Result?.error, "p1 崩了");
  assert.equal(p1Result?.text, "");
  const p2Result = result.results.find((item) => item.participantId === "p2");
  assert.equal(p2Result?.text, "可用答案");

  // usage 只累计成功的调用
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
  assert.equal(narrow(events, "run.done").length, 1);
  assert.equal(finalDeltaMismatch(events), undefined);
});

test("容错：裁判综合失败 → 回退到最完整的一份答案并 notice", async () => {
  const longAnswer = repeat("更长的答案", 6);
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { error: "裁判挂了" };
    if (system.includes("互相补充与批判")) return { chunks: ["互评"] };
    if (call.model === "mock-p2") return { chunks: [longAnswer] };
    return { chunks: ["短答案"] };
  });
  const args = makeArgs({ mode: "council", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 5, "2 次作答 + 2 次互评 + 1 次失败的综合（裁判=p1）");
  assert.equal(result.finalText, longAnswer);
  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.level === "warn" && notice.message.includes("回退")));
  assert.equal(narrow(events, "run.done").length, 1);
  assert.deepEqual(deltaMismatches(events), []);
});

test("容错：裁判流到一半失败 → 保留已流出的 final.delta，追加兜底后保持一致", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) {
      return { chunks: ["半截裁判结论"], errorAfterChunks: 1, error: "流断了" };
    }
    if (system.includes("互相补充与批判")) return { chunks: ["互评"] };
    if (call.model === "mock-p2") return { chunks: ["备用完整答案"] };
    return { chunks: ["短"] };
  });
  const args = makeArgs({ mode: "council", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps);

  const finalDeltas = narrow(events, "final.delta");
  assert.equal(finalDeltas[0]?.text, "半截裁判结论", "失败前已流出的块保留");
  assert.equal(finalDeltas.map((event) => event.text).join(""), result.finalText);
  assert.equal(result.finalText, "半截裁判结论\n\n备用完整答案");
  assert.equal(narrow(events, "final")[0]?.text, result.finalText);
  assert.equal(finalDeltaMismatch(events), undefined);
  assert.equal(narrow(events, "run.done").length, 1);
});

test("results.stages：失败阶段不产生空 stage，results.text 仍是首次成功作答", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("互相补充与批判") && call.model === "mock-p1") {
      return { error: "互评失败" };
    }
    if (system.includes("综合裁决")) return { chunks: ["最终答案"] };
    if (system.includes("互相补充与批判")) return { chunks: ["互评-p2"] };
    return { chunks: [`作答-${call.model}`] };
  });
  const args = makeArgs({ mode: "council", participants: [p1, p2], judge });
  const { result } = await runOrchestrator(args, deps);

  const p1Result = result.results.find((item) => item.participantId === "p1");
  assert.equal(p1Result?.text, "作答-mock-p1");
  assert.deepEqual(
    p1Result?.stages?.map((stage) => stage.stage),
    ["fanout"],
    "失败的互评不产生空 stage",
  );
  assert.ok((p1Result?.stages ?? []).every((stage) => stage.text.trim().length > 0));
  assert.equal(p1Result?.error, undefined, "已有成功作答不标失败");

  const p2Result = result.results.find((item) => item.participantId === "p2");
  assert.deepEqual(
    p2Result?.stages?.map((stage) => stage.stage),
    ["fanout", "critique"],
  );
});

test("容错：所有模型失败 → run.error + 空结果，不抛异常", async () => {
  const { deps, calls } = createFakeDeps(() => ({ error: "全部挂了" }));
  const args = makeArgs({ mode: "council", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 2);
  assert.equal(result.finalText, "");
  assert.deepEqual(result.usage, {});
  assert.equal(narrow(events, "model.error").length, 2);
  assert.equal(narrow(events, "final").length, 0);
  assert.equal(narrow(events, "final.delta").length, 0);
  assert.equal(narrow(events, "run.done").length, 0);
  const errors = narrow(events, "run.error");
  assert.equal(errors.length, 1);
  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.level === "error"));
  assert.equal(result.results.length, 2);
  for (const item of result.results) assert.equal(item.error, "全部挂了");
  assert.equal(events.at(-1)?.type, "run.error");
});

test("容错：没有参与者 → notice + run.error，不抛异常", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: [] }));
  const args = makeArgs({ mode: "council", participants: [] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 0);
  assert.equal(result.finalText, "");
  assert.deepEqual(stageIds(events), []);
  assert.equal(narrow(events, "run.error").length, 1);
  assert.equal(events.at(-1)?.type, "run.error");
});

test("超时：单次调用超时按错误处理，并回退到已有答案", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { hangUntilAbort: true };
    return { chunks: ["快速答案"] };
  });
  const args = makeArgs({
    mode: "council",
    participants: [p1],
    options: { timeoutMs: 30 },
  });
  const { result, events } = await runOrchestrator(args, deps);

  const errors = narrow(events, "model.error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.message.includes("超时"));
  assert.ok(errors[0]?.message.includes("30ms"));
  assert.equal(result.finalText, "快速答案");
  assert.equal(narrow(events, "run.done").length, 1);
});

test("取消：已 abort 的 signal 只发 run.start 就返回", async () => {
  const controller = new AbortController();
  controller.abort();
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["不该出现"] }));
  const args = makeArgs({ mode: "council", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps, controller.signal);

  assert.equal(calls.length, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.start"],
  );
  assert.equal(result.finalText, "");
  assert.equal(result.results.length, 2, "结果里仍然列出参与者");
});

test("取消：运行中 abort 后尽快返回，不抛异常、不发终态事件", async () => {
  const controller = new AbortController();
  const { deps } = createFakeDeps(() => ({ chunks: ["第一段", "第二段", "第三段"], delayMs: 5 }));
  const args = makeArgs({ mode: "council", participants: [p1] });
  const events: RunEvent[] = [];
  const result = await orchestrate(
    args,
    deps,
    (event) => {
      events.push(event);
      if (event.type === "model.delta") controller.abort();
    },
    controller.signal,
  );

  assert.equal(result.finalText, "");
  assert.equal(narrow(events, "model.done").length, 0, "取消后不发 model.done");
  assert.equal(narrow(events, "run.done").length, 0);
  assert.equal(narrow(events, "run.error").length, 0);
  assert.equal(narrow(events, "final").length, 0);
});
