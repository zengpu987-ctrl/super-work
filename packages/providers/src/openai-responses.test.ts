/**
 * OpenAI Responses（ChatGPT 订阅）协议测试：本地假服务器返回固定 SSE。
 * 校验 Codex 端点、必需请求头、input 结构、delta 解析、response.failed 映射。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential } from "@super-work/core";
import {
  OpenAIResponsesAdapter,
  ProviderHttpError,
  adapterForCall,
} from "./index.js";
import {
  collectChunks,
  concatReasoning,
  concatText,
  startServer,
  usageOf,
  writeSse,
  type TestServer,
} from "./testing.js";

const BASE_OPTS: ChatCallOptions = {
  provider: "openai",
  model: "gpt-6.1-terra",
  messages: [{ role: "user", content: "你好" }],
  system: "你是助手",
};

function subscriptionCred(server: TestServer): Credential {
  return {
    provider: "openai",
    mode: "oauth-browser",
    source: "user",
    oauth: { access: "chatgpt-access-token", accountId: "acct_123" },
    baseUrl: `${server.url}/backend-api/codex`,
  };
}

function event(name: string, payload: unknown): string[] {
  return [`event: ${name}`, `data: ${JSON.stringify(payload)}`, ""];
}

test("openai-responses：端点 / 请求头 / body / SSE 解析", async (t) => {
  const captured: {
    path?: string;
    authorization?: string;
    accountId?: string;
    beta?: string;
    originator?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    captured.accountId =
      typeof req.headers["chatgpt-account-id"] === "string"
        ? req.headers["chatgpt-account-id"]
        : undefined;
    captured.beta = typeof req.headers["openai-beta"] === "string" ? req.headers["openai-beta"] : undefined;
    captured.originator =
      typeof req.headers.originator === "string" ? req.headers.originator : undefined;
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      ...event("response.created", { type: "response.created", response: { id: "resp_1" } }),
      ...event("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        delta: "先想",
      }),
      ...event("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "你好",
      }),
      ...event("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "，世界",
      }),
      ...event("response.completed", {
        type: "response.completed",
        response: { usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 } },
      }),
    ]);
  });
  t.after(() => server.close());

  const adapter = adapterForCall("openai", subscriptionCred(server));
  assert.ok(adapter instanceof OpenAIResponsesAdapter);
  const chunks = await collectChunks(adapter.chat(BASE_OPTS, subscriptionCred(server)));

  assert.equal(captured.path, "/backend-api/codex/responses");
  assert.equal(captured.authorization, "Bearer chatgpt-access-token");
  assert.equal(captured.accountId, "acct_123");
  assert.equal(captured.beta, "responses=experimental");
  assert.equal(captured.originator, "super_work");

  const body = captured.body;
  assert.ok(body);
  assert.equal(body.model, "gpt-6.1-terra");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, "你是助手");
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
  ]);

  assert.equal(concatText(chunks), "你好，世界");
  assert.equal(concatReasoning(chunks), "先想");
  assert.deepEqual(usageOf(chunks), { inputTokens: 11, outputTokens: 6, totalTokens: 17 });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("openai-responses：response.failed 抛 ProviderHttpError", async (t) => {
  const server = await startServer((_req, res) => {
    writeSse(res, [
      ...event("response.failed", {
        type: "response.failed",
        response: { error: { code: "server_error", message: "boom" } },
      }),
    ]);
  });
  t.after(() => server.close());

  await assert.rejects(
    async () => {
      await collectChunks(
        adapterForCall("openai", subscriptionCred(server)).chat(BASE_OPTS, subscriptionCred(server)),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /boom/);
      return true;
    },
  );
});

test("openai-responses：缺少 access token 时抛可读错误", async () => {
  const adapter = adapterForCall("openai", {
    provider: "openai",
    mode: "oauth-browser",
  });
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, { provider: "openai", mode: "oauth-browser" }));
    },
    /缺少访问令牌/,
  );
});

test("openai-responses：expiresAt 已过期时 validate 必须 ok:false（未过期才 ok:true）", async () => {
  const adapter = new OpenAIResponsesAdapter();
  const now = Date.now();

  const expired = await adapter.validate({
    provider: "openai",
    mode: "oauth-browser",
    oauth: { access: "stale-access-token", expiresAt: now - 60_000 },
  });
  assert.equal(expired.ok, false);
  assert.match(expired.detail ?? "", /过期/);

  const fresh = await adapter.validate({
    provider: "openai",
    mode: "oauth-browser",
    oauth: { access: "fresh-access-token", expiresAt: now + 3_600_000 },
  });
  assert.equal(fresh.ok, true);
  assert.ok((fresh.models?.length ?? 0) > 0);
});

test("openai-responses：5 档 effort 映射 reasoning.effort", () => {
  const adapter = new OpenAIResponsesAdapter();
  const cases: Array<["low" | "medium" | "fast" | "max" | "ultra", string]> = [
    ["low", "low"],
    ["medium", "medium"],
    ["fast", "medium"],
    ["max", "high"],
    ["ultra", "high"],
  ];
  for (const [effort, expected] of cases) {
    const body = adapter.buildBody({ ...BASE_OPTS, effort });
    assert.deepEqual(body.reasoning, { effort: expected }, `${effort} → ${expected}`);
  }
});

test("openai-responses：图片输入映射为 input_text + input_image", () => {
  const adapter = new OpenAIResponsesAdapter();
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  const body = adapter.buildBody({
    provider: "openai",
    model: "gpt-6.1-terra",
    messages: [{ role: "user", content: "看图", images: [png, jpeg] }],
  });
  assert.deepEqual(body.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "看图" },
        { type: "input_image", image_url: png },
        { type: "input_image", image_url: jpeg },
      ],
    },
  ]);
});

test("openai-responses：Codex 后端不接受 temperature，请求体必须省略", () => {
  const adapter = new OpenAIResponsesAdapter();
  const body = adapter.buildBody({ ...BASE_OPTS, temperature: 0.4 });
  assert.equal("temperature" in body, false, "Codex 会以 Unsupported parameter: temperature 400 拒绝");
  assert.equal(body.model, BASE_OPTS.model);
  assert.equal(body.stream, true);
});

test("openai-responses：temperature 设了也不能出现在真实请求里", async (t) => {
  let capturedBody: Record<string, unknown> = {};
  const server = await startServer((_req, res, raw) => {
    capturedBody = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      ...event("response.output_text.delta", { type: "response.output_text.delta", delta: "好" }),
      ...event("response.completed", { type: "response.completed", response: { status: "completed" } }),
    ]);
  });
  t.after(() => server.close());

  const cred = subscriptionCred(server);
  await collectChunks(
    adapterForCall("openai", cred).chat({ ...BASE_OPTS, temperature: 0.7 }, cred),
  );
  assert.equal("temperature" in capturedBody, false);
});

test("openai-responses：discoverModels 从 Codex /models 拉取实时订阅目录", async (t) => {
  let capturedPath: string | undefined;
  let capturedAccountId: string | undefined;
  const server = await startServer((req, res) => {
    capturedPath = req.url;
    capturedAccountId =
      typeof req.headers["chatgpt-account-id"] === "string"
        ? req.headers["chatgpt-account-id"]
        : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        models: [
          {
            slug: "gpt-6.2-sol",
            display_name: "GPT-6.2-Sol",
            visibility: "list",
            context_window: 500000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          {
            slug: "gpt-6.2-astra",
            display_name: "GPT-6.2-Astra",
            visibility: "list",
            context_window: 272000,
            input_modalities: ["text"],
            supported_reasoning_levels: [],
          },
          {
            slug: "gpt-reserve",
            display_name: "GPT-Reserve",
            visibility: "hide",
            context_window: 272000,
          },
        ],
      }),
    );
  });
  t.after(() => server.close());

  const adapter = new OpenAIResponsesAdapter();
  const models = await adapter.discoverModels(subscriptionCred(server));

  assert.match(capturedPath ?? "", /\/models\?client_version=/);
  assert.equal(capturedAccountId, "acct_123");
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-6.2-sol", "gpt-6.2-astra"],
    "visibility=hide 的模型不进入模型池",
  );
  const sol = models[0]!;
  assert.equal(sol.name, "GPT-6.2-Sol");
  assert.equal(sol.contextWindow, 500000);
  assert.equal(sol.reasoning, true);
  assert.equal(sol.vision, true);
  assert.equal(sol.via, "subscription");
  assert.equal(models[1]!.vision, false);
});
