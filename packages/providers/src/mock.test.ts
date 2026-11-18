/**
 * mock 适配器测试：流式块数、reasoning、abort、usage、角色/厂商差异。
 * 完全离线，不启动任何服务器。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatChunk, EffortLevel, ProviderId } from "@super-work/core";
import { ProviderHttpError, createAdapter } from "./index.js";
import { collectChunks, concatReasoning, concatText, deltaCount, usageOf } from "./testing.js";

const COMMAND = "帮我把多模型联合工作的流式输出和 token 统计串起来";

function runMock(
  options: {
    model?: string;
    system?: string;
    provider?: ProviderId;
    command?: string;
    effort?: EffortLevel;
  } = {},
): Promise<ChatChunk[]> {
  const adapter = createAdapter("mock");
  return collectChunks(
    adapter.chat(
      {
        provider: options.provider ?? "mock",
        model: options.model ?? "mock-fast",
        messages: [{ role: "user", content: options.command ?? COMMAND }],
        system: options.system ?? "角色：长文与代码\n只针对命令作答，不要复述提示词。",
        effort: options.effort,
      },
      null,
    ),
  );
}

test("mock-fast：24~40 个 delta，含 text/usage/done 且引用命令片段", async () => {
  const chunks = await runMock({ model: "mock-fast" });
  const text = concatText(chunks);
  const deltas = deltaCount(chunks);

  assert.ok(deltas > 10, `delta 块数应 >10，实际 ${deltas}`);
  assert.ok(deltas >= 24 && deltas <= 40, `delta 块数应在 24~40，实际 ${deltas}`);
  assert.equal(chunks.filter((chunk) => chunk.type === "reasoning").length, 0, "mock-fast 不应有 reasoning");

  assert.match(text, /^结论（/);
  assert.match(text, /建议：/);
  assert.ok(text.includes("多模型联合工作"), `正文应引用命令片段：${text.slice(0, 80)}`);

  const usage = usageOf(chunks);
  assert.ok(usage, "应有 usage 块");
  assert.ok((usage?.inputTokens ?? 0) > 0);
  assert.ok((usage?.outputTokens ?? 0) > 0);
  assert.equal(usage?.totalTokens, (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));

  const done = chunks[chunks.length - 1];
  assert.equal(done?.type, "done");
});

test("mock-thinker：先 reasoning（20~40 字、分点）再 text", async () => {
  const chunks = await runMock({ model: "mock-thinker", system: "角色：深度分析" });
  const firstTextIndex = chunks.findIndex((chunk) => chunk.type === "text");
  const reasoningChunks = chunks.filter(
    (chunk): chunk is Extract<ChatChunk, { type: "reasoning" }> => chunk.type === "reasoning",
  );

  assert.ok(reasoningChunks.length >= 2, "reasoning 应分多块流出");
  assert.ok(firstTextIndex > 0, "reasoning 必须先于 text");
  assert.ok(
    chunks.slice(0, firstTextIndex).every((chunk) => chunk.type === "reasoning"),
    "text 出现之前只能有 reasoning",
  );

  const reasoning = concatReasoning(chunks);
  const reasoningChars = Array.from(reasoning).length;
  assert.ok(reasoningChars >= 20 && reasoningChars <= 40, `reasoning 应 20~40 字，实际 ${reasoningChars}`);
  assert.match(reasoning, /- /, "reasoning 应分点");
  assert.match(reasoning, /意图/);

  const text = concatText(chunks);
  assert.match(text, /深度分析/);
  const usage = usageOf(chunks);
  assert.ok((usage?.reasoningTokens ?? 0) > 0, "thinker 应上报 reasoningTokens");
});

test("mock 尊重 AbortSignal：abort 后抛 AbortError", async () => {
  const adapter = createAdapter("mock");
  const controller = new AbortController();
  const iterator = adapter
    .chat(
      {
        provider: "mock",
        model: "mock-fast",
        messages: [{ role: "user", content: COMMAND }],
        signal: controller.signal,
      },
      null,
    )
    [Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false, "应先正常产出第一块");
  controller.abort();

  await assert.rejects(
    async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("不同角色 / provider 的措辞可区分", async () => {
  const deep = concatText(await runMock({ system: "角色：深度分析" }));
  const code = concatText(await runMock({ system: "角色：长文与代码" }));
  assert.match(deep, /深度分析/);
  assert.match(deep, /风险清单/);
  assert.match(code, /长文与代码/);
  assert.match(code, /实现步骤/);
  assert.notEqual(deep, code);

  // 同一个 mock 适配器被当作 fallback 交给其它 provider 时，措辞应体现该 provider 的视角
  const asDeepseek = concatText(await runMock({ provider: "deepseek", system: "" }));
  assert.match(asDeepseek, /推理校验/);
  assert.notEqual(asDeepseek, deep);

  const asGemini = concatText(await runMock({ provider: "gemini", system: "" }));
  assert.match(asGemini, /多模态视角/);
});

test("mock 超时：外部 signal 与超时合并后抛 ProviderHttpError(408)", async () => {
  const adapter = createAdapter("mock", { timeoutMs: 5 });
  await assert.rejects(
    async () => {
      await collectChunks(
        adapter.chat(
          {
            provider: "mock",
            model: "mock-fast",
            messages: [{ role: "user", content: COMMAND }],
          },
          null,
        ),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError, `应抛 ProviderHttpError，实际 ${String(err)}`);
      assert.equal(err.status, 408);
      assert.equal(err.provider, "mock");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test("mock listModels / validate 无需网络", async () => {
  const adapter = createAdapter("mock");
  const models = await adapter.listModels(null);
  assert.ok(models.some((model) => model.id === "mock-fast"));
  assert.ok(models.some((model) => model.id === "mock-thinker"));
  const result = await adapter.validate({ provider: "mock", mode: "token" });
  assert.equal(result.ok, true);
  assert.ok((result.models?.length ?? 0) >= 2);
});

test("mock：5 档 effort 的 reasoning 行数 / 正文长度 / usage / 块数递增", async () => {
  const levels: EffortLevel[] = ["low", "medium", "fast", "max", "ultra"];
  const expectedReasoningLines = [0, 2, 3, 5, 7];
  const results = [];
  for (const effort of levels) {
    const chunks = await runMock({ model: "mock-fast", effort });
    results.push({
      effort,
      text: concatText(chunks),
      reasoning: concatReasoning(chunks),
      usage: usageOf(chunks),
      deltas: deltaCount(chunks),
    });
  }

  assert.equal(results[0]?.reasoning, "", "low 不应有 reasoning");
  results.forEach((result, index) => {
    const lines = result.reasoning ? result.reasoning.split("\n").filter(Boolean).length : 0;
    assert.equal(lines, expectedReasoningLines[index], `${result.effort} 的 reasoning 行数`);
  });

  for (let index = 1; index < results.length; index += 1) {
    const previous = results[index - 1]!;
    const current = results[index]!;
    assert.ok(
      Array.from(current.text).length > Array.from(previous.text).length,
      `${current.effort} 正文应比 ${previous.effort} 更长`,
    );
    assert.ok(
      (current.usage?.outputTokens ?? 0) > (previous.usage?.outputTokens ?? 0),
      `${current.effort} 的 outputTokens 应更大`,
    );
    assert.ok(
      current.deltas > previous.deltas,
      `${current.effort} 的流式块数应更多（${previous.deltas} → ${current.deltas}）`,
    );
  }
});
