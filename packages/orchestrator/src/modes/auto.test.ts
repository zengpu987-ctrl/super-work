import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent } from "@super-work/core";
import { extractJsonObject, parsePlan } from "./auto.js";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  runOrchestrator,
  stageIds,
} from "./testkit.js";

const p1 = makeParticipant("p1", { role: "需求分析师" });
const p2 = makeParticipant("p2", { role: "工程师" });
const p3 = makeParticipant("p3", { role: "风险评审" });
const planner = makeParticipant("j1", { role: "调度者" });

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function planText(tasks: unknown[]): string {
  return ["好的，计划如下：", "```json", JSON.stringify({ subtasks: tasks }, null, 2), "```", "开始执行。"].join(
    "\n",
  );
}

const defaultTasks = [
  { title: "拆解", assignee: "p1", instruction: "拆解用户需求，列出验收标准" },
  { title: "实现", assignee: "p2", instruction: "实现核心功能", dependsOn: ["拆解"] },
  { title: "校验", assignee: "p3", instruction: "检查风险与遗漏" },
];

function autoHandler(tasks: unknown[]) {
  return (call: { system?: string }) => {
    const system = call.system ?? "";
    if (system.includes("任务规划")) return { chunks: [planText(tasks)] };
    if (system.includes("汇总裁决")) return { chunks: ["最终汇总"] };
    const title = /你负责的子任务：(.+)/.exec(system)?.[1]?.trim() ?? "未知";
    return { chunks: [`产出-${title}`] };
  };
}

test("auto：规划 → 依赖分波执行 → 汇总", async () => {
  const { deps, calls } = createFakeDeps(autoHandler(defaultTasks));
  const args = makeArgs({ mode: "auto", participants: [p1, p2, p3], judge: planner });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["plan", "handoff", "handoff", "handoff", "synthesis"]);
  assert.equal(calls.length, 5, "1 次规划 + 3 个子任务 + 1 次汇总");
  assert.equal(result.finalText, "最终汇总");
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);

  // 汇总裁决同步流式：final.delta 就是裁决的 text 块
  assert.deepEqual(
    narrow(events, "final.delta").map((event) => event.text),
    ["最终汇总"],
  );

  const planCall = calls[0];
  assert.ok(planCall?.system?.includes("任务规划"));
  assert.ok(planCall?.system?.includes("participantId: p1"));
  assert.ok(planCall?.system?.includes("participantId: p2"));
  assert.ok(planCall?.system?.includes("participantId: p3"));

  // 无依赖的「拆解」「校验」先并行；「实现」等「拆解」完成后再跑
  assert.ok(calls[1]?.system?.includes("拆解"));
  assert.equal(calls[1]?.model, "mock-p1");
  assert.ok(calls[2]?.system?.includes("校验"));
  assert.equal(calls[2]?.model, "mock-p3");
  assert.ok(calls[3]?.system?.includes("实现"));
  assert.equal(calls[3]?.model, "mock-p2");
  assert.ok(calls[3]?.messages[0]?.content.includes("产出-拆解"), "依赖产物注入执行者输入");

  // 汇总拿到所有子任务产出
  const synthesisCall = calls[4];
  assert.ok(synthesisCall?.system?.includes("产出-拆解"));
  assert.ok(synthesisCall?.system?.includes("产出-实现"));
  assert.ok(synthesisCall?.system?.includes("产出-校验"));

  const labels = narrow(events, "stage").map((event) => event.label);
  assert.ok(labels.some((label) => label.includes("子任务 1/3：拆解")));
  assert.ok(labels.some((label) => label.includes("子任务 2/3：实现")));
});

test("auto：assignee 非法 → notice 并顺序分派", async () => {
  const tasks = [
    { title: "拆解", assignee: "ghost-model", instruction: "拆解需求" },
    { title: "实现", assignee: "p2", instruction: "实现功能" },
  ];
  const { deps, calls } = createFakeDeps(autoHandler(tasks));
  const args = makeArgs({ mode: "auto", participants: [p1, p2], judge: planner });
  const { result, events } = await runOrchestrator(args, deps);

  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.message.includes("不在参与者列表中")));
  assert.equal(calls.length, 4, "1 规划 + 2 子任务 + 1 汇总");
  // 顺序分派：第一个子任务交给 participants[0]
  assert.equal(calls[1]?.model, "mock-p1");
  assert.equal(result.finalText, "最终汇总");
  assert.deepEqual(deltaMismatches(events), []);
});

test("auto：dependsOn 无法识别时忽略依赖并继续", async () => {
  const tasks = [
    { title: "拆解", assignee: "p1", instruction: "拆解需求" },
    { title: "实现", assignee: "p2", instruction: "实现功能", dependsOn: ["不存在的任务"] },
  ];
  const { deps, calls } = createFakeDeps(autoHandler(tasks));
  const args = makeArgs({ mode: "auto", participants: [p1, p2], judge: planner });
  const { events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 4);
  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.message.includes("无法识别的依赖项")));
});

test("auto：计划不可解析 → notice 并降级为 council 行为", async () => {
  const { deps, calls } = createFakeDeps((call, index) => {
    const system = call.system ?? "";
    if (system.includes("任务规划")) return { chunks: ["我觉得不用拆，直接聊吧。"] };
    if (system.includes("综合裁决")) return { chunks: ["议会最终答案"] };
    if (system.includes("互相补充与批判")) return { chunks: [`互评-${index}`] };
    if (system.includes("并行作答")) return { chunks: [`独立-${index}`] };
    return { chunks: [`兜底-${index}`] };
  });
  const args = makeArgs({ mode: "auto", participants: [p1, p2], judge: planner });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["plan", "fanout", "critique", "synthesis"], "降级为议会阶段");
  assert.equal(result.finalText, "议会最终答案");
  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.message.includes("降级为议会模式")));
  assert.deepEqual(deltaMismatches(events), []);
});

test("extractJsonObject / parsePlan：兼容代码块、裸 JSON 与散文包裹", () => {
  const fenced = "前言\n```json\n{\"subtasks\":[]}\n```\n后记";
  assert.deepEqual(extractJsonObject(fenced), { subtasks: [] });

  const raw = "{\"subtasks\":[]}";
  assert.deepEqual(extractJsonObject(raw), { subtasks: [] });

  const prose = "计划是：{\"subtasks\":[{\"title\":\"a\"}]} 以上。";
  assert.deepEqual(extractJsonObject(prose), { subtasks: [{ title: "a" }] });

  assert.equal(extractJsonObject("完全没有 JSON 的一段话"), undefined);

  const parsed = parsePlan(
    planText([
      { title: "拆解", assignee: "p2", instruction: "拆" },
      { title: "实现", assignee: "p1", instruction: "做", dependsOn: ["拆解"] },
    ]),
    [p1, p2],
  );
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.subtasks.length, 2);
  assert.equal(parsed.subtasks[0]?.assignee.id, "p2");
  assert.deepEqual(parsed.subtasks[1]?.dependsOn, [0]);

  const bad = parsePlan("没有 JSON", [p1]);
  assert.ok(bad.error);
  assert.equal(bad.subtasks.length, 0);
});
