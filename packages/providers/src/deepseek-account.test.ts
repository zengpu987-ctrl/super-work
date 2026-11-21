/**
 * DeepSeek 账户（DSH）适配器测试：Anthropic Messages 协议 + x-dsh-auth-token。
 * 本地假服务器，不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential } from "@super-work/core";
import { createAdapter, ProviderConfigError } from "./index.js";
import {
  collectChunks,
  concatReasoning,
  concatText,
  startServer,
  usageOf,
  writeSse,
} from "./testing.js";

const PROVIDER = "deepseek-account" as never;

function event(name: string, payload: unknown): string[] {
  return [`event: ${name}`, `data: ${JSON.stringify(payload)}`, ""];
}

const SSE = [
  ...event("message_start", {
    type: "message_start",
    message: { usage: { input_tokens: 9, output_tokens: 0 } },
  }),
  ...event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "想一想" },
  }),
  ...event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "OK" },
  }),
  ...event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 3 },
  }),
  ...event("message_stop", { type: "message_stop" }),
];

function cred(baseUrl: string): Credential {
  return {
    provider: PROVIDER,
    mode: "token",
    source: "local",
    baseUrl,
    pasted: { access: "dsh-account-token", kind: "bearer" },
  };
}

test("deepseek-account：x-dsh-auth-token + Messages SSE + system 独立字段", async (t) => {
  const captured: {
    path?: string;
    token?: string;
    authorization?: string;
    apiKey?: string;
    version?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.token =
      typeof req.headers["x-dsh-auth-token"] === "string" ? req.headers["x-dsh-auth-token"] : undefined;
    captured.authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    captured.apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    captured.version =
      typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : undefined;
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, SSE);
  });
  t.after(() => server.close());

  const opts: ChatCallOptions = {
    provider: PROVIDER,
    model: "deepseek-flash",
    messages: [{ role: "user", content: "只回复 OK" }],
    system: "你是助手",
    effort: "low",
    maxTokens: 64,
  };
  const chunks = await collectChunks(createAdapter(PROVIDER).chat(opts, cred(server.url)));

  assert.equal(captured.path, "/messages");
  assert.equal(captured.token, "dsh-account-token");
  assert.equal(captured.authorization, undefined);
  assert.equal(captured.apiKey, undefined);
  assert.equal(captured.version, "2023-06-01");
  assert.equal(captured.body?.model, "deepseek-flash");
  assert.equal(captured.body?.system, "你是助手");
  assert.equal(captured.body?.stream, true);
  assert.equal(captured.body?.max_tokens, 64);
  assert.equal(concatText(chunks), "OK");
  assert.equal(concatReasoning(chunks), "想一想");
  assert.deepEqual(usageOf(chunks), { inputTokens: 9, outputTokens: 3, totalTokens: 12 });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("deepseek-account：内置目录只含 V4.1 Flash / V4 Pro，缺少 token 时报错", async () => {
  const adapter = createAdapter(PROVIDER);
  const models = await adapter.listModels(null);
  assert.deepEqual(models.map((m) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(models[0]?.provider, "deepseek-account");
  assert.equal(models[0]?.vision, true);
  await assert.rejects(
    async () => {
      for await (const _ of adapter.chat(
        { provider: PROVIDER, model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] },
        null,
      )) {
        // consume
      }
    },
    (err: unknown) => err instanceof ProviderConfigError,
  );
});
