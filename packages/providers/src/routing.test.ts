/**
 * adapterForCall 选路规则测试（不联网）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Credential, ProviderId } from "@super-work/core";
import {
  AnthropicAdapter,
  GeminiAdapter,
  KimiHybridAdapter,
  KimiSubscriptionAdapter,
  MockAdapter,
  OpenAICompatAdapter,
  OpenAIResponsesAdapter,
  adapterForCall,
  createAdapter,
  isKimiSubscriptionCredential,
  isKimiSubscriptionModel,
  isOpenAIResponsesCredential,
  routeKimiCall,
} from "./index.js";
import { collectChunks } from "./testing.js";

function cred(provider: ProviderId, extra: Partial<Credential>): Credential {
  return { provider, mode: "api-key", ...extra };
}

test("adapterForCall：按 provider + 凭证模式选适配器", () => {
  assert.ok(adapterForCall("mock", null) instanceof MockAdapter);
  assert.ok(adapterForCall("deepseek", cred("deepseek", { apiKey: "k" })) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("zhipu", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("qwen", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("volcengine", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("minimax", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("xai", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("thirdparty", null) instanceof OpenAICompatAdapter);
  assert.ok(adapterForCall("anthropic", cred("anthropic", { apiKey: "k" })) instanceof AnthropicAdapter);
  assert.ok(adapterForCall("gemini", cred("gemini", { apiKey: "k" })) instanceof GeminiAdapter);

  // openai：API key → chat/completions；OAuth / 本机复用 → ChatGPT 订阅
  assert.ok(adapterForCall("openai", cred("openai", { apiKey: "sk" })) instanceof OpenAICompatAdapter);
  assert.ok(
    adapterForCall("openai", { provider: "openai", mode: "oauth-browser", oauth: { access: "a" } }) instanceof
      OpenAIResponsesAdapter,
  );
  assert.ok(
    adapterForCall("openai", {
      provider: "openai",
      mode: "local",
      source: "local",
      oauth: { access: "a" },
    }) instanceof OpenAIResponsesAdapter,
  );
  assert.ok(
    adapterForCall("openai", {
      provider: "openai",
      mode: "api-key",
      source: "local",
      apiKey: "sk",
    }) instanceof OpenAICompatAdapter,
  );

  // kimi：设备码 / 本机订阅 → kimi-subscription；同时有 apiKey → 混合适配器
  assert.ok(
    adapterForCall("kimi", { provider: "kimi", mode: "device-code", oauth: { access: "t" } }) instanceof
      KimiSubscriptionAdapter,
  );
  assert.ok(
    adapterForCall("kimi", {
      provider: "kimi",
      mode: "device-code",
      oauth: { access: "t" },
      apiKey: "sk",
    }) instanceof KimiHybridAdapter,
  );
  assert.ok(adapterForCall("kimi", cred("kimi", { apiKey: "sk" })) instanceof OpenAICompatAdapter);
});

test("createAdapter：默认形态与未知 provider", () => {
  assert.ok(createAdapter("mock") instanceof MockAdapter);
  assert.ok(createAdapter("openai") instanceof OpenAICompatAdapter);
  assert.ok(createAdapter("kimi") instanceof OpenAICompatAdapter);
  assert.ok(createAdapter("gemini") instanceof GeminiAdapter);
  assert.ok(createAdapter("anthropic") instanceof AnthropicAdapter);
  assert.throws(() => createAdapter("nope" as ProviderId), /未知 provider/);
});

test("凭证 / 模型判定函数", () => {
  assert.equal(isOpenAIResponsesCredential(null), false);
  assert.equal(isOpenAIResponsesCredential(cred("openai", { apiKey: "sk" })), false);
  assert.equal(
    isOpenAIResponsesCredential({ provider: "openai", mode: "oauth-browser" }),
    true,
  );
  assert.equal(isKimiSubscriptionCredential({ provider: "kimi", mode: "device-code" }), true);
  assert.equal(isKimiSubscriptionCredential(cred("kimi", { apiKey: "sk" })), false);
  assert.equal(isKimiSubscriptionModel("k3.1-pro"), true);
  assert.equal(isKimiSubscriptionModel("moonshot-v1-128k"), false);
});

test("routeKimiCall：订阅模型走会员通道，API 模型走 API 通道", () => {
  const both: Credential = {
    provider: "kimi",
    mode: "local",
    source: "local",
    oauth: { access: "membership-token" },
    apiKey: "sk-api",
  };
  assert.equal(routeKimiCall("k3.1-pro", both), "subscription");
  assert.equal(routeKimiCall("kimi-for-coding", both), "subscription");
  assert.equal(routeKimiCall("moonshot-v1-128k", both), "api");
  assert.equal(routeKimiCall("k3.1-pro", { provider: "kimi", mode: "local", oauth: { access: "t" } }), "subscription");
  assert.equal(routeKimiCall("moonshot-v1-128k", { provider: "kimi", mode: "api-key", apiKey: "k" }), "api");
});

test("KimiHybridAdapter：同凭证双通道时按模型打到 kimi.com/coding 或 moonshot", async () => {
  const calls: Array<{ url: string; auth?: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, auth, body });
    if (url.includes("/coding/v1/messages")) {
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const adapter = new KimiHybridAdapter();
    const mixed: Credential = {
      provider: "kimi",
      mode: "device-code",
      oauth: { access: "membership-token" },
      apiKey: "sk-api",
    };
    const userMessages = [{ role: "user" as const, content: "你好" }];

    await collectChunks(
      adapter.chat({ provider: "kimi", model: "k3.1-pro", messages: userMessages }, mixed),
    );
    const subscriptionCall = calls[0];
    assert.ok(subscriptionCall, "订阅模型应发出一次请求");
    assert.match(subscriptionCall.url, /^https:\/\/api\.kimi\.com\/coding\/v1\/messages$/);
    assert.equal(subscriptionCall.auth, "Bearer membership-token");
    assert.equal(subscriptionCall.body?.model, "k3.1-pro");
    assert.equal(subscriptionCall.body?.max_tokens, 8192);

    await collectChunks(
      adapter.chat({ provider: "kimi", model: "moonshot-v1-128k", messages: userMessages }, mixed),
    );
    const apiCall = calls[1];
    assert.ok(apiCall, "API 模型应发出一次请求");
    assert.match(apiCall.url, /^https:\/\/api\.moonshot\.cn\/v1\/chat\/completions$/);
    assert.equal(apiCall.auth, "Bearer sk-api");
    assert.equal(apiCall.body?.model, "moonshot-v1-128k");

    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
