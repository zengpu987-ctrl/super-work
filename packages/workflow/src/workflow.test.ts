/**
 * 工作流执行器测试（node:test）：
 * 顺序执行 / 并行组 / 失败继续 / previous·all 输入 / usage 汇总 / 取消 /
 * stepIds 过滤 / 组序（独占组 + 数字组升序）/ maxOutputChars / outputMode=json。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunEvent, Usage, WorkflowDef, WorkflowStep } from "@super-work/core";
import {
  DEFAULT_STEP_MAX_TOKENS,
  runWorkflow,
  type WorkflowCallRequest,
  type WorkflowDeps,
} from "./index.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Planned {
  chunks?: string[];
  reasoning?: string[];
  usage?: Usage;
  /** 在第 index 个正文块「产不出」：直接抛错（index >= chunks.length 时在末尾抛）。 */
  failAt?: number;
  errorMessage?: string;
  delayMs?: number;
  beforeChunk?: (index: number) => void;
}

interface FakeDeps {
  deps: WorkflowDeps;
  calls: WorkflowCallRequest[];
}

function fakeDeps(handler: (call: WorkflowCallRequest, index: number) => Planned | Promise<Planned>): FakeDeps {
  const calls: WorkflowCallRequest[] = [];
  const deps: WorkflowDeps = {
    callModel(request) {
      calls.push(request);
      const index = calls.length - 1;
      return (async function* generate() {
        const plan = await handler(request, index);
        if (plan.delayMs) await sleep(plan.delayMs);
        if (plan.failAt !== undefined && plan.failAt <= 0) {
          throw new Error(plan.errorMessage ?? "模拟失败");
        }
        for (const text of plan.reasoning ?? []) {
          yield { type: "reasoning" as const, text };
        }
        const chunks = plan.chunks ?? [];
        for (let piece = 0; piece < chunks.length; piece += 1) {
          if (plan.failAt !== undefined && piece >= plan.failAt) {
            throw new Error(plan.errorMessage ?? "模拟失败");
          }
          plan.beforeChunk?.(piece);
          yield { type: "text" as const, text: chunks[piece]! };
          if (plan.delayMs) await sleep(plan.delayMs);
        }
        if (plan.failAt !== undefined && plan.failAt >= chunks.length) {
          throw new Error(plan.errorMessage ?? "模拟失败");
        }
        if (plan.usage) yield { type: "usage" as const, usage: plan.usage };
      })();
    },
  };
  return { deps, calls };
}

function makeDef(steps: WorkflowStep[], name = "测试工作流"): WorkflowDef {
  return { id: "wf_test", name, description: "", steps, createdAt: 1, updatedAt: 1 };
}

function step(id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id,
    name: `步骤${id}`,
    instruction: `指令${id}`,
    input: "command",
    model: { provider: "deepseek", model: `model-${id}` },
    ...overrides,
  };
}

