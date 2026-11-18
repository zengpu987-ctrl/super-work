import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  findCall,
  findCalls,
  makeArgs,
  makeParticipant,
  runOrchestrator,
  stageIds,
} from "./testkit.js";

const architect = makeParticipant("p1", { role: "架构师" });
const security = makeParticipant("p2", { role: "安全工程师" });

const usage = { inputTokens: 10, outputTokens: 5 };

function councilHandler(call: { system?: string }, index: number) {
  const system = call.system ?? "";
  if (system.includes("综合裁决")) return { chunks: ["最终", "答案"], usage };
  if (system.includes("互相补充与批判")) return { chunks: [`互评-${index}`], usage };
  return { chunks: [`独立-${index}`], usage };
}

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

test("council：fanout → critique → synthesis，事件与文本一致", async () => {
  const { deps, calls } = createFakeDeps(councilHandler);
  const args = makeArgs({ mode: "council", participants: [architect, security] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(result.finalText, "最终答案");
  assert.deepEqual(stageIds(events), ["fanout", "critique", "synthesis"]);
  assert.equal(events[0]?.type, "run.start");
  assert.equal(events.at(-1)?.type, "run.done");
  assert.equal(calls.length, 5, "2 次作答 + 2 次互评 + 1 次综合");
  assert.equal(result.results.length, 2);

  // results.text 保留首次作答（先到先得），后续互评 / 综合不覆盖；stages 记录各阶段发言
  const p1Result = result.results.find((item) => item.participantId === "p1");
  const p2Result = result.results.find((item) => item.participantId === "p2");
  assert.equal(p1Result?.text, "独立-0", "p1.text = 首次独立作答");
  assert.equal(p1Result?.text.includes("互评"), false, "首次作答不被互评覆盖");
  assert.equal(p1Result?.stages?.find((stage) => stage.stage === "fanout")?.text, "独立-0");
  assert.match(p1Result?.stages?.find((stage) => stage.stage === "critique")?.text ?? "", /^互评-/);
  assert.equal(p1Result?.stages?.find((stage) => stage.stage === "synthesis")?.text, "最终答案");
  assert.deepEqual(
    p1Result?.stages?.map((stage) => stage.stage),
    ["fanout", "critique", "synthesis"],
  );
  assert.deepEqual(
    p2Result?.stages?.map((stage) => stage.stage),
    ["fanout", "critique"],
  );
  assert.equal(p2Result?.text, "独立-1");

  // 逐次调用的 delta 累加必须等于 done.text
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);

  // synthesis 的每个 text 块同步发 final.delta（"最终" + "答案" 两块，而不是收尾重切）
  const finalDeltas = narrow(events, "final.delta");
  assert.deepEqual(
    finalDeltas.map((event) => event.text),
    ["最终", "答案"],
  );
  for (const event of finalDeltas) {
    const previous = events[events.indexOf(event) - 1];
    assert.equal(previous?.type, "model.delta");
    if (previous?.type === "model.delta") {
      assert.equal(previous.participantId, "p1");
      assert.equal(previous.channel, "text");
      assert.equal(previous.text, event.text);
    }
  }

  const doneEvents = narrow(events, "model.done");
  assert.equal(doneEvents.length, 5);
  const synthesisDone = doneEvents.at(-1);
  assert.equal(synthesisDone?.text, "最终答案");
  assert.deepEqual(synthesisDone?.usage, usage);
  assert.ok((synthesisDone?.latencyMs ?? -1) >= 0);

  // 总 usage = 5 次调用之和
  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 25 });
  const finalEvent = narrow(events, "final")[0];
  assert.equal(finalEvent?.text, "最终答案");
  assert.deepEqual(finalEvent?.usage, { inputTokens: 50, outputTokens: 25 });
  const runDone = narrow(events, "run.done")[0];
  assert.deepEqual(runDone?.usage, { inputTokens: 50, outputTokens: 25 });

  // 事件序列：model.start 一定在 model.delta 之前，model.done 收尾
  const startIndex = events.findIndex((event) => event.type === "model.start");
  const firstDelta = events.findIndex((event) => event.type === "model.delta");
  assert.ok(startIndex >= 0 && startIndex < firstDelta);
});

