import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { createFakeDeps, makeArgs, makeParticipant, runOrchestrator } from "./testkit.js";

const p1 = makeParticipant("p1");

test("多轮对话：前几轮以 user/assistant 消息注入，并计入 history 上下文段", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["本轮答案"] }));
  const args = makeArgs({
    mode: "parallel",
    participants: [p1],
    options: {
      conversation: [
        { runId: "run-1", round: 1, command: "第一轮的问题", finalText: "第一轮的最终答案", at: 1_000 },
        { runId: "run-2", round: 2, command: "第二轮的问题", finalText: "第二轮的最终答案", at: 2_000 },
      ],
    },
  });
  const { events } = await runOrchestrator(args, deps);

  const first = calls[0];
  assert.ok(first, "至少有一次模型调用");
  // 2 轮历史 = 4 条消息 + 本轮 user 消息
  assert.equal(first.messages.length, 5);
  assert.deepEqual(first.messages[0], { role: "user", content: "第一轮的问题" });
  assert.deepEqual(first.messages[1], { role: "assistant", content: "第一轮的最终答案" });
  assert.deepEqual(first.messages[2], { role: "user", content: "第二轮的问题" });
  assert.deepEqual(first.messages[3], { role: "assistant", content: "第二轮的最终答案" });
  assert.equal(first.messages[4]?.role, "user");

  const context = events.find(
    (event): event is Extract<RunEvent, { type: "context" }> => event.type === "context",
  );
  assert.ok(context, "应发出上下文洞察事件");
  const history = context.insight.sections.find((section) => section.name === "history");
  assert.ok(history && history.tokens > 0, "history 段应计入前面几轮");
});

test("多轮对话：没有历史时不额外注入消息", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["答案"] }));
  const args = makeArgs({ mode: "parallel", participants: [p1] });
  const { events } = await runOrchestrator(args, deps);

  assert.equal(calls[0]?.messages.length, 1);
  const context = events.find(
    (event): event is Extract<RunEvent, { type: "context" }> => event.type === "context",
  );
  const history = context?.insight.sections.find((section) => section.name === "history");
  assert.equal(history?.tokens, 0);
});