function listener(): { events: RunEvent[]; onEvent: (event: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function narrow<T extends RunEvent["type"]>(events: readonly RunEvent[], type: T) {
  return events.filter((event): event is Extract<RunEvent, { type: T }> => event.type === type);
}

test("顺序执行：分组串行、提示词模板、事件、finalText、usage 汇总", async () => {
  const steps = [
    step("s1", { name: "步骤一", role: "角色一", instruction: "指令一", input: "command" }),
    step("s2", {
      name: "步骤二",
      instruction: "指令二",
      input: "previous",
      model: { provider: "kimi", model: "k3", relayId: "relay-1" },
    }),
    step("s3", { name: "步骤三", role: "角色三", instruction: "指令三", input: "all" }),
  ];
  const { deps, calls } = fakeDeps((_call, index) => ({
    chunks: [`输出${index}`],
    reasoning: index === 0 ? ["想", "一下"] : undefined,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  }));
  const { events, onEvent } = listener();

  const result = await runWorkflow(makeDef(steps), "原始命令", deps, onEvent);

  assert.equal(calls.length, 3, "三个步骤各一次调用");
  assert.equal(calls[0]?.provider, "deepseek");
  assert.equal(calls[0]?.model, "model-s1");
  assert.equal(calls[0]?.system, "角色一");
  assert.equal(calls[0]?.messages.length, 1);
  assert.equal(calls[0]?.messages[0]?.role, "user");
  assert.equal(calls[0]?.messages[0]?.content, "指令一\n\n## 输入\n原始命令", "input=command");
  assert.equal(calls[0]?.maxTokens, DEFAULT_STEP_MAX_TOKENS);
  assert.equal(DEFAULT_STEP_MAX_TOKENS, 4096);
  assert.equal(calls[1]?.provider, "kimi");
  assert.equal(calls[1]?.model, "k3");
  assert.equal(calls[1]?.relayId, "relay-1");
  assert.equal(calls[1]?.system, undefined, "没有 role 就不发 system");
  assert.equal(calls[1]?.messages[0]?.content, "指令二\n\n## 输入\n输出0", "input=previous");
  assert.equal(
    calls[2]?.messages[0]?.content,
    "指令三\n\n## 输入\n## 步骤一\n\n输出0\n\n## 步骤二\n\n输出1",
    "input=all 带步骤标题且按执行顺序",
  );

  assert.equal(events[0]?.type, "stage");
  const stage = narrow(events, "stage")[0];
  assert.equal(stage?.stage, "workflow");
  assert.equal(stage?.label, "测试工作流");
  assert.equal(narrow(events, "stage").length, 1, "stage 只在开头发一次");

  const starts = narrow(events, "model.start");
  assert.deepEqual(starts.map((event) => event.participantId), ["wf_s1", "wf_s2", "wf_s3"]);
  assert.deepEqual(starts.map((event) => event.label), ["步骤一", "步骤二", "步骤三"]);

  const deltasByStep = new Map<string, string>();
  for (const delta of narrow(events, "model.delta")) {
    const key = `${delta.participantId}:${delta.channel}`;
    deltasByStep.set(key, (deltasByStep.get(key) ?? "") + delta.text);
  }
  assert.equal(deltasByStep.get("wf_s1:text"), "输出0");
  assert.equal(deltasByStep.get("wf_s1:reasoning"), "想一下");
  assert.equal(deltasByStep.get("wf_s2:text"), "输出1");

  const dones = narrow(events, "model.done");
  assert.deepEqual(dones.map((event) => event.text), ["输出0", "输出1", "输出2"]);
  assert.deepEqual(dones[0]?.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  assert.ok((dones[0]?.latencyMs ?? -1) >= 0);
  assert.deepEqual(narrow(events, "model.error"), []);

  const allowed = new Set(["stage", "model.start", "model.delta", "model.done", "model.error"]);
  assert.ok(events.every((event) => allowed.has(event.type)), "不越权发 run.* / final.*");

  assert.deepEqual(result.steps.map((item) => [item.stepId, item.status]), [
    ["s1", "done"],
    ["s2", "done"],
    ["s3", "done"],
  ]);
  assert.deepEqual(result.steps.map((item) => item.text), ["输出0", "输出1", "输出2"]);
  assert.equal(result.steps[0]?.reasoning, "想一下");
  assert.equal(result.finalText, "输出2");
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 6, totalTokens: 9 });
});

test("usage：都缺 totalTokens 时由 input+output 汇总", async () => {
  const steps = [step("a", { input: "command" }), step("b", { input: "previous" })];
  const { deps } = fakeDeps((_call, index) => ({
    chunks: [`x${index}`],
    usage: index === 0 ? { inputTokens: 5, outputTokens: 7 } : { inputTokens: 1 },
  }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);
  assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 7, totalTokens: 13 });
});