test("council：参与者 system prompt 含角色 / 纪律 / 阶段 / 语言", async () => {
  const { deps, calls } = createFakeDeps(councilHandler);
  const args = makeArgs({ mode: "council", participants: [architect, security] });
  await runOrchestrator(args, deps);

  const fanoutCalls = calls.filter((call) => (call.system ?? "").includes("并行作答"));
  assert.equal(fanoutCalls.length, 2);

  for (const call of fanoutCalls) {
    const system = call.system ?? "";
    assert.ok(system.startsWith("你正在参加 Super Work"), "system 以联合工作身份开场");
    assert.ok(system.includes("## 你的角色"));
    assert.ok(system.includes("## 联合工作纪律"));
    assert.ok(system.includes("只回答用户的命令"), "纪律：只回答命令");
    assert.ok(system.includes("不要复述"), "纪律：不复述提示词");
    assert.ok(system.includes("可执行"), "纪律：给可执行结论");
    assert.ok(system.includes("分歧"), "纪律：明确分歧");
    assert.ok(system.includes("## 当前阶段：并行作答"), "阶段任务说明");
    assert.ok(system.includes("## 输出语言"));
    assert.ok(system.includes("中文"), "默认输出语言=中文");
    assert.ok(system.includes("本周上线计划"), "包含用户命令");
  }

  const p1Call = fanoutCalls.find((call) => call.model === "mock-p1");
  const p2Call = fanoutCalls.find((call) => call.model === "mock-p2");
  assert.ok(p1Call?.system?.includes("架构师"));
  assert.ok(p2Call?.system?.includes("安全工程师"));

  // 互评：每个人都能看到其他人的答案
  const critiqueCalls = findCalls(calls, "互相补充与批判");
  assert.equal(critiqueCalls.length, 2);
  for (const call of critiqueCalls) {
    assert.match(call.system ?? "", /独立-\d/);
    assert.ok((call.system ?? "").includes("补充"));
    assert.ok((call.system ?? "").includes("反对"));
  }
});

test("council：critique=false 跳过互评", async () => {
  const { deps, calls } = createFakeDeps(councilHandler);
  const args = makeArgs({
    mode: "council",
    participants: [architect, security],
    options: { critique: false },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "synthesis"]);
  assert.equal(calls.length, 3);
  assert.equal(result.finalText, "最终答案");
  assert.deepEqual(deltaMismatches(events), []);
});

test("council：单人参与者不做互评，仍产出最终答案", async () => {
  const { deps, calls } = createFakeDeps(councilHandler);
  const args = makeArgs({ mode: "council", participants: [architect] });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["fanout", "synthesis"]);
  assert.equal(calls.length, 2);
  assert.equal(result.finalText, "最终答案");
  assert.equal(findCall(calls, "综合裁决")?.messages[0]?.content, "请为我的团队写一份本周上线计划");
});

test("council：language=en 时输出语言提示为英文", async () => {
  const { deps, calls } = createFakeDeps(councilHandler);
  const args = makeArgs({
    mode: "council",
    participants: [architect, security],
    options: { language: "en" },
  });
  await runOrchestrator(args, deps);

  const fanoutCall = findCall(calls, "并行作答");
  assert.ok(fanoutCall);
  const system = fanoutCall.system ?? "";
  assert.ok(system.includes("## Your role"));
  assert.ok(system.includes("架构师"), "角色仍然注入");
  assert.ok(system.includes("## Joint-work discipline"));
  assert.ok(system.includes("Output language"));
  assert.ok(system.includes("English"));
  assert.ok(system.includes("## Current stage: 并行作答"));
  assert.ok(system.includes("## User command"));
});

