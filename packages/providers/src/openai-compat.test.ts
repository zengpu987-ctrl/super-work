/**
 * openai-compat 协议测试：本地假服务器（listen(0) 动态端口）返回固定 SSE，
 * 校验 text / reasoning / usage 解析、请求体、错误映射。不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential, EffortLevel } from "@super-work/core";
import { OpenAICompatAdapter, createAdapter, ProviderHttpError } from "./index.js";
import {
  collectChunks,
  concatReasoning,
  concatText,
  startServer,
  usageOf,
  writeError,
  writeSse,
  type TestServer,
} from "./testing.js";

const BASE_OPTS: ChatCallOptions = {
  provider: "deepseek",
  model: "deepseek-chat",
  messages: [{ role: "user", content: "你好" }],
  system: "你是助手",
};

function credFor(server: TestServer, extra: Partial<Credential> = {}): Credential {
  return {
    provider: "deepseek",
    mode: "api-key",
    apiKey: "test-key",
    baseUrl: `${server.url}/v1`,
    ...extra,
  };
}

function jsonLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

/** 一个 OpenAI 风格 SSE 事件（data 行 + 空行分隔）。 */
function event(payload: unknown): string[] {
  return [jsonLine(payload), ""];
}

test("openai-compat：解析 text / reasoning_content / reasoning / usage", async (t) => {
  const captured: { path?: string; auth?: string; body?: Record<string, unknown> } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.auth = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      ...event({ choices: [{ delta: { role: "assistant" } }] }),
      ...event({ choices: [{ delta: { reasoning_content: "先核对" } }] }),
      ...event({ choices: [{ delta: { reasoning: "前提。" } }] }),
      ...event({ choices: [{ delta: { content: "你好" } }] }),
      ...event({ choices: [{ delta: { content: "，世界" } }] }),
      ...event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ...event({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
      "data: [DONE]",
      "",
    ]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("deepseek");
  const chunks = await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));

  assert.equal(captured.path, "/v1/chat/completions");
  assert.equal(captured.auth, "Bearer test-key");
  const body = captured.body;
  assert.ok(body);
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "你是助手");
  assert.equal(messages[1]?.role, "user");

  assert.equal(concatText(chunks), "你好，世界");
  assert.equal(concatReasoning(chunks), "先核对前提。");
  assert.deepEqual(usageOf(chunks), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 4,
    reasoningTokens: 3,
  });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("openai-compat：非 2xx 抛 ProviderHttpError（429 retryable、片段 ≤300）", async (t) => {
  const server = await startServer((_req, res) => {
    writeError(res, 429, { error: { message: `rate limited ${"x".repeat(600)}` } });
  });
  t.after(() => server.close());

  const adapter = createAdapter("deepseek");
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError, `应抛 ProviderHttpError，实际 ${String(err)}`);
      assert.equal(err.status, 429);
      assert.equal(err.retryable, true);
      assert.ok(err.bodySnippet.length <= 300, `片段应 ≤300，实际 ${err.bodySnippet.length}`);
      assert.match(err.bodySnippet, /rate limited/);
      assert.match(err.message, /deepseek/);
      return true;
    },
  );
});

test("openai-compat：401 不可重试", async (t) => {
  const server = await startServer((_req, res) => {
    writeError(res, 401, { error: { message: "invalid api key" } });
  });
  t.after(() => server.close());

  const adapter = createAdapter("deepseek");
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("openai-compat：网络错误转成带 provider 信息的 ProviderHttpError", async () => {
  const adapter = createAdapter("deepseek");
  await assert.rejects(
    async () => {
      await collectChunks(
        adapter.chat(BASE_OPTS, {
          provider: "deepseek",
          mode: "api-key",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1/v1",
        }),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError, `应抛 ProviderHttpError，实际 ${String(err)}`);
      assert.equal(err.status, 0);
      assert.equal(err.retryable, true);
      assert.match(err.message, /deepseek/);
      return true;
    },
  );
});

test("thirdparty：缺少 baseUrl 时给出可读错误", async () => {
  const adapter = createAdapter("thirdparty");
  await assert.rejects(
    async () => {
      await collectChunks(
        adapter.chat(
          { provider: "thirdparty", model: "any-model", messages: [{ role: "user", content: "hi" }] },
          { provider: "thirdparty", mode: "api-key", apiKey: "k" },
        ),
      );
    },
    /baseUrl/,
  );
});

test("openai-compat：listRemoteModels 解析 /models", async (t) => {
  const server = await startServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(
      JSON.stringify({
        data: [
          { id: "deepseek-chat", display_name: "DeepSeek Chat", context_length: 128000 },
          { id: "deepseek-reasoner" },
        ],
      }),
    );
  });
  t.after(() => server.close());

  const adapter = createAdapter("deepseek");
  const models = await adapter.listModels(credFor(server));
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "deepseek-chat");
  assert.equal(models[0]?.name, "DeepSeek Chat");
  assert.equal(models[0]?.contextWindow, 128000);
  assert.equal(models[1]?.id, "deepseek-reasoner");
});