test("并行组：同组并发、组间串行，previous/all 按组边界", async () => {
  const steps = [
    step("a", { name: "并行A", parallelGroup: 1 }),
    step("b", { name: "并行B", parallelGroup: 1 }),
    step("c", { name: "汇总", input: "all", parallelGroup: 2 }),
  ];
  let active = 0;
  let maxActive = 0;
  const { deps, calls } = fakeDeps(async (call) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(15);
    active -= 1;
    return { chunks: [`${call.model}-结果`] };
  });
  const { events, onEvent } = listener();

  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);

  assert.equal(maxActive, 2, "同一个 parallelGroup 里两步确实并发");
  assert.deepEqual(calls.map((call) => call.model), ["model-a", "model-b", "model-c"]);
  const joined = calls[2]?.messages[0]?.content ?? "";
  assert.ok(joined.includes("## 并行A"), joined);
  assert.ok(joined.includes("## 并行B"), joined);
  assert.ok(joined.indexOf("并行A") < joined.indexOf("并行B"), "all 顺序按声明顺序");
  assert.equal(result.steps.map((item) => item.stepId).join(","), "a,b,c");
  assert.equal(result.finalText, "model-c-结果");
  assert.equal(narrow(events, "model.error").length, 0);
});

test("失败继续：失败步标 error，后续 step 仍执行且输入带错误说明", async () => {
  const steps = [
    step("s1", { name: "坏步骤", input: "command" }),
    step("s2", { name: "继续步骤", input: "previous" }),
    step("s3", { name: "汇总步骤", input: "all" }),
  ];
  const { deps, calls } = fakeDeps((call) => {
    if (call.model === "model-s1") {
      return { chunks: ["半成品"], failAt: 1, errorMessage: "炸了" };
    }
    return { chunks: [`${call.model} ok`] };
  });
  const { events, onEvent } = listener();

  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);

  assert.equal(calls.length, 3, "失败不影响后续步骤执行");
  assert.equal(result.steps[0]?.status, "error");
  assert.ok(result.steps[0]?.error?.includes("炸了"), result.steps[0]?.error);
  assert.equal(result.steps[0]?.text, "半成品", "保留已产出的部分文本");
  assert.equal(result.steps[1]?.status, "done");
  assert.equal(result.steps[2]?.status, "done");
  assert.ok(calls[1]?.messages[0]?.content.includes("执行失败"), calls[1]?.messages[0]?.content);
  assert.ok(calls[1]?.messages[0]?.content.includes("炸了"), calls[1]?.messages[0]?.content);

  const errors = narrow(events, "model.error");
  assert.deepEqual(errors.map((event) => event.participantId), ["wf_s1"]);
  assert.ok(errors[0]?.message.includes("炸了"));
  assert.equal(narrow(events, "model.done").length, 2, "只有成功的两步有 done");
  assert.equal(result.finalText, "model-s3 ok", "取最后一个成功步骤");
});

