/**
 * 中转站（relay，OpenAI 兼容）测试：本地假服务器（listen(0)），不联网。
 * 覆盖：discoverRelayModels 三种响应形状、401 可读错误、chat 走 cred.baseUrl、
 * 缺 baseUrl 的配置错误、adapterForCall / createAdapter 选路。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCallOptions, Credential } from "@super-work/core";
import {
  ProviderConfigError,
  ProviderHttpError,
  RelayAdapter,
  WorkBuddyAdapter,
  adapterForCall,
  createAdapter,
  discoverRelayModels,
} from "./index.js";
import {
  collectChunks,
  concatText,
  startServer,
  usageOf,
  writeError,
  writeSse,
  type TestServer,
} from "./testing.js";

function writeJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    connection: "close",
  });
  res.end(JSON.stringify(payload));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

function relayCred(server: TestServer): Credential {
  return {
    provider: "relay",
    mode: "api-key",
    apiKey: "relay-key",
    baseUrl: server.url,
  };
}

test("relay：discoverRelayModels 兼容 data / 裸数组 / data.data 三种形状", async (t) => {
  const captured: { tenant?: string } = {};
  const server = await startServer((req, res) => {
    captured.tenant = header(req, "x-tenant");
    if (req.url === "/openai/models") {
      writeJson(res, {
        data: [
          { id: "gpt-x", display_name: "GPT X", context_length: 64000 },
          { id: "claude-y" },
        ],
      });
      return;
    }
    if (req.url === "/bare/models") {
      writeJson(res, [{ id: "bare-1", name: "Bare One", context_length: 32000 }]);
      return;
    }
    if (req.url === "/nested/models") {
      writeJson(res, {
        data: { data: [{ id: "nested-1", display_name: "Nested One", context_length: 128000 }] },
      });
      return;
    }
    if (req.url === "/headers/models") {
      writeJson(res, { data: [{ id: "headers-1" }] });
      return;
    }
    writeError(res, 404, { error: { message: "not found" } });
  });
  t.after(() => server.close());

  const first = await discoverRelayModels(`${server.url}/openai`, "sk-1");
  assert.deepEqual(
    first.map((model) => model.id),
    ["gpt-x", "claude-y"],
  );
  assert.equal(first[0]?.provider, "relay");
  assert.equal(first[0]?.name, "GPT X");
  assert.equal(first[0]?.contextWindow, 64000);
  assert.equal(first[1]?.name, "claude-y");

  const bare = await discoverRelayModels(`${server.url}/bare`, "sk-1");
  assert.deepEqual(
    bare.map((model) => model.id),
    ["bare-1"],
  );
  assert.equal(bare[0]?.name, "Bare One");
  assert.equal(bare[0]?.contextWindow, 32000);

  const nested = await discoverRelayModels(`${server.url}/nested`, "sk-1");
  assert.deepEqual(
    nested.map((model) => model.id),
    ["nested-1"],
  );
  assert.equal(nested[0]?.name, "Nested One");
  assert.equal(nested[0]?.contextWindow, 128000);

  const withHeaders = await discoverRelayModels(`${server.url}/headers`, "sk-1", {
    "X-Tenant": "tenant-9",
  });
  assert.equal(withHeaders.length, 1);
  assert.equal(captured.tenant, "tenant-9");
});

test("relay：401 抛可读的鉴权错误", async (t) => {
  const server = await startServer((req, res) => {
    writeError(res, 401, { error: { message: "invalid api key" } });
  });
  t.after(() => server.close());

  await assert.rejects(discoverRelayModels(server.url, "bad-key"), (err: unknown) => {
    assert.ok(err instanceof ProviderHttpError, `实际 ${String(err)}`);
    assert.equal(err.status, 401);
    assert.match(err.message, /401/);
    assert.match(err.message, /API Key|鉴权/);
    return true;
  });
});

test("relay：chat 走 cred.baseUrl 并复用 OpenAI 兼容 SSE", async (t) => {
  const captured: {
    path?: string;
    authorization?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.authorization = header(req, "authorization");
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      'data: {"choices":[{"delta":{"content":"pong"}}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      "",
      "data: [DONE]",
      "",
    ]);
  });
  t.after(() => server.close());

  const credential = relayCred(server);
  const adapter = adapterForCall("relay", credential);
  assert.ok(adapter instanceof RelayAdapter);

  const opts: ChatCallOptions = {
    provider: "relay",
    model: "gpt-x",
    messages: [{ role: "user", content: "ping" }],
  };
  const chunks = await collectChunks(adapter.chat(opts, credential));

  assert.equal(captured.path, "/chat/completions");
  assert.equal(captured.authorization, "Bearer relay-key");
  assert.equal(captured.body?.model, "gpt-x");
  assert.equal(captured.body?.stream, true);
  assert.equal(concatText(chunks), "pong");
  assert.deepEqual(usageOf(chunks), { inputTokens: 3, outputTokens: 1, totalTokens: 4 });
});

test("relay：缺少 baseUrl 抛可读配置错误", async () => {
  const credential: Credential = { provider: "relay", mode: "api-key", apiKey: "relay-key" };
  const adapter = adapterForCall("relay", credential);
  await assert.rejects(
    async () => {
      await collectChunks(
        adapter.chat(
          { provider: "relay", model: "gpt-x", messages: [{ role: "user", content: "ping" }] },
          credential,
        ),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderConfigError, `实际 ${String(err)}`);
      assert.match(err.message, /baseUrl/i);
      return true;
    },
  );
});

test("relay：createAdapter 的 baseUrl 在凭证未带地址时生效", async (t) => {
  const server = await startServer((req, res) => {
    assert.equal(req.url, "/chat/completions");
    writeSse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}', "", "data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const credential: Credential = { provider: "relay", mode: "api-key", apiKey: "relay-key" };
  const adapter = createAdapter("relay", { baseUrl: server.url });
  const chunks = await collectChunks(
    adapter.chat(
      { provider: "relay", model: "gpt-x", messages: [{ role: "user", content: "ping" }] },
      credential,
    ),
  );
  assert.equal(concatText(chunks), "ok");
});

test("relay：adapterForCall / createAdapter 识别 relay 与 workbuddy", () => {
  assert.ok(adapterForCall("relay", null) instanceof RelayAdapter);
  assert.ok(adapterForCall("workbuddy", null) instanceof WorkBuddyAdapter);
  assert.ok(createAdapter("relay", { baseUrl: "https://relay.example.com/v1" }) instanceof RelayAdapter);
  assert.ok(createAdapter("workbuddy") instanceof WorkBuddyAdapter);
});

test("relay：5 档 effort 透传 reasoning_effort", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const credential = relayCred(server);
  const adapter = adapterForCall("relay", credential);
  await collectChunks(
    adapter.chat(
      {
        provider: "relay",
        model: "gpt-x",
        messages: [{ role: "user", content: "hi" }],
        effort: "ultra",
        maxTokens: 99,
      },
      credential,
    ),
  );

  assert.equal(body?.reasoning_effort, "high");
  assert.equal(body?.max_tokens, 99);
});

test("relay：图片输入映射为 text + image_url", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const credential = relayCred(server);
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  await collectChunks(
    adapterForCall("relay", credential).chat(
      {
        provider: "relay",
        model: "gpt-x",
        messages: [{ role: "user", content: "看图", images: [image] }],
      },
      credential,
    ),
  );

  const messages = body?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], {
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: image } },
    ],
  });
});
