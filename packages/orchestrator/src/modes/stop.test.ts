import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunControl, RunEvent } from "@super-work/core";
import { orchestrate } from "../index.js";
import { createFakeDeps, makeArgs, makeParticipant, runOrchestrator, eventTypes } from "./testkit.js";

const slow = makeParticipant("p1");
const fast = makeParticipant("p2");

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

test("单独停止某个模型：只中断它，其余模型继续，最终答案不包含被停模型", async () => {
  const chunks = Array.from({ length: 40 }, (_, index) => `片${index}`);
  const { deps, calls } = createFakeDeps((call) =>
    call.model.includes("p1") ? { chunks, delayMs: 12 } : { chunks: ["快速答案"] },
  );
  let control: RunControl | undefined;
  const events: RunEvent[] = [];
  const args = makeArgs({ mode: "parallel", participants: [slow, fast] });
  args.onControl = (handle) => {
    control = handle;
  };
  const orchestrating = orchestrate(args, deps, (event) => events.push(event));

  // 等两个模型都开始后，单独停掉慢的那个
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(control, "orchestrator 应把控制句柄交回");
  assert.equal(control?.stopParticipant("p1"), true);
  await orchestrating;

  const stopped = narrow(events, "model.stopped");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.participantId, "p1");
  assert.ok((stopped[0]?.text ?? "").length > 0, "停止时保留已生成的部分输出");

  const errors = narrow(events, "model.error");
  assert.equal(errors.length, 0, "停止不是失败，不发 model.error");
  assert.equal(narrow(events, "model.done").length, 1, "快速模型仍然完成");
  assert.ok(calls.length >= 2);
  assert.ok(eventTypes(events).includes("final"));
});

test("停止尚未开始的模型：轮到它时直接跳过（model.stopped），不发起调用", async () => {
  const { deps, calls } = createFakeDeps((call) =>
    call.model.includes("p1")
      ? { chunks: Array.from({ length: 20 }, (_, index) => `片${index}`), delayMs: 20 }
      : { chunks: ["答案"] },
  );
  let control: RunControl | undefined;
  const args = makeArgs({ mode: "pipeline", participants: [slow, fast] });
  args.onControl = (handle) => {
    control = handle;
  };
  const events: RunEvent[] = [];
  const orchestrating = orchestrate(args, deps, (event) => events.push(event));
  await new Promise((resolve) => setTimeout(resolve, 40));
  // p1 还在跑（pipeline 串行），p2 还没轮到，提前停它
  assert.equal(control?.stopParticipant("p2"), true);
  await orchestrating;

  const stopped = narrow(events, "model.stopped");
  assert.ok(stopped.some((event) => event.participantId === "p2"));
  assert.equal(calls.filter((call) => call.model.includes("p2")).length, 0, "被停的模型不应产生调用");
});
