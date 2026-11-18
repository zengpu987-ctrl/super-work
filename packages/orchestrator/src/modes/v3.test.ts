import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Artifact,
  CoordinationAssignment,
  CustomRoleDef,
  Participant,
  RunEvent,
} from "@super-work/core";
import { EFFORT_BY_ID } from "@super-work/core";
import { composeParallelAnswer } from "./parallel.js";
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

function specOf(participant: Participant) {
  return { provider: participant.provider, model: participant.model, role: participant.role };
}

function coordinationOf(role: string, ...participants: Participant[]): CoordinationAssignment {
  return { role, participants: participants.map(specOf) };
}

function callFor(calls: readonly FakeCall[], model: string): FakeCall | undefined {
  return calls.find((call) => call.model === model);
}

const customAudit: CustomRoleDef = {
  id: "custom_audit",
  name: "安全审计",
  description: "检查安全漏洞与合规风险，并给出可执行的整改建议",
  kind: "text",
  order: 100,
};

const customArt: CustomRoleDef = {
  id: "custom_art",
  name: "插图",
  description: "为最终内容生成配图",
  kind: "image",
  order: 101,
};

test("v3 自定义角色：text 类进 specialist，按 order 排序并并行执行", async () => {
  const reasoning = makeParticipant("r1");
  const auditor = makeParticipant("audit1");
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("安全审计")) return { chunks: ["审计结论"] };
    if (system.includes("强推理角色")) return { chunks: ["推理产出"] };
    return { error: `未识别角色：${call.model}` };
  });
  const args = makeArgs({
    mode: "coordinate",
    participants: [reasoning, auditor],
    coordination: [
      // 故意把自定义角色写在前面：执行顺序必须按 meta.order（reasoning 1 < custom 100）。
      coordinationOf("custom_audit", auditor),
      coordinationOf("reasoning", reasoning),
    ],
    options: { customRoles: [customAudit] },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.model, "mock-r1", "内置 reasoning 的 order 更小，先执行");
  assert.equal(calls[1]?.model, "mock-audit1");
  assert.ok(calls[1]?.system?.includes("安全审计"));
  assert.ok(calls[1]?.system?.includes("检查安全漏洞与合规风险"));

  const specialistStage = narrow(events, "stage").find((event) => event.stage === "specialist");
  assert.ok(specialistStage?.label.includes("安全审计"), "事件 label 使用角色名");
  assert.ok(specialistStage?.label.includes("强推理"));
  assert.deepEqual(stageIds(events), ["specialist"]);
  assert.ok(result.finalText.includes("审计结论"));
  assert.ok(result.finalText.includes("推理产出"));
});

