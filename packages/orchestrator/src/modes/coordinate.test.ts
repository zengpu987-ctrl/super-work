import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Artifact,
  CoordinationAssignment,
  CoordRole,
  Participant,
  RunEvent,
} from "@super-work/core";
import {
  createFakeDeps,
  deltaMismatches,
  finalDeltaMismatch,
  makeArgs,
  makeParticipant,
  runOrchestrator,
  stageIds,
} from "./testkit.js";
import type { FakeCall } from "./testkit.js";

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

function artifacts(events: readonly RunEvent[]): Artifact[] {
  return narrow(events, "artifact").map((event) => event.artifact);
}

function coordinationOf(role: CoordRole, ...participants: Participant[]): CoordinationAssignment {
  return {
    role,
    participants: participants.map((participant) => ({
      provider: participant.provider,
      model: participant.model,
      role: participant.role,
    })),
  };
}

/** 按各角色 system prompt 里的标志串返回固定产出。 */
function roleHandler(call: FakeCall) {
  const system = call.system ?? "";
  if (system.includes("发令官（指挥官）")) return { chunks: [`简报：${call.model}`] };
  if (system.includes("强推理角色")) return { chunks: ["推理产出"] };
  if (system.includes("代码实现角色")) return { chunks: ["代码产出"] };
  if (system.includes("建模角色")) {
    return { chunks: ["```html\n<!DOCTYPE html>\n<html><body><canvas id=\"c\"></canvas></body></html>\n```"] };
  }
  if (system.includes("Chat 角色")) return { chunks: ["聊天收尾"] };
  if (system.includes("整合优化角色")) {
    return { chunks: [system.includes("## 上一棒整合稿") ? "整合二稿" : "整合一稿"] };
  }
  if (system.includes("你是裁判")) {
    return { chunks: [call.model === "mock-j2" ? "最终裁决j2" : "初裁j1"] };
  }
  return { error: `未识别的角色调用：${call.model}` };
}

const c1 = makeParticipant("c1");
const r1 = makeParticipant("r1");
const co1 = makeParticipant("co1");
const m1 = makeParticipant("m1");
const ch1 = makeParticipant("ch1");
const i1 = makeParticipant("i1");
const i2 = makeParticipant("i2");
const j1 = makeParticipant("j1");
const j2 = makeParticipant("j2");