test("openai-compat：effort 映射 reasoning_effort，max_tokens 用调用方值不放大", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startServer((_req, res, raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("deepseek");
  const cases: Array<[EffortLevel, string]> = [
    ["low", "low"],
    ["medium", "medium"],
    ["fast", "medium"],
    ["max", "high"],
    ["ultra", "high"],
  ];
  for (const [effort] of cases) {
    await collectChunks(adapter.chat({ ...BASE_OPTS, effort, maxTokens: 1234 }, credFor(server)));
  }

  cases.forEach(([effort, expected], index) => {
    const body = bodies[index];
    assert.ok(body, `第 ${index + 1} 次请求应有 body`);
    assert.equal(body.reasoning_effort, expected, `${effort} 应映射为 ${expected}`);
    assert.equal(body.max_tokens, 1234, "max_tokens 不应被二次放大");
    assert.equal(body.max_completion_tokens, undefined);
  });
});

test("openai-compat：o 系列 / gpt-5+ 用 max_completion_tokens", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startServer((_req, res, raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("openai");
  const credential: Credential = {
    provider: "openai",
    mode: "api-key",
    apiKey: "sk-openai",
    baseUrl: `${server.url}/v1`,
  };
  for (const model of ["o3-mini", "gpt-5.2"]) {
    await collectChunks(
      adapter.chat(
        {
          provider: "openai",
          model,
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 777,
          temperature: 0.5,
          effort: "max",
        },
        credential,
      ),
    );
  }

  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.max_completion_tokens, 777);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.temperature, undefined, "推理模型不接受自定义 temperature");
  }
});

const IMG_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const IMG_JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

test("openai-compat：图片输入映射为 text + image_url（多图有序）", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startServer((_req, res, raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  await collectChunks(
    createAdapter("deepseek").chat(
      {
        provider: "deepseek",
        model: "deepseek-chat",
        messages: [{ role: "user", content: "看图", images: [IMG_PNG, IMG_JPEG] }],
      },
      credFor(server),
    ),
  );

  const messages = bodies[0]?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: IMG_PNG } },
        { type: "image_url", image_url: { url: IMG_JPEG } },
      ],
    },
  ]);
});

test("openai-compat：无图片时 content 仍是字符串（回归）", () => {
  const body = new OpenAICompatAdapter({ id: "deepseek" }).buildBody({
    provider: "deepseek",
    model: "deepseek-chat",
    system: "你是助手",
    messages: [{ role: "user", content: "你好" }],
  });
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  assert.deepEqual(messages, [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
});

test("validate：/models 404 → ok:true 并给出固定兜底提示", async (t) => {
  const server = await startServer((_req, res) => {
    writeError(res, 404, "<html><body>Not Found</body></html>");
  });
  t.after(() => server.close());

  const result = await createAdapter("deepseek").validate(credFor(server));
  assert.deepEqual(result, { ok: true, detail: "上游未提供 /models，已跳过网络校验" });
});

test("validate：/models 401 → ok:false", async (t) => {
  const server = await startServer((_req, res) => {
    writeError(res, 401, { error: { message: "invalid api key" } });
  });
  t.after(() => server.close());

  const result = await createAdapter("deepseek").validate(credFor(server));
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /401|invalid api key/i);
});

test("validate：/models 返回 HTML 非 JSON → ok:true", async (t) => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end("<html><body>welcome</body></html>");
  });
  t.after(() => server.close());

  const result = await createAdapter("deepseek").validate(credFor(server));
  assert.equal(result.ok, true);
  assert.equal(result.detail, "上游未提供 /models，已跳过网络校验");
});

test("validate：网络错误 → ok:false", async () => {
  const result = await createAdapter("deepseek").validate({
    provider: "deepseek",
    mode: "api-key",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1",
  });
  assert.equal(result.ok, false);
  assert.ok((result.detail ?? "").length > 0);
});
