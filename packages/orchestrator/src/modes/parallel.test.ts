import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { composeParallelAnswer } from "./parallel.js";
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

const p1 = makeParticipant("p1");
const p2 = makeParticipant("p2");
const p3 = makeParticipant("p3");
const judge = makeParticipant("j1", { role: "总协调裁判" });

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function synthesisHandler(call: { system?: string; model: string }) {
  const system = call.system ?? "";
  if (system.includes("综合最终答案")) return { chunks: ["最终-", "合并答案"] };
  return { chunks: [`答案-${call.model}`] };
}

test("parallel：有裁判 → 全员并行作答后裁判综合，终稿同步流式", async () => {
  const { deps, calls } = createFakeDeps(synthesisHandler);
  const args = makeArgs({ mode: "parallel", participants: [p1, p2, p3], judge });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "synthesis"]);
  assert.equal(calls.length, 4, "3 位参与者并行作答 + 1 次裁判综合");
  assert.equal(result.finalText, "最终-合并答案");

  // 裁判综合边走 streamFinal：final.delta 与裁判的 model.delta 同块同步
  assert.deepEqual(
    narrow(events, "final.delta").map((event) => event.text),
    ["最终-", "合并答案"],
  );
  assert.equal(finalDeltaMismatch(events), undefined);
  assert.deepEqual(deltaMismatches(events), []);

  const synthesis = calls[3];
  assert.equal(synthesis?.model, "mock-j1");
  assert.ok(synthesis?.system?.includes("答案-mock-p1"));
  assert.ok(synthesis?.system?.includes("答案-mock-p2"));
  assert.ok(synthesis?.system?.includes("答案-mock-p3"));
});

test("parallel：无裁判 → 按顺序拼接各答案（### label 分隔，final.delta 一次性分块）", async () => {
  const long = repeat("并行答案", 30);
  const { deps, calls } = createFakeDeps((call) => ({ chunks: [long] }));
  const args = makeArgs({ mode: "parallel", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout"]);
  assert.equal(calls.length, 2, "没有裁判就不产生裁判调用");

  const expected = composeParallelAnswer([
    { participant: p1, text: long },
    { participant: p2, text: long },
  ]);
  assert.equal(result.finalText, expected);
  assert.ok(result.finalText.indexOf("### 模型 p1") < result.finalText.indexOf("### 模型 p2"));

  const finalDeltas = narrow(events, "final.delta");
  assert.ok(finalDeltas.length > 1, "长终稿在收尾时按块补发");
  assert.equal(finalDeltas.map((event) => event.text).join(""), expected);
  assert.equal(finalDeltaMismatch(events), undefined);

  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.message.includes("未配置裁判模型")));
});

test("parallel：synthesize=false → 即使有裁判也直接拼接，不调用裁判", async () => {
  const { deps, calls } = createFakeDeps(synthesisHandler);
  const args = makeArgs({
    mode: "parallel",
    participants: [p1, p2],
    judge,
    options: { synthesize: false },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.model !== "mock-j1"), "关闭综合后裁判 0 次调用");
  assert.equal(
    result.finalText,
    composeParallelAnswer([
      { participant: p1, text: "答案-mock-p1" },
      { participant: p2, text: "答案-mock-p2" },
    ]),
  );
  assert.ok(
    narrow(events, "notice").some((notice) => notice.message.includes("synthesize=false")),
  );
  assert.equal(finalDeltaMismatch(events), undefined);
});

test("parallel：单模型失败只丢自己那份答案，整轮继续", async () => {
  const { deps, calls } = createFakeDeps((call) => {
    if (call.model === "mock-p2") return { error: "p2 挂了" };
    return { chunks: [`答案-${call.model}`] };
  });
  const args = makeArgs({ mode: "parallel", participants: [p1, p2, p3] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 3);
  assert.equal(
    result.finalText,
    composeParallelAnswer([
      { participant: p1, text: "答案-mock-p1" },
      { participant: p3, text: "答案-mock-p3" },
    ]),
  );
  const errors = narrow(events, "model.error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.participantId, "p2");
  assert.ok(errors[0]?.message.includes("p2 挂了"));
  assert.equal(narrow(events, "run.done").length, 1);
});

test("parallel：全员失败 → run.error + 空结果，不抛异常", async () => {
  const { deps } = createFakeDeps(() => ({ error: "都挂了" }));
  const args = makeArgs({ mode: "parallel", participants: [p1, p2] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(result.finalText, "");
  assert.deepEqual(stageIds(events), ["fanout"]);
  assert.equal(narrow(events, "model.error").length, 2);
  const errors = narrow(events, "run.error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.message.includes("所有模型均未产出可用结果"));
  assert.equal(events.at(-1)?.type, "run.error");
});

test("composeParallelAnswer：按传入顺序用 ### label 分隔", () => {
  assert.equal(
    composeParallelAnswer([
      { participant: p2, text: "B" },
      { participant: p1, text: "A" },
    ]),
    "### 模型 p2\n\nB\n\n### 模型 p1\n\nA",
  );
  assert.equal(composeParallelAnswer([]), "");
});