test("coordinate：command → specialist → integrate → judge，最终答案 = 最后一个裁判", async () => {
  const { deps, calls } = createFakeDeps(roleHandler);
  const args = makeArgs({
    mode: "coordinate",
    participants: [c1, r1, co1, m1, ch1, i1, i2, j1, j2],
    coordination: [
      coordinationOf("commander", c1),
      coordinationOf("reasoning", r1),
      coordinationOf("coding", co1),
      coordinationOf("model3d", m1),
      coordinationOf("chat", ch1),
      coordinationOf("integrator", i1, i2),
      coordinationOf("judge", j1, j2),
    ],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["command", "specialist", "integrate", "judge"]);
  assert.deepEqual(
    calls.map((call) => call.model),
    ["mock-c1", "mock-r1", "mock-co1", "mock-m1", "mock-ch1", "mock-i1", "mock-i2", "mock-j1", "mock-j2"],
    "发令官 → 执行角色并行 → 整合顺序接力 → 裁判顺序裁决",
  );
  assert.equal(result.finalText, "最终裁决j2");
  assert.equal(finalDeltaMismatch(events), undefined);
  assert.deepEqual(deltaMismatches(events), []);
  // 只有最后一位裁判流式同步 final.delta
  assert.deepEqual(
    narrow(events, "final.delta").map((event) => event.text),
    ["最终裁决j2"],
  );

  // 整合顺序接力：后一位看到前一位草稿 + 全部 specialist 产出
  const firstIntegrator = calls[5];
  assert.ok(firstIntegrator?.system?.includes("推理产出"));
  assert.ok(firstIntegrator?.system?.includes("代码产出"));
  assert.ok(firstIntegrator?.system?.includes("聊天收尾"));
  assert.ok(!firstIntegrator?.system?.includes("## 上一棒整合稿"));
  const secondIntegrator = calls[6];
  assert.ok(secondIntegrator?.system?.includes("## 上一棒整合稿"));
  assert.ok(secondIntegrator?.system?.includes("整合一稿"));

  // 裁判顺序裁决：后一位看到前一位结论 + 整合稿
  assert.ok(calls[7]?.system?.includes("整合二稿"));
  assert.ok(calls[8]?.system?.includes("初裁j1"));
  assert.ok(calls[8]?.system?.includes("整合二稿"));
  assert.ok(calls[8]?.system?.includes("执行简报"));

  // 建模产出一个 code3d artifact
  const codeArtifacts = artifacts(events).filter((artifact) => artifact.kind === "code3d");
  assert.equal(codeArtifacts.length, 1);
  assert.ok(codeArtifacts[0]?.title.includes("建模"));
  assert.ok(codeArtifacts[0]?.title.includes("模型 m1"));
  assert.ok(codeArtifacts[0]?.text?.includes("<canvas"));
  assert.equal(codeArtifacts[0]?.mime, "text/html");

  // 每次 chat 调用前都有 context 事件
  events.forEach((event, index) => {
    if (event.type !== "model.start") return;
    assert.equal(events[index - 1]?.type, "context", "model.start 前必须紧邻 context");
  });
});

test("coordinate：只配 commander + judge 时其它角色 0 调用", async () => {
  const { deps, calls } = createFakeDeps(roleHandler);
  const args = makeArgs({
    mode: "coordinate",
    participants: [c1, r1, co1, m1, ch1, i1, j1],
    coordination: [coordinationOf("commander", c1), coordinationOf("judge", j1)],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["command", "judge"]);
  assert.equal(calls.length, 2, "只有发令官与裁判被调用");
  assert.deepEqual(calls.map((call) => call.model), ["mock-c1", "mock-j1"]);
  const untouched = new Set(["mock-r1", "mock-co1", "mock-m1", "mock-ch1", "mock-i1"]);
  for (const call of calls) assert.ok(!untouched.has(call.model), `${call.model} 未配置角色，不应调用`);
  assert.equal(result.finalText, "初裁j1");
});

test("coordinate：无 commander → notice(info) 并直接用原始命令驱动执行角色", async () => {
  const { deps, calls } = createFakeDeps(roleHandler);
  const args = makeArgs({
    mode: "coordinate",
    participants: [r1],
    coordination: [coordinationOf("reasoning", r1)],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["specialist"]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.system?.includes("请为我的团队写一份本周上线计划"), "原始命令直接进 system");
  assert.ok(!calls[0]?.system?.includes("## 执行简报"));
  assert.ok(result.finalText.includes("推理产出"));

  const notices = narrow(events, "notice");
  assert.ok(notices.some((notice) => notice.level === "info" && notice.message.includes("发令官")));
});

test("coordinate：无 integrator → 拼接 specialist 产出作为整合稿并 notice", async () => {
  const { deps, calls } = createFakeDeps(roleHandler);
  const args = makeArgs({
    mode: "coordinate",
    participants: [r1, j1],
    coordination: [coordinationOf("reasoning", r1), coordinationOf("judge", j1)],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["specialist", "judge"]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.system?.includes("推理产出"), "裁判看到 specialist 拼接稿");
  assert.equal(result.finalText, "初裁j1");
  assert.ok(narrow(events, "notice").some((notice) => notice.message.includes("整合优化")));
});

test("coordinate：无 judge → 最终答案 = 整合稿", async () => {
  const { deps, calls } = createFakeDeps(roleHandler);
  const args = makeArgs({
    mode: "coordinate",
    participants: [r1, i1],
    coordination: [coordinationOf("reasoning", r1), coordinationOf("integrator", i1)],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.deepEqual(stageIds(events), ["specialist", "integrate"]);
  assert.deepEqual(calls.map((call) => call.model), ["mock-r1", "mock-i1"]);
  assert.equal(result.finalText, "整合一稿");
  assert.ok(narrow(events, "notice").some((notice) => notice.message.includes("裁判")));
});

test("coordinate：image 走 generateImage 并 emit artifact(kind=image)", async () => {
  const imageParticipant = makeParticipant("img1", { provider: "mock", model: "hunyuan-image-alpha" });
  const { deps, calls, imageCalls } = createFakeDeps(
    () => ({ error: "image 角色不应调用 chat" }),
    () => ({
      images: [{ url: "https://cdn.example.com/a.png", mime: "image/png" }],
      credit: 3,
    }),
  );
  const args = makeArgs({
    mode: "coordinate",
    participants: [],
    coordination: [coordinationOf("image", imageParticipant)],
    options: { imageSize: "1024x1024", memoryContext: "用户偏好蓝色。" },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 0, "image 角色不调用 chat");
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0]?.model, "hunyuan-image-alpha");
  assert.equal(imageCalls[0]?.size, "1024x1024");
  assert.ok(imageCalls[0]?.prompt.includes("请为我的团队写一份本周上线计划"));

  const imageArtifacts = artifacts(events).filter((artifact) => artifact.kind === "image");
  assert.equal(imageArtifacts.length, 1);
  assert.equal(imageArtifacts[0]?.meta?.url, "https://cdn.example.com/a.png");
  assert.equal(imageArtifacts[0]?.meta?.credit, 3);
  assert.ok(imageArtifacts[0]?.title.includes("生图"));

  assert.ok(result.finalText.includes("已生成 1 张图片"));
  assert.equal(narrow(events, "run.done").length, 1);
  assert.ok(narrow(events, "model.start").some((event) => event.label === "生图"));

  // 生图调用前也发 context（command + memory）
  const startIndex = events.findIndex(
    (event) => event.type === "model.start" && event.label === "生图",
  );
  const context = events[startIndex - 1];
  assert.equal(context?.type, "context");
  if (context?.type === "context") {
    const command = context.insight.sections.find((section) => section.name === "command");
    const memory = context.insight.sections.find((section) => section.name === "memory");
    assert.ok((command?.tokens ?? 0) > 0);
    assert.ok((memory?.tokens ?? 0) > 0);
    const sum = context.insight.sections.reduce((total, section) => total + section.tokens, 0);
    assert.equal(sum, context.insight.promptTokens);
  }
});

test("coordinate：生图失败只标该角色 model.error 并继续其它角色", async () => {
  const imageParticipant = makeParticipant("img1", { provider: "mock", model: "hunyuan-image-alpha" });
  const chatParticipant = makeParticipant("ch1");
  const { deps, calls } = createFakeDeps(
    (call) => {
      if ((call.system ?? "").includes("Chat 角色")) return { chunks: ["聊天收尾"] };
      return { error: `未识别：${call.model}` };
    },
    () => new Error("生图通道不可用"),
  );
  const args = makeArgs({
    mode: "coordinate",
    participants: [],
    coordination: [coordinationOf("image", imageParticipant), coordinationOf("chat", chatParticipant)],
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 1, "image 失败后 chat 照常执行");
  assert.equal(calls[0]?.model, "mock-ch1");
  assert.ok(result.finalText.includes("聊天收尾"));
  const errors = narrow(events, "model.error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.message.includes("生图通道不可用"));
  assert.equal(artifacts(events).length, 0);
  assert.equal(narrow(events, "run.done").length, 1);
});

test("coordinate：model3d 的 ```html 代码块提取为 code3d artifact", async () => {
  const { deps, imageCalls } = createFakeDeps(() => ({
    chunks: [
      "这是一个旋转立方体：\n```html\n<!DOCTYPE html>\n<html><body><canvas id=\"cube\"></canvas></body></html>\n```\n本地打开即可。",
    ],
  }));
  const args = makeArgs({
    mode: "coordinate",
    participants: [m1],
    coordination: [coordinationOf("model3d", m1)],
  });
  const { events } = await runOrchestrator(args, deps);

  assert.equal(imageCalls.length, 0);
  const codeArtifacts = artifacts(events).filter((artifact) => artifact.kind === "code3d");
  assert.equal(codeArtifacts.length, 1);
  assert.ok(codeArtifacts[0]?.text?.startsWith("<!DOCTYPE html>"));
  assert.ok(codeArtifacts[0]?.text?.includes("<canvas"));
  assert.equal(codeArtifacts[0]?.mime, "text/html");
  assert.ok(codeArtifacts[0]?.title.includes("建模"));
});

test("coordinate：model3d 找不到 html → notice(warn)；coding 的 js 块照常产出", async () => {
  const { deps } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("代码实现角色")) {
      return { chunks: ["代码如下：\n```js\nconsole.log('ok');\n```\n运行 node demo.js。"] };
    }
    if (system.includes("建模角色")) {
      return { chunks: ["抱歉，这次只能给文字说明，没有代码。"] };
    }
    return { error: `未识别：${call.model}` };
  });
  const args = makeArgs({
    mode: "coordinate",
    participants: [co1, m1],
    coordination: [coordinationOf("coding", co1), coordinationOf("model3d", m1)],
  });
  const { events } = await runOrchestrator(args, deps);

  const codeArtifacts = artifacts(events).filter((artifact) => artifact.kind === "code3d");
  assert.equal(codeArtifacts.length, 1, "只有 coding 的 js 块成为产物");
  assert.equal(codeArtifacts[0]?.text, "console.log('ok');");
  assert.equal(codeArtifacts[0]?.mime, "text/javascript");
  assert.ok(codeArtifacts[0]?.title.includes("代码实现"));

  const warns = narrow(events, "notice").filter((notice) => notice.level === "warn");
  assert.ok(warns.some((notice) => notice.message.includes("html") && notice.message.includes("建模")));
});

test("coordinate：coordination 为空或全空 → run.error「没有配置任何角色」，0 次调用", async () => {
  const cases: Array<CoordinationAssignment[] | undefined> = [
    undefined,
    [{ role: "reasoning", participants: [] }],
  ];
  for (const coordination of cases) {
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["不应调用"] }));
    const args = makeArgs({ mode: "coordinate", participants: [r1], coordination });
    const { result, events } = await runOrchestrator(args, deps);

    assert.equal(calls.length, 0);
    assert.equal(result.finalText, "");
    assert.deepEqual(stageIds(events), []);
    const errors = narrow(events, "run.error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, "没有配置任何角色");
    assert.equal(events.at(-1)?.type, "run.error");
  }
});

test("coordinate：context 事件逐次调用前都有，sections 求和 == promptTokens，记忆只注入发令官与执行角色", async () => {
  const commander = makeParticipant("c1", { provider: "mock", model: "mock-fast" });
  const reasoning = makeParticipant("r1");
  const judge = makeParticipant("j1");
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("发令官（指挥官）")) return { chunks: ["执行简报"] };
    if (system.includes("强推理角色")) return { chunks: ["推理结论"] };
    if (system.includes("你是裁判")) return { chunks: ["最终结论"] };
    return { error: `未识别：${call.model}` };
  });
  const memoryContext = "用户偏好 TypeScript。";
  const args = makeArgs({
    mode: "coordinate",
    participants: [commander, reasoning, judge],
    coordination: [
      coordinationOf("commander", commander),
      coordinationOf("reasoning", reasoning),
      coordinationOf("judge", judge),
    ],
    options: { memoryContext, memoryIds: ["mem-1"] },
  });
  const { result, events } = await runOrchestrator(args, deps);

  const starts = narrow(events, "model.start");
  const contexts = narrow(events, "context");
  assert.equal(starts.length, 3);
  assert.equal(contexts.length, 3, "每次 chat 调用一条 context");

  events.forEach((event, index) => {
    if (event.type !== "model.start") return;
    const previous = events[index - 1];
    assert.equal(previous?.type, "context", "context 必须紧邻在 model.start 之前");
    if (previous?.type === "context") {
      assert.equal(previous.participantId, event.participantId);
      assert.deepEqual(
        previous.insight.sections.map((section) => section.name),
        ["system", "command", "memory", "reference", "history"],
      );
      const sum = previous.insight.sections.reduce((total, section) => total + section.tokens, 0);
      assert.equal(sum, previous.insight.promptTokens, "sections 求和 == promptTokens");
      assert.ok(previous.insight.promptTokens > 0);
    }
  });
  assert.deepEqual(
    contexts.map((context) => context.insight.stage),
    ["command", "specialist", "judge"],
  );

  // contextWindow 从 core 模型目录取（mock-fast = 32000）
  const commanderContext = contexts[0];
  assert.equal(commanderContext?.insight.contextWindow, 32000);
  assert.ok((commanderContext?.insight.utilization ?? 1) <= 1);
  assert.ok((commanderContext?.insight.utilization ?? 0) > 0);
  assert.deepEqual(commanderContext?.insight.injectedMemoryIds, ["mem-1"]);
  const memoryTokens = (insight: (typeof contexts)[number]["insight"]) =>
    insight.sections.find((section) => section.name === "memory")?.tokens ?? 0;
  assert.ok(memoryTokens(commanderContext!.insight) > 0, "发令官上下文计入记忆段");

  // memoryContext 注入 commander 与 specialist 的 system，不注入 judge
  assert.ok(calls[0]?.system?.includes(memoryContext), "发令官 system 注入记忆");
  assert.ok(calls[1]?.system?.includes(memoryContext), "执行角色 system 注入记忆");
  assert.ok(!calls[2]?.system?.includes(memoryContext), "裁判 system 不注入记忆");
  assert.equal(memoryTokens(contexts[2]!.insight), 0, "裁判 context 的 memory 段为 0");

  assert.equal(result.finalText, "最终结论");
});
