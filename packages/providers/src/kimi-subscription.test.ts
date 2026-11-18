/**
 * Kimi 会员订阅协议测试：本地假服务器校验
 * - Anthropic 协议端点 /coding/v1/messages 与 SSE；
 * - Kimi CLI 公共头（User-Agent / X-Msh-*）；
 * - max_tokens 必填（默认 8192）；
 * - 缺少会员 token 时的可读错误。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential } from "@super-work/core";
import { ProviderConfigError, KimiSubscriptionAdapter } from "./index.js";
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
  provider: "kimi",
  model: "k3.1-pro",
  messages: [{ role: "user", content: "你好" }],
  system: "你是助手",
};

function subscriptionCred(server: TestServer): Credential {
  return {
    provider: "kimi",
    mode: "device-code",
    oauth: { access: "membership-token" },
    baseUrl: `${server.url}/coding/v1`,
  };
}

function event(name: string, payload: unknown): string[] {
  return [`event: ${name}`, `data: ${JSON.stringify(payload)}`, ""];
}

test("kimi-subscription：Anthropic 协议 + Kimi CLI 公共头 + max_tokens 默认 8192", async (t) => {
  const captured: {
    path?: string;
    authorization?: string;
    userAgent?: string;
    platform?: string;
    version?: string;
    deviceId?: string;
    deviceName?: string;
    deviceModel?: string;
    osVersion?: string;
    anthropicVersion?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    const header = (name: string): string | undefined =>
      typeof req.headers[name] === "string" ? (req.headers[name] as string) : undefined;
    captured.authorization = header("authorization");
    captured.userAgent = header("user-agent");
    captured.platform = header("x-msh-platform");
    captured.version = header("x-msh-version");
    captured.deviceId = header("x-msh-device-id");
    captured.deviceName = header("x-msh-device-name");
    captured.deviceModel = header("x-msh-device-model");
    captured.osVersion = header("x-msh-os-version");
    captured.anthropicVersion = header("anthropic-version");
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      ...event("message_start", {
        type: "message_start",
        message: { usage: { input_tokens: 8, output_tokens: 1 } },
      }),
      ...event("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "先想" },
      }),
      ...event("content_block_delta", {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "你好" },
      }),
      ...event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      }),
      ...event("message_stop", { type: "message_stop" }),
    ]);
  });
  t.after(() => server.close());

  const subscription = new KimiSubscriptionAdapter();
  const chunks = await collectChunks(subscription.chat(BASE_OPTS, subscriptionCred(server)));

  assert.equal(captured.path, "/coding/v1/messages");
  assert.equal(captured.authorization, "Bearer membership-token");
  assert.equal(captured.userAgent, "KimiCLI/1.0");
  assert.equal(captured.platform, "kimi_cli");
  assert.equal(captured.version, "1.0");
  assert.equal(captured.anthropicVersion, "2023-06-01");
  assert.ok(captured.deviceId && /^[0-9a-f]{32}$/.test(captured.deviceId), `设备 ID 应为去横线 uuid：${captured.deviceId}`);
  assert.ok(captured.deviceName && captured.deviceName.length > 0);
  assert.ok(captured.deviceModel && captured.deviceModel.length > 0);
  assert.ok(captured.osVersion && captured.osVersion.length > 0);

  const body = captured.body;
  assert.ok(body);
  assert.equal(body.model, "k3.1-pro");
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.stream, true);
  assert.equal(body.system, "你是助手");

  assert.equal(concatText(chunks), "你好");
  assert.equal(concatReasoning(chunks), "先想");
  assert.deepEqual(usageOf(chunks), { inputTokens: 8, outputTokens: 5, totalTokens: 13 });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("kimi-subscription：缺少会员 token 抛可读配置错误", async () => {
  const adapter = new KimiSubscriptionAdapter();
  await assert.rejects(
    async () => {
      await collectChunks(adapter.chat(BASE_OPTS, { provider: "kimi", mode: "device-code" }));
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderConfigError, `实际 ${String(err)}`);
      assert.match(err.message, /KIMI 会员订阅缺少访问令牌/);
      return true;
    },
  );
});

test("kimi-subscription：expiresAt 已过期时 validate 必须 ok:false（未过期才 ok:true）", async () => {
  const adapter = new KimiSubscriptionAdapter();
  const now = Date.now();

  const expired = await adapter.validate({
    provider: "kimi",
    mode: "device-code",
    oauth: { access: "stale-membership-token", expiresAt: now - 60_000 },
  });
  assert.equal(expired.ok, false);
  assert.match(expired.detail ?? "", /过期/);

  const fresh = await adapter.validate({
    provider: "kimi",
    mode: "device-code",
    oauth: { access: "fresh-membership-token", expiresAt: now + 3_600_000 },
  });
  assert.equal(fresh.ok, true);
  assert.ok((fresh.models?.length ?? 0) > 0);
});

test("kimi-subscription：discoverModels 从会员 /models 拉取实时目录", async (t) => {
  let capturedPath: string | undefined;
  let platform: string | undefined;
  let authorization: string | undefined;
  const server = await startServer((req, res) => {
    capturedPath = req.url;
    platform = typeof req.headers["x-msh-platform"] === "string" ? req.headers["x-msh-platform"] : undefined;
    authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "k3.1-pro",
            display_name: "K3.1 Pro",
            context_length: 1048576,
            supports_reasoning: true,
            supports_image_in: true,
          },
          {
            id: "kimi-for-coding-highspeed",
            display_name: "K2.7 Code Highspeed",
            context_length: 262144,
            supports_reasoning: true,
            supports_image_in: false,
          },
        ],
      }),
    );
  });
  t.after(() => server.close());

  const adapter = new KimiSubscriptionAdapter();
  const models = await adapter.discoverModels(subscriptionCred(server));

  assert.equal(capturedPath, "/coding/v1/models");
  assert.equal(platform, "kimi_cli");
  assert.equal(authorization, "Bearer membership-token");
  assert.deepEqual(models.map((m) => m.id), ["k3.1-pro", "kimi-for-coding-highspeed"]);
  assert.equal(models[0]!.name, "K3.1 Pro");
  assert.equal(models[0]!.contextWindow, 1048576);
  assert.equal(models[0]!.reasoning, true);
  assert.equal(models[0]!.vision, true);
  assert.equal(models[0]!.via, "subscription");
  assert.equal(models[1]!.vision, false);
});