test("v3 自定义角色：image 类走 generateImage 并 emit artifact(kind=image)", async () => {
  const illustrator = makeParticipant("art1", { provider: "mock", model: "hunyuan-image-alpha" });
  const { deps, calls, imageCalls } = createFakeDeps(
    () => ({ error: "image 角色不应调用 chat" }),
    () => ({ images: [{ url: "https://cdn.example.com/art.png" }], credit: 2 }),
  );
  const args = makeArgs({
    mode: "coordinate",
    participants: [illustrator],
    coordination: [coordinationOf("custom_art", illustrator)],
    options: { customRoles: [customArt] },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 0, "自定义 image 角色不调用 chat");
  assert.equal(imageCalls.length, 1);
  const images = artifacts(events).filter((artifact) => artifact.kind === "image");
  assert.equal(images.length, 1);
  assert.ok(images[0]?.title.includes("插图"));
  assert.equal(images[0]?.meta?.url, "https://cdn.example.com/art.png");

  const start = narrow(events, "model.start").find((event) => event.participantId === "art1");
  assert.equal(start?.label, "插图");
  assert.ok(result.finalText.includes("已生成 1 张图片"));
});

test("v3 未知角色：run.error「存在未知角色」且 0 次调用", async () => {
  const participant = makeParticipant("ghost1");
  const { deps, calls } = createFakeDeps(() => ({ chunks: ["不应调用"] }));
  const { result, events } = await runOrchestrator(
    makeArgs({
      mode: "coordinate",
      participants: [participant],
      coordination: [coordinationOf("custom_ghost", participant)],
    }),
    deps,
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(stageIds(events), []);
  assert.equal(result.finalText, "");
  const errors = narrow(events, "run.error");
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.message.includes("存在未知角色"));
  assert.ok(errors[0]?.message.includes("custom_ghost"));
  assert.equal(events.at(-1)?.type, "run.error");
});

test("v3 附件上下文：注入 commander/specialist，不注入 judge；context reference 计入 token", async () => {
  const commander = makeParticipant("cmd1");
  const reasoning = makeParticipant("r1");
  const judge = makeParticipant("judge1");
  const attachmentsContext = "## 用户上传的附件内容\n### 附件：spec.md\n项目必须支持离线运行。";
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("发令官（指挥官）")) return { chunks: ["执行简报"] };
    if (system.includes("强推理角色")) return { chunks: ["推理结论"] };
    if (system.includes("你是裁判")) return { chunks: ["最终结论"] };
    return { error: `未识别：${call.model}` };
  });
  const args = makeArgs({
    mode: "coordinate",
    participants: [commander, reasoning, judge],
    coordination: [
      coordinationOf("commander", commander),
      coordinationOf("reasoning", reasoning),
      coordinationOf("judge", judge),
    ],
    options: { attachmentsContext },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.ok(calls[0]?.system?.includes("项目必须支持离线运行"), "发令官 system 注入附件");
  assert.ok(calls[1]?.system?.includes("项目必须支持离线运行"), "specialist system 注入附件");
  assert.ok(!calls[2]?.system?.includes("项目必须支持离线运行"), "裁判 system 不注入附件");
  assert.equal(result.finalText, "最终结论");

  const contexts = narrow(events, "context");
  const contextOf = (participantId: string) =>
    contexts.find((event) => event.participantId === participantId)?.insight;
  const referenceTokens = (participantId: string) =>
    contextOf(participantId)?.sections.find((section) => section.name === "reference")?.tokens ?? 0;
  assert.ok(referenceTokens("cmd1") > 0, "发令官 context 的 reference 段计入附件");
  assert.ok(referenceTokens("r1") > 0);
  assert.equal(referenceTokens("judge1"), 0, "裁判 context reference 为 0");
  for (const context of contexts) {
    const sum = context.insight.sections.reduce((total, section) => total + section.tokens, 0);
    assert.equal(sum, context.insight.promptTokens);
  }
});

test("v3 预算守卫：累计 token 超限后停止剩余调用、发 notice(error) 并正常收尾", async () => {
  const p1 = makeParticipant("b1");
  const p2 = makeParticipant("b2");
  const p3 = makeParticipant("b3");
  const p4 = makeParticipant("b4");
  const { deps, calls } = createFakeDeps((call) => ({
    chunks: [`答案-${call.model}`],
    usage: { totalTokens: 60 },
  }));
  const args = makeArgs({
    mode: "parallel",
    participants: [p1, p2, p3, p4],
    options: { concurrency: 1, budgetLimitTokens: 100 },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.equal(calls.length, 2, "第 2 次调用后累计 120 > 100，剩余 2 次不再调用");
  assert.equal(narrow(events, "model.start").length, 2);
  const errorNotices = narrow(events, "notice").filter((notice) => notice.level === "error");
  assert.equal(errorNotices.length, 1);
  assert.equal(errorNotices[0]?.message, "本次运行已超出预算上限，已停止剩余调用");

  assert.equal(
    result.finalText,
    composeParallelAnswer([
      { participant: p1, text: "答案-mock-b1" },
      { participant: p2, text: "答案-mock-b2" },
    ]),
    "已产出内容正常收尾",
  );
  assert.equal(narrow(events, "run.done").length, 1);
  assert.equal(result.usage.totalTokens, 120);
  assert.deepEqual(deltaMismatches(events), []);
  assert.equal(finalDeltaMismatch(events), undefined);
});

test("v3 maxTokens 夹紧：perCallMaxTokens / performance.defaultMaxTokens / 模型输出上限", async () => {
  // 1) 单次调用上限
  {
    const solo = makeParticipant("cap1", { effort: "ultra" });
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({ mode: "parallel", participants: [solo], options: { perCallMaxTokens: 3000 } }),
      deps,
    );
    assert.equal(calls[0]?.effort, "ultra");
    assert.equal(calls[0]?.maxTokens, 3000, "档位 12288 被 perCallMaxTokens 夹到 3000");
  }

  // 2) 性能默认上限优先取更小值
  {
    const solo = makeParticipant("cap2", { effort: "ultra" });
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({
        mode: "parallel",
        participants: [solo],
        options: { perCallMaxTokens: 9000, performance: { defaultMaxTokens: 2500 } },
      }),
      deps,
    );
    assert.equal(calls[0]?.maxTokens, 2500);
  }

  // 3) 模型自身 maxOutputTokens（claude-haiku-4-5 = 16000）兜底：
  //    ultra × options.maxTokens 20000 = 60000，被模型上限夹到 16000。
  {
    const solo = makeParticipant("cap3", { provider: "anthropic", model: "claude-haiku-4-5", effort: "ultra" });
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({ mode: "parallel", participants: [solo], options: { maxTokens: 20000 } }),
      deps,
    );
    assert.equal(calls[0]?.maxTokens, 16000);
  }
});

