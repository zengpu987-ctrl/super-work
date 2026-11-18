import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffortLevel, RunEvent } from "@super-work/core";
import { EFFORT_BY_ID } from "@super-work/core";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  runOrchestrator,
} from "./testkit.js";
import type { FakeCall } from "./testkit.js";

type ModelDone = Extract<RunEvent, { type: "model.done" }> & { effort?: EffortLevel };

function doneEvents(events: readonly RunEvent[]): ModelDone[] {
  return events.filter((event): event is ModelDone => event.type === "model.done");
}

function doneFor(events: readonly RunEvent[], participantId: string): ModelDone | undefined {
  return doneEvents(events).find((event) => event.participantId === participantId);
}

function callFor(calls: readonly FakeCall[], model: string): FakeCall | undefined {
  return calls.find((call) => call.model === model);
}

function effortHint(effort: EffortLevel): string {
  const meta = EFFORT_BY_ID[effort];
  return `## 强度档位\n${meta.name}：${meta.hint}`;
}

test("effort：low / ultra 映射到 reasoning / maxTokens / temperature 与 system 强度提示", async () => {
  const low = makeParticipant("low", { effort: "low" });
  const ultra = makeParticipant("ultra", { effort: "ultra" });
  const { deps, calls } = createFakeDeps((call) => ({ chunks: [`答案-${call.model}`] }));
  const args = makeArgs({ mode: "parallel", participants: [low, ultra] });
  const { result } = await runOrchestrator(args, deps);

  const lowCall = callFor(calls, "mock-low");
  assert.equal(lowCall?.effort, "low", "callModel 请求携带本次档位");
  assert.equal(lowCall?.reasoning, "low");
  assert.equal(lowCall?.maxTokens, 2048, "4096 × low 倍率 0.5");
  assert.equal(lowCall?.temperature, EFFORT_BY_ID.low.temperature);
  assert.ok(lowCall?.system?.includes(effortHint("low")), "system 末尾追加强度档位说明");
  assert.ok(lowCall?.system?.endsWith(effortHint("low")));

  const ultraCall = callFor(calls, "mock-ultra");
  assert.equal(ultraCall?.effort, "ultra");
  assert.equal(ultraCall?.reasoning, "high");
  assert.equal(ultraCall?.maxTokens, 12288, "4096 × ultra 倍率 3");
  assert.equal(ultraCall?.temperature, EFFORT_BY_ID.ultra.temperature);
  assert.ok(ultraCall?.system?.includes(effortHint("ultra")));
  assert.ok(!ultraCall?.system?.includes(effortHint("low")));

  assert.equal(result.results.find((item) => item.participantId === "low")?.effort, "low");
  assert.equal(result.results.find((item) => item.participantId === "ultra")?.effort, "ultra");
});

test("effort：options.defaultEffort 兜底、缺省 medium、options.maxTokens 作为倍率基数", async () => {
  // 1) 参与者未指定 → 用 options.defaultEffort
  {
    const solo = makeParticipant("def");
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({ mode: "parallel", participants: [solo], options: { defaultEffort: "ultra" } }),
      deps,
    );
    assert.equal(calls[0]?.effort, "ultra");
    assert.equal(calls[0]?.reasoning, "high");
    assert.equal(calls[0]?.maxTokens, 12288);
    assert.ok(calls[0]?.system?.includes(effortHint("ultra")));
  }

  // 2) 都没配置 → medium
  {
    const solo = makeParticipant("solo");
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(makeArgs({ mode: "parallel", participants: [solo] }), deps);
    assert.equal(calls[0]?.effort, "medium");
    assert.equal(calls[0]?.reasoning, "medium");
    assert.equal(calls[0]?.maxTokens, 4096);
    assert.equal(calls[0]?.temperature, EFFORT_BY_ID.medium.temperature);
    assert.ok(calls[0]?.system?.includes(effortHint("medium")));
  }

  // 3) options.maxTokens 作为倍率基数：2000 × max(2) = 4000
  {
    const solo = makeParticipant("scaled", { effort: "max" });
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({ mode: "parallel", participants: [solo], options: { maxTokens: 2000 } }),
      deps,
    );
    assert.equal(calls[0]?.maxTokens, 4000);
    assert.equal(calls[0]?.reasoning, "high");
  }
});