test("全部失败：finalText 为空字符串、usage 为空对象", async () => {
  const steps = [step("s1"), step("s2", { input: "previous" })];
  const { deps } = fakeDeps(() => ({ failAt: 0, errorMessage: "全挂" }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);
  assert.ok(result.steps.every((item) => item.status === "error"));
  assert.equal(result.finalText, "");
  assert.deepEqual(result.usage, {});
});

test("maxOutputChars：只截断给下游的输入，步骤自身保留全文", async () => {
  const long = "0123456789ABCDEFGHIJ";
  const steps = [
    step("s1", { maxOutputChars: 10 }),
    step("s2", { input: "previous" }),
  ];
  const { deps, calls } = fakeDeps(() => ({ chunks: [long] }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);

  const downstream = calls[1]?.messages[0]?.content ?? "";
  assert.ok(downstream.includes("0123456789"), downstream);
  assert.ok(!downstream.includes("GHIJ"), "超出 maxOutputChars 的尾巴不下传给后续步骤");
  assert.ok(downstream.includes("已截断"), downstream);
  assert.equal(result.steps[0]?.text, long, "本步骤自身保留全文");
});

test("outputMode=json：能解析则格式化，解析失败按文本保留", async () => {
  const steps = [
    step("json", { outputMode: "json" }),
    step("text", { input: "previous", outputMode: "json" }),
  ];
  const { deps } = fakeDeps((_call, index) => ({
    chunks: index === 0 ? ['{"a":1,"b":[1,2]}'] : ["不是 JSON"],
  }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);
  assert.equal(result.steps[0]?.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  assert.equal(result.steps[1]?.text, "不是 JSON");
});

test("取消：进行中的步骤标 error 并保留半成品，未开始的 skipped，Promise 正常返回", async () => {
  const controller = new AbortController();
  const steps = [
    step("s1", { name: "先跑" }),
    step("s2", { name: "跑到一半" }),
    step("s3", { name: "还没跑" }),
  ];
  const { deps, calls } = fakeDeps((call) => {
    if (call.model === "model-s2") {
      return {
        chunks: ["第一块", "第二块", "第三块"],
        beforeChunk: (index) => {
          if (index === 1) controller.abort();
        },
      };
    }
    return { chunks: [`${call.model} 完成`] };
  });
  const { events, onEvent } = listener();

  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent, {
    signal: controller.signal,
  });

  assert.equal(calls.length, 2, "取消后不再发起新调用");
  assert.equal(result.steps[0]?.status, "done");
  assert.equal(result.steps[1]?.status, "error");
  assert.ok(result.steps[1]?.error?.includes("已取消"), result.steps[1]?.error);
  assert.equal(result.steps[1]?.text, "第一块", "保留取消前的半成品");
  assert.equal(result.steps[2]?.status, "skipped");
  assert.equal(result.steps[2]?.text, "");
  assert.equal(result.finalText, "model-s1 完成", "取最近成功步");
  assert.deepEqual(narrow(events, "model.error").map((event) => event.participantId), ["wf_s2"]);
});

test("取消：signal 一开始就是 aborted，则所有步骤 skipped、零调用", async () => {
  const controller = new AbortController();
  controller.abort();
  const { deps, calls } = fakeDeps(() => ({ chunks: ["不该出现"] }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef([step("s1"), step("s2")]), "命令", deps, onEvent, {
    signal: controller.signal,
  });
  assert.equal(calls.length, 0);
  assert.ok(result.steps.every((item) => item.status === "skipped"));
  assert.equal(result.finalText, "");
  assert.deepEqual(result.usage, {});
});

test("stepIds：只跑被选中的步骤，其余不调用也不出现在结果里", async () => {
  const steps = [step("s1"), step("s2", { input: "previous" }), step("s3", { input: "all" })];
  const { deps, calls } = fakeDeps(() => ({ chunks: ["ok"] }));
  const { onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent, { stepIds: ["s2"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, "model-s2");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.stepId, "s2");
  assert.equal(result.finalText, "ok");
});

test("分组顺序：独占组保持声明顺序，数字组按组号升序填槽", async () => {
  const steps = [
    step("a", { name: "独占A" }),
    step("b", { name: "组2", parallelGroup: 2 }),
    step("c", { name: "独占C" }),
    step("d", { name: "组1", parallelGroup: 1 }),
  ];
  let active = 0;
  let maxActive = 0;
  const { deps, calls } = fakeDeps(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
    return { chunks: ["ok"] };
  });
  const { onEvent } = listener();
  await runWorkflow(makeDef(steps), "命令", deps, onEvent);
  assert.deepEqual(calls.map((call) => call.model), ["model-a", "model-d", "model-c", "model-b"]);
  assert.equal(maxActive, 1, "每个独占组只有一步，不并发");
});

test("未指定 model：该步标 error 并继续，不发起调用", async () => {
  const steps = [
    { id: "s1", name: "没模型", instruction: "指令", input: "command" } as WorkflowStep,
    step("s2", { input: "previous" }),
  ];
  const { deps, calls } = fakeDeps(() => ({ chunks: ["后续结果"] }));
  const { events, onEvent } = listener();
  const result = await runWorkflow(makeDef(steps), "命令", deps, onEvent);

  assert.equal(calls.length, 1);
  assert.equal(result.steps[0]?.status, "error");
  assert.ok(result.steps[0]?.error?.includes("未指定模型"), result.steps[0]?.error);
  assert.equal(narrow(events, "model.error")[0]?.participantId, "wf_s1");
  assert.equal(result.steps[1]?.status, "done");
  assert.equal(result.finalText, "后续结果");
});