test("v3 cheapMode：默认档位 low，并关闭互评轮", async () => {
  // 1) 未显式指定档位 → low
  {
    const solo = makeParticipant("cheap1");
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(makeArgs({ mode: "parallel", participants: [solo], options: { cheapMode: true } }), deps);
    assert.equal(calls[0]?.effort, "low");
    assert.equal(calls[0]?.reasoning, "low");
    assert.equal(calls[0]?.maxTokens, 2048);
    assert.equal(calls[0]?.temperature, EFFORT_BY_ID.low.temperature);
    assert.ok(calls[0]?.system?.includes("Low："));
  }

  // 2) server/web 预填的默认 medium 也降到 low；显式选择非默认档位保持
  {
    const prefilled = makeParticipant("cheap2", { effort: "medium" });
    const chosen = makeParticipant("cheap3", { effort: "max" });
    const { deps, calls } = createFakeDeps(() => ({ chunks: ["好"] }));
    await runOrchestrator(
      makeArgs({ mode: "parallel", participants: [prefilled, chosen], options: { cheapMode: true } }),
      deps,
    );
    assert.equal(calls[0]?.effort, "low", "默认 medium 被省钱模式降到 low");
    assert.equal(calls[1]?.effort, "max", "用户显式的 max 不受影响");
  }

  // 3) council 关闭互评（不再有 critique 阶段）
  {
    const a = makeParticipant("cheapA");
    const b = makeParticipant("cheapB");
    const { deps, calls } = createFakeDeps((call) => {
      if ((call.system ?? "").includes("综合裁决")) return { chunks: ["终稿"] };
      return { chunks: ["独立答案"] };
    });
    const { events } = await runOrchestrator(
      makeArgs({ mode: "council", participants: [a, b], options: { cheapMode: true } }),
      deps,
    );
    assert.deepEqual(stageIds(events), ["fanout", "synthesis"]);
    assert.equal(calls.length, 3, "2 次作答 + 1 次综合，没有互评");
  }
});

test("v3 cheapMode：参考材料按每人 2000 字截断", async () => {
  const longAnswer = `${"长".repeat(2500)}标记ABC`;
  const handler = (call: FakeCall) => {
    if ((call.system ?? "").includes("综合裁决")) return { chunks: ["终稿"] };
    return { chunks: [longAnswer] };
  };

  // 普通模式：默认 4000 字/人，2505 字不会被截断
  {
    const a = makeParticipant("truncA");
    const b = makeParticipant("truncB");
    const { deps, calls } = createFakeDeps(handler);
    await runOrchestrator(makeArgs({ mode: "council", participants: [a, b] }), deps);
    const synthesis = calls.find((call) => (call.system ?? "").includes("综合裁决"));
    assert.ok(synthesis?.system?.includes("标记ABC"), "普通模式保留完整材料");
  }

  // 省钱模式：2000 字/人，尾部标记被截掉
  {
    const a = makeParticipant("truncC");
    const b = makeParticipant("truncD");
    const { deps, calls } = createFakeDeps(handler);
    await runOrchestrator(
      makeArgs({ mode: "council", participants: [a, b], options: { cheapMode: true } }),
      deps,
    );
    const synthesis = calls.find((call) => (call.system ?? "").includes("综合裁决"));
    assert.ok(!synthesis?.system?.includes("标记ABC"), "尾部标记被 2000 字截断");
    assert.ok(synthesis?.system?.includes("已截断"));
  }
});