test("effort：运行中修改同一 participant.effort → 下一次调用立即生效（不缓存）", async () => {
  const hot = makeParticipant("hot", { effort: "low" });
  const other = makeParticipant("other");
  let promoted = false;
  const { deps, calls } = createFakeDeps((call) => {
    // 模拟 server POST /api/runs/:id/effort：直接改运行态里的同一个 Participant 对象。
    if (!promoted && call.model === "mock-hot") {
      promoted = true;
      hot.effort = "ultra";
    }
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { chunks: ["最终答案"] };
    if (system.includes("互相补充与批判")) return { chunks: ["互评"] };
    return { chunks: ["独立答案"] };
  });
  const args = makeArgs({ mode: "council", participants: [hot, other] });
  const { result } = await runOrchestrator(args, deps);

  const hotCalls = calls.filter((call) => call.model === "mock-hot");
  assert.equal(hotCalls.length, 3, "作答 → 互评 → 综合都由同一参与者完成");
  assert.equal(hotCalls[0]?.effort, "low", "第一次调用仍是 Low");
  assert.equal(hotCalls[0]?.reasoning, "low", "第一次调用仍是 Low");
  assert.equal(hotCalls[0]?.maxTokens, 2048);
  assert.ok(hotCalls[0]?.system?.includes(effortHint("low")));

  for (const later of hotCalls.slice(1)) {
    assert.equal(later.effort, "ultra", "改档后下一次调用拿到 Ultra");
    assert.equal(later.reasoning, "high", "改档后下一次调用拿到 High");
    assert.equal(later.maxTokens, 12288);
    assert.equal(later.temperature, EFFORT_BY_ID.ultra.temperature);
    assert.ok(later.system?.includes(effortHint("ultra")));
  }

  assert.equal(
    result.results.find((item) => item.participantId === "hot")?.effort,
    "ultra",
    "results 记录最近一次生效档位",
  );
});

test("effort：ParticipantResult.effort 与 model.done 都带生效档位", async () => {
  const low = makeParticipant("p1", { effort: "low" });
  const ultra = makeParticipant("p2", { effort: "ultra" });
  const { deps } = createFakeDeps((call) => ({ chunks: [`答案-${call.model}`] }));
  const { result, events } = await runOrchestrator(
    makeArgs({ mode: "parallel", participants: [low, ultra] }),
    deps,
  );

  assert.equal(result.results.find((item) => item.participantId === "p1")?.effort, "low");
  assert.equal(result.results.find((item) => item.participantId === "p2")?.effort, "ultra");
  assert.equal(doneFor(events, "p1")?.effort, "low");
  assert.equal(doneFor(events, "p2")?.effort, "ultra");

  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);
});

test("effort：image 角色不传 effort 给 generateImage，但 result / model.done 记录档位", async () => {
  const imageParticipant = makeParticipant("img1", { provider: "mock", model: "hunyuan-image-alpha", effort: "max" });
  const { deps, imageCalls } = createFakeDeps(
    () => ({ error: "image 角色不应调用 chat" }),
    () => ({ images: [{ url: "https://cdn.example.com/a.png" }], credit: 1 }),
  );
  const { result, events } = await runOrchestrator(
    makeArgs({
      mode: "coordinate",
      participants: [imageParticipant],
      coordination: [{ role: "image", participants: [{ provider: "mock", model: "hunyuan-image-alpha" }] }],
    }),
    deps,
  );

  assert.equal(imageCalls.length, 1);
  assert.ok(!("effort" in imageCalls[0]!), "ImageCallOptions 没有 effort，不应传");
  assert.equal(result.results.find((item) => item.participantId === "img1")?.effort, "max");
  assert.equal(doneFor(events, "img1")?.effort, "max");
});
