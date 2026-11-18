import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { createFakeDeps, makeArgs, makeParticipant, runOrchestrator, stageIds } from "./testkit.js";

const p1 = makeParticipant("p1", { role: "通用对话助手" });

test("chat：单模型直接对话，最终答案就是模型回复（不加模型标题）", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["你好，", "我是 Kimi。"] }));
  const args = makeArgs({ mode: "chat", participants: [p1] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["chat"]);
  assert.equal(calls.length, 1, "Chat 只调用一次模型");
  assert.equal(calls[0]?.messages.length, 1);
  assert.equal(result.finalText, "你好，我是 Kimi。");
  assert.ok(!result.finalText.includes("### 模型"), "Chat 不拼接模型标题");
  const deltas = events
    .filter((event): event is Extract<RunEvent, { type: "final.delta" }> => event.type === "final.delta")
    .map((event) => event.text)
    .join("");
  assert.equal(deltas, result.finalText);
});

test("chat：多轮历史以 user/assistant 消息注入，档位透传到调用", async () => {
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["第三轮回复"] }));
  const args = makeArgs({
    mode: "chat",
    participants: [p1],
    options: {
      conversation: [
        { runId: "r1", round: 1, command: "你好", finalText: "你好，有什么可以帮你？", at: 1 },
        { runId: "r2", round: 2, command: "写个函数", finalText: "function f() {}", at: 2 },
      ],
      defaultEffort: "max",
    },
  });
  const { result } = await runOrchestrator(args, deps);

  const call = calls[0];
  assert.ok(call);
  assert.equal(call.messages.length, 5, "两轮历史 4 条 + 本轮 1 条");
  assert.deepEqual(call.messages[0], { role: "user", content: "你好" });
  assert.deepEqual(call.messages[1], { role: "assistant", content: "你好，有什么可以帮你？" });
  assert.equal(call.effort, "max", "Chat 档位应透传给模型调用");
  assert.equal(result.finalText, "第三轮回复");
});