test("council：reasoning 与 text 分通道转发，reasoning 记入结果", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { chunks: ["最终答案"], reasoning: ["裁判思考"] };
    return { chunks: ["独立答案"], reasoning: ["参与者思考"] };
  });
  const args = makeArgs({ mode: "council", participants: [architect] });
  const { result, events } = await runOrchestrator(args, deps);

  const deltas = narrow(events, "model.delta");
  const reasoningDeltas = deltas.filter((delta) => delta.channel === "reasoning");
  const textDeltas = deltas.filter((delta) => delta.channel === "text");
  assert.ok(reasoningDeltas.some((delta) => delta.text.includes("参与者思考")));
  assert.ok(reasoningDeltas.some((delta) => delta.text.includes("裁判思考")));
  assert.equal(
    textDeltas.some((delta) => delta.text.includes("思考")),
    false,
    "reasoning 不得混进 text 通道",
  );
  assert.equal(result.finalText, "最终答案");
  const p1Result = result.results.find((item) => item.participantId === "p1");
  assert.equal(p1Result?.text, "独立答案", "text 保留首次作答");
  assert.equal(p1Result?.reasoning, "参与者思考", "reasoning 保留首个非空");
  assert.deepEqual(
    p1Result?.stages?.map((stage) => stage.stage),
    ["fanout", "synthesis"],
  );
  assert.deepEqual(deltaMismatches(events), []);
});

test("council：独立裁判的 stages 记录综合发言，参与者 text 仍是首次作答", async () => {
  const { deps } = createFakeDeps(councilHandler);
  const independentJudge = makeParticipant("j1", { role: "独立裁判" });
  const args = makeArgs({
    mode: "council",
    participants: [architect, security],
    judge: independentJudge,
  });
  const { result } = await runOrchestrator(args, deps);

  const p1Result = result.results.find((item) => item.participantId === "p1");
  assert.equal(p1Result?.text, "独立-0");
  assert.deepEqual(
    p1Result?.stages?.map((stage) => stage.stage),
    ["fanout", "critique"],
  );
  assert.equal(p1Result?.stages?.[0]?.text, "独立-0");
  assert.match(p1Result?.stages?.[1]?.text ?? "", /^互评-/);

  const judgeResult = result.results.find((item) => item.participantId === "j1");
  assert.equal(judgeResult?.text, "最终答案");
  assert.deepEqual(judgeResult?.stages, [{ stage: "synthesis", text: "最终答案" }]);
});

test("council：text 为空但 reasoning 非空 → notice(warn) 提示预算，reasoning 记入结果", async () => {
  const { deps, calls } = createFakeDeps(() => ({
    reasoning: ["我先想了很久，但预算用完了"],
    chunks: [],
  }));
  const args = makeArgs({
    mode: "council",
    participants: [architect],
    options: { maxTokens: 220 },
  });
  const { result, events } = await runOrchestrator(args, deps);

  // 默认强度 medium（倍率 1）经 applyEffortToMaxTokens 后下限 256，因此 220 → 256。
  assert.equal(calls[0]?.maxTokens, 256);
  const warnings = narrow(events, "notice").filter((notice) => notice.level === "warn");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.message.includes("模型 p1"), "notice 用模型展示名");
  assert.ok(warnings[0]?.message.includes("思考"));
  assert.ok(!(warnings[0]?.message ?? "").includes("mock-p1"), "不泄露 provider 内部字段");

  assert.equal(narrow(events, "model.done")[0]?.text, "");
  const record = result.results.find((item) => item.participantId === "p1");
  assert.equal(record?.reasoning, "我先想了很久，但预算用完了");
  assert.equal(record?.stages, undefined, "只有思考没有正文不产生空 stage");
  assert.equal(result.finalText, "");
  assert.equal(narrow(events, "run.error").length, 1);
});
