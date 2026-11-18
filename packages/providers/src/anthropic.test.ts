/**
 * anthropic 协议测试：本地假服务器返回固定 Anthropic SSE。
 * 覆盖 x-api-key / Bearer 两种鉴权、text_delta / thinking_delta、usage 累计、错误映射。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential, EffortLevel } from "@super-work/core";
import { buildAnthropicBody, createAdapter, ProviderHttpError } from "./index.js";
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
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "你好" }],
  system: "你是助手",
};

function credFor(server: TestServer, extra: Partial<Credential> = {}): Credential {
  return {
    provider: "anthropic",
    mode: "api-key",
    apiKey: "sk-ant-test",
    baseUrl: `${server.url}/v1`,
    ...extra,
  };
}

function event(name: string, payload: unknown): string[] {
  return [`event: ${name}`, `data: ${JSON.stringify(payload)}`, ""];
}

const ANTHROPIC_SSE = [
  ...event("message_start", {
    type: "message_start",
    message: { usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 } },
  }),
  ...event("ping", { type: "ping" }),
  ...event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "先想一下" },
  }),
  ...event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "答案" },
  }),
  ...event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "如下" },
  }),
  ...event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7 },
  }),
  ...event("message_stop", { type: "message_stop" }),
];

test("anthropic：x-api-key + system 独立字段 + SSE 解析", async (t) => {
  const captured: {
    path?: string;
    xApiKey?: string;
    authorization?: string;
    version?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.xApiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    captured.authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    captured.version = typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : undefined;
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ANTHROPIC_SSE);
  });
  t.after(() => server.close());

  const adapter = createAdapter("anthropic");
  const chunks = await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));

  assert.equal(captured.path, "/v1/messages");
  assert.equal(captured.xApiKey, "sk-ant-test");
  assert.equal(captured.authorization, undefined);
  assert.equal(captured.version, "2023-06-01");

  const body = captured.body;
  assert.ok(body);
  assert.equal(body.stream, true);
  assert.equal(body.system, "你是助手");
  assert.equal(body.max_tokens, 4096);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages, [{ role: "user", content: "你好" }]);

  assert.equal(concatText(chunks), "答案如下");
  assert.equal(concatReasoning(chunks), "先想一下");
  assert.deepEqual(usageOf(chunks), {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    cachedInputTokens: 3,
  });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("anthropic：token/pasted 凭证走 Bearer", async (t) => {
  let authorization: string | undefined;
  let xApiKey: string | undefined;
  const server = await startServer((req, res) => {
    authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    xApiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    writeSse(res, ANTHROPIC_SSE);
  });
  t.after(() => server.close());

  const adapter = createAdapter("anthropic");
  const chunks = await collectChunks(
    adapter.chat(BASE_OPTS, credFor(server, {
      mode: "token",
      apiKey: undefined,
      pasted: { access: "claude-code-token", kind: "bearer" },
    })),
  );

  assert.equal(authorization, "Bearer claude-code-token");
  assert.equal(xApiKey, undefined);
  assert.equal(concatText(chunks), "答案如下");
});

test("anthropic：非 2xx 抛 ProviderHttpError（500 retryable）", async (t) => {
  const server = await startServer((_req, res) => {
    writeError(res, 500, { type: "error", error: { type: "api_error", message: "internal" } });
  });
  t.after(() => server.close());

  const adapter = createAdapter("anthropic");
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      assert.equal(err.provider, "anthropic");
      assert.ok(err.bodySnippet.length <= 300);
      return true;
    },
  );
});

test("anthropic：SSE error 事件转成可读错误", async (t) => {
  const server = await startServer((_req, res) => {
    writeSse(res, [
      ...event("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 3 } },
      }),
      ...event("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("anthropic");
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, credFor(server)));
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      assert.match(err.message, /anthropic/);
      assert.match(err.message, /Overloaded/);
      return true;
    },
  );
});

test("anthropic：缺少凭证时抛可读配置错误", async () => {
  const adapter = createAdapter("anthropic");
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, { provider: "anthropic", mode: "token" }));
    },
    /anthropic 缺少凭证/,
  );
});

test("anthropic：5 档 effort → thinking budget（max_tokens > budget，low 不启用）", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startServer((_req, res, raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    writeSse(res, ANTHROPIC_SSE);
  });
  t.after(() => server.close());

  const adapter = createAdapter("anthropic");
  const cases: Array<[EffortLevel, number | undefined]> = [
    ["low", undefined],
    ["medium", 8192],
    ["fast", 4096],
    ["max", 16384],
    ["ultra", 32768],
  ];
  for (const [effort] of cases) {
    await collectChunks(
      adapter.chat(
        { ...BASE_OPTS, effort, maxTokens: 2048, temperature: 0.7 },
        credFor(server),
      ),
    );
  }

  cases.forEach(([effort, budget], index) => {
    const body = bodies[index];
    assert.ok(body, `第 ${index + 1} 次请求应有 body`);
    if (budget === undefined) {
      assert.equal(body.thinking, undefined, "low 不应启用 thinking");
      assert.equal(body.max_tokens, 2048);
      assert.equal(body.temperature, 0.7);
      return;
    }
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: budget }, `${effort} budget`);
    assert.ok(
      Number(body.max_tokens) > budget,
      `${effort} 的 max_tokens(${body.max_tokens}) 必须大于 budget(${budget})`,
    );
    assert.equal(body.temperature, undefined, "thinking 启用时不传 temperature");
  });
});

test("anthropic：图片输入映射为 base64 image block", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ANTHROPIC_SSE);
  });
  t.after(() => server.close());

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  await collectChunks(
    createAdapter("anthropic").chat(
      {
        ...BASE_OPTS,
        messages: [{ role: "user", content: "看图", images: [png, jpeg] }],
      },
      credFor(server),
    ),
  );

  assert.deepEqual(body?.messages, [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" },
        },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
        },
        { type: "text", text: "看图" },
      ],
    },
  ]);
});

test("anthropic：无图片时 messages content 仍是字符串（回归）", () => {
  const body = buildAnthropicBody(BASE_OPTS, "anthropic", 4096);
  assert.ok(body);
  assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);
});