test("v3 附件上下文：parallel 非裁判参与者注入，裁判不注入且 reference token 为 0", async () => {
  const a = makeParticipant("parA");
  const b = makeParticipant("parB");
  const judge = makeParticipant("parJudge");
  const attachmentsContext = "## 用户上传的附件内容\n### 附件：brief.md\n并行模式也必须看到附件。";
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合最终答案")) return { chunks: ["最终答案"] };
    return { chunks: [`答案-${call.model}`] };
  });
  const args = makeArgs({
    mode: "parallel",
    participants: [a, b],
    judge,
    options: { attachmentsContext },
  });
  const { result, events } = await runOrchestrator(args, deps);

  assert.ok(calls[0]?.system?.includes("并行模式也必须看到附件"), "parallel 参与者 system 注入附件");
  assert.ok(calls[1]?.system?.includes("并行模式也必须看到附件"));
  const synthesisCall = calls.find((call) => call.model === "mock-parJudge");
  assert.ok(synthesisCall, "裁判综合发生");
  assert.ok(!synthesisCall?.system?.includes("并行模式也必须看到附件"), "裁判 system 不注入附件");
  assert.equal(result.finalText, "最终答案");

  const contexts = narrow(events, "context");
  const referenceOf = (participantId: string) =>
    contexts
      .filter((event) => event.participantId === participantId)
      .map(
        (event) =>
          event.insight.sections.find((section) => section.name === "reference")?.tokens ?? 0,
      );
  assert.ok(referenceOf("parA").every((tokens) => tokens > 0), "parallel 参与者 reference 段计入附件");
  assert.ok(referenceOf("parB").every((tokens) => tokens > 0));
  assert.ok(referenceOf("parJudge").every((tokens) => tokens === 0), "裁判 reference 段为 0");
  for (const context of contexts) {
    const sum = context.insight.sections.reduce((total, section) => total + section.tokens, 0);
    assert.equal(sum, context.insight.promptTokens);
  }
});

test("v3 附件上下文：council 作答与互评注入，裁判综合不注入", async () => {
  const a = makeParticipant("couA");
  const b = makeParticipant("couB");
  const judge = makeParticipant("couJudge");
  const attachmentsContext = "## 用户上传的附件内容\n### 附件：spec.md\n议会模式也必须看到附件。";
  const { deps, calls } = createFakeDeps((call) => {
    const system = call.system ?? "";
    if (system.includes("综合裁决")) return { chunks: ["最终答案"] };
    if (system.includes("互相补充与批判")) return { chunks: ["互评内容"] };
    return { chunks: ["独立答案"] };
  });
  const args = makeArgs({
    mode: "council",
    participants: [a, b],
    judge,
    options: { attachmentsContext },
  });
  const { result, events } = await runOrchestrator(args, deps);

  const participantCalls = calls.filter((call) => call.model === "mock-couA" || call.model === "mock-couB");
  assert.ok(participantCalls.length >= 4, "2 次作答 + 2 次互评");
  for (const call of participantCalls) {
    assert.ok(call.system?.includes("议会模式也必须看到附件"), `${call.model} 的 system 注入附件`);
  }
  const synthesisCall = calls.find((call) => call.model === "mock-couJudge");
  assert.ok(synthesisCall, "裁判综合发生");
  assert.ok(!synthesisCall?.system?.includes("议会模式也必须看到附件"), "裁判 system 不注入附件");
  assert.equal(result.finalText, "最终答案");

  const contexts = narrow(events, "context");
  const referenceOf = (participantId: string) =>
    contexts
      .filter((event) => event.participantId === participantId)
      .map(
        (event) =>
          event.insight.sections.find((section) => section.name === "reference")?.tokens ?? 0,
      );
  assert.ok(referenceOf("couA").every((tokens) => tokens > 0));
  assert.ok(referenceOf("couB").every((tokens) => tokens > 0));
  assert.ok(referenceOf("couJudge").every((tokens) => tokens === 0));
});
