/**
 * WorkBuddy 适配器测试：本地假服务器（listen(0)），不联网。
 * 覆盖：模型目录（信封/能力标记/回退）、chat SSE（content + reasoning_content + usage）、
 * 首条 system 补齐、生图（url + credit）、信封 code≠0、401 可读错误、validate。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatCallOptions, Credential } from "@super-work/core";
import {
  ProviderHttpError,
  WORKBUDDY_PRODUCT_USER_AGENT,
  WORKBUDDY_USER_AGENT,
  WORKBUDDY_VISION_MODEL,
  WorkBuddyAdapter,
  describeImageWithWorkbuddy,
} from "./index.js";
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

function wbCred(server: TestServer): Credential {
  return {
    provider: "workbuddy",
    mode: "token",
    baseUrl: server.url,
    pasted: {
      access: "wb-access-token",
      kind: "bearer",
      extraHeaders: { "X-User-Id": "uid-1", "X-Domain": "www.codebuddy.cn" },
    },
  };
}

const CATALOG = {
  code: 0,
  msg: "",
  data: {
    models: [
      {
        id: "deepseek-v4.1-flash",
        name: "DeepSeek V4.1 Flash",
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        supportsImages: true,
        reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "low" },
      },
      {
        id: "hunyuan-image-alpha",
        name: "混元生图",
        maxInputTokens: 4096,
        maxOutputTokens: 4096,
        tags: ["text-to-image"],
        credits: "x5.71 credits",
      },
      { id: "disabled-model", name: "退役模型", maxInputTokens: 100, maxOutputTokens: 100, disabled: true },
      { id: "auto", name: "Auto", maxInputTokens: 960000, maxOutputTokens: 32000, isDefault: true },
      { id: "kling-video-v3", name: "可灵视频", tags: ["text-to-video", "image-to-video"] },
      { id: "glm-5.3", name: "GLM-5.3", contextWindow: 200000, maxOutputTokens: 32768 },
    ],
  },
};

test("workbuddy：模型目录解析（信封 / 能力标记 / 上下文窗口）", async (t) => {
  const captured: Record<string, string | undefined> = {};
  const server = await startServer((req, res) => {
    captured.path = req.url;
    captured.authorization = header(req, "authorization");
    captured.product = header(req, "x-product");
    captured.userId = header(req, "x-user-id");
    captured.domain = header(req, "x-domain");
    captured.origin = header(req, "origin");
    captured.referer = header(req, "referer");
    captured.userAgent = header(req, "user-agent");
    writeJson(res, CATALOG);
  });
  t.after(() => server.close());

  const adapter = new WorkBuddyAdapter();
  const models = await adapter.listModels(wbCred(server));

  assert.equal(captured.path, "/v2/enterprises/personal/models");
  assert.equal(captured.authorization, "Bearer wb-access-token");
  assert.equal(captured.product, "SaaS");
  assert.equal(captured.userId, "uid-1");
  assert.equal(captured.domain, "www.codebuddy.cn");
  assert.equal(captured.origin, "https://www.codebuddy.cn");
  assert.equal(captured.referer, "https://www.codebuddy.cn/");
  assert.equal(captured.userAgent, WORKBUDDY_USER_AGENT);

  // 路由（auto）与视频模型（kling-video-v3）不导入；图片模型保留并打 imageGen。
  assert.deepEqual(
    models.map((model) => model.id),
    ["deepseek-v4.1-flash", "hunyuan-image-alpha", "glm-5.3"],
  );
  for (const model of models) assert.equal(model.provider, "workbuddy");

  const deepseek = models[0];
  assert.ok(deepseek);
  assert.equal(deepseek.name, "DeepSeek V4.1 Flash");
  assert.equal(deepseek.contextWindow, 128000);
  assert.equal(deepseek.maxOutputTokens, 8192);
  assert.equal(deepseek.vision, true);
  assert.equal(deepseek.reasoning, true);
  assert.notEqual(deepseek.imageGen, true);

  const image = models[1];
  assert.ok(image);
  assert.equal(image.imageGen, true);
  assert.equal(image.creditMultiplier, 5.71);

  const glm = models[2];
  assert.ok(glm);
  assert.equal(glm.contextWindow, 200000);
  assert.equal(glm.maxOutputTokens, 32768);
});

test("workbuddy：/v2 模型目录失败时回退 /v3/config 投影 data.models", async (t) => {
  const paths: string[] = [];
  const userAgents: Array<string | undefined> = [];
  const server = await startServer((req, res) => {
    paths.push(req.url ?? "");
    userAgents.push(header(req, "user-agent"));
    if (req.url === "/v2/enterprises/personal/models") {
      writeError(res, 500, { code: 500, msg: "gateway down" });
      return;
    }
    if (req.url === "/v3/config") {
      writeJson(res, {
        code: 0,
        data: {
          models: [
            {
              id: "kimi-k3.1-pro",
              name: "Kimi K3.1 Pro",
              maxInputTokens: 256000,
              maxOutputTokens: 32000,
              supportsImages: true,
            },
          ],
        },
      });
      return;
    }
    writeError(res, 404, { code: 404, msg: "not found" });
  });
  t.after(() => server.close());

  const models = await new WorkBuddyAdapter().listModels(wbCred(server));

  assert.deepEqual(paths, ["/v2/enterprises/personal/models", "/v3/config"]);
  // 主目录走 CLI 形态；备用 /v3/config 必须用 App 形态才能拿到完整目录。
  assert.equal(userAgents[0], WORKBUDDY_USER_AGENT);
  assert.equal(userAgents[1], WORKBUDDY_PRODUCT_USER_AGENT);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "kimi-k3.1-pro");
  assert.equal(models[0]?.contextWindow, 256000);
  assert.equal(models[0]?.vision, true);
});

test("workbuddy：chat SSE 解析（content + reasoning_content + usage）与必需请求头", async (t) => {
  const captured: {
    path?: string;
    authorization?: string;
    contentType?: string;
    accept?: string;
    product?: string;
    userId?: string;
    domain?: string;
    requestedWith?: string;
    origin?: string;
    referer?: string;
    userAgent?: string;
    conversationId?: string;
    conversationRequestId?: string;
    conversationMessageId?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.authorization = header(req, "authorization");
    captured.contentType = header(req, "content-type");
    captured.accept = header(req, "accept");
    captured.product = header(req, "x-product");
    captured.userId = header(req, "x-user-id");
    captured.domain = header(req, "x-domain");
    captured.requestedWith = header(req, "x-requested-with");
    captured.origin = header(req, "origin");
    captured.referer = header(req, "referer");
    captured.userAgent = header(req, "user-agent");
    captured.conversationId = header(req, "x-conversation-id");
    captured.conversationRequestId = header(req, "x-conversation-request-id");
    captured.conversationMessageId = header(req, "x-conversation-message-id");
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      'data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "",
      "data: [DONE]",
      "",
    ]);
  });
  t.after(() => server.close());

  const opts: ChatCallOptions = {
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "只回答：ok" }],
    maxTokens: 64,
    temperature: 0.2,
    effort: "ultra",
  };
  const chunks = await collectChunks(new WorkBuddyAdapter().chat(opts, wbCred(server)));

  assert.equal(captured.path, "/v2/chat/completions");
  assert.equal(captured.authorization, "Bearer wb-access-token");
  assert.equal(captured.contentType, "application/json");
  assert.equal(captured.accept, "text/event-stream");
  assert.equal(captured.product, "SaaS");
  assert.equal(captured.userId, "uid-1");
  assert.equal(captured.domain, "www.codebuddy.cn");
  assert.equal(captured.requestedWith, "XMLHttpRequest");
  assert.equal(captured.origin, "https://www.codebuddy.cn");
  assert.equal(captured.referer, "https://www.codebuddy.cn/");
  assert.equal(captured.userAgent, WORKBUDDY_USER_AGENT);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(captured.conversationId ?? "", uuid);
  assert.match(captured.conversationRequestId ?? "", uuid);
  assert.match(captured.conversationMessageId ?? "", uuid);
  assert.notEqual(captured.conversationId, captured.conversationRequestId);
  assert.notEqual(captured.conversationRequestId, captured.conversationMessageId);

  const body = captured.body;
  assert.ok(body);
  assert.equal(body.model, "deepseek-v4.1-flash");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning_effort, "high", "ultra 应映射为 high");
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: "system", content: "You are a helpful assistant." });
  assert.deepEqual(messages[1], { role: "user", content: "只回答：ok" });

  assert.equal(concatText(chunks), "ok");
  assert.equal(concatReasoning(chunks), "先想一下");
  assert.deepEqual(usageOf(chunks), { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("workbuddy：已有 system 消息时保持在首条（不补占位）", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  await collectChunks(
    new WorkBuddyAdapter().chat(
      {
        provider: "workbuddy",
        model: "deepseek-v4.1-flash",
        system: "你是简洁助手",
        messages: [{ role: "user", content: "hi" }],
      },
      wbCred(server),
    ),
  );

  const messages = body?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages.filter((message) => message.role === "system").length, 1);
  assert.deepEqual(messages[0], { role: "system", content: "你是简洁助手" });
});

test("workbuddy：生图响应解析（url + credit）与请求体", async (t) => {
  const captured: {
    path?: string;
    authorization?: string;
    product?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.authorization = header(req, "authorization");
    captured.product = header(req, "x-product");
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeJson(res, {
      code: 0,
      msg: "",
      data: {
        created: 1794000000,
        data: [{ url: "https://cos.example.com/generated.png" }],
        usage: { credit: 5.71 },
      },
    });
  });
  t.after(() => server.close());

  const result = await new WorkBuddyAdapter().generateImage(
    { model: "hunyuan-image-alpha", prompt: "一只猫" },
    wbCred(server),
  );

  assert.equal(captured.path, "/v2/images/generations");
  assert.equal(captured.authorization, "Bearer wb-access-token");
  assert.equal(captured.product, "SaaS");
  assert.deepEqual(captured.body, {
    model: "hunyuan-image-alpha",
    prompt: "一只猫",
    size: "1024x1024",
    n: 1,
  });
  assert.equal(result.credit, 5.71);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.url, "https://cos.example.com/generated.png");
});

test("workbuddy：生图信封 code≠0 抛可读错误", async (t) => {
  const server = await startServer((req, res) => {
    writeJson(res, { code: 14018, msg: "积分不足，请充值", request_id: "req-1" });
  });
  t.after(() => server.close());

  await assert.rejects(
    new WorkBuddyAdapter().generateImage(
      { model: "hunyuan-image-alpha", prompt: "一只猫" },
      wbCred(server),
    ),
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError, `实际 ${String(err)}`);
      assert.match(err.message, /14018/);
      assert.match(err.message, /积分不足/);
      return true;
    },
  );
});

test("workbuddy：401 抛可读错误并提示重新登录", async (t) => {
  const server = await startServer((req, res) => {
    writeError(res, 401, { code: 401, msg: "token expired" });
  });
  t.after(() => server.close());

  await assert.rejects(
    async () => {
      await collectChunks(
        new WorkBuddyAdapter().chat(
          {
            provider: "workbuddy",
            model: "deepseek-v4.1-flash",
            messages: [{ role: "user", content: "hi" }],
          },
          wbCred(server),
        ),
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof ProviderHttpError, `实际 ${String(err)}`);
      assert.equal(err.status, 401);
      assert.match(err.message, /重新登录/);
      assert.match(err.message, /WorkBuddy/);
      return true;
    },
  );
});

test("workbuddy：validate 缺少 access 返回 ok:false，有 access 则返回模型", async (t) => {
  const server = await startServer((req, res) => {
    writeJson(res, CATALOG);
  });
  t.after(() => server.close());

  const missing = await new WorkBuddyAdapter().validate({ provider: "workbuddy", mode: "token" });
  assert.equal(missing.ok, false);
  assert.match(missing.detail ?? "", /访问令牌/);

  const checked = await new WorkBuddyAdapter().validate(wbCred(server));
  assert.equal(checked.ok, true);
  assert.equal(checked.models?.length, 3);
  assert.ok((checked.detail ?? "").length > 0);
});

test("workbuddy：上游拒绝 reasoning_effort 时去掉字段重试一次", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  let requests = 0;
  const server = await startServer((_req, res, raw) => {
    requests += 1;
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (requests === 1) {
      writeError(res, 400, { code: 400, msg: "unknown field reasoning_effort" });
      return;
    }
    writeSse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}', "", "data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const chunks = await collectChunks(
    new WorkBuddyAdapter().chat(
      {
        provider: "workbuddy",
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        effort: "max",
      },
      wbCred(server),
    ),
  );

  assert.equal(requests, 2, "应先带 effort 请求，被拒后重试一次");
  assert.equal(bodies[0]?.reasoning_effort, "high");
  assert.equal(bodies[1]?.reasoning_effort, undefined);
  assert.equal(concatText(chunks), "ok");
});

test("workbuddy：图片输入映射为 text + image_url（多图有序）", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  await collectChunks(
    new WorkBuddyAdapter().chat(
      {
        provider: "workbuddy",
        model: "glm-4.6v",
        messages: [{ role: "user", content: "看图", images: [png, jpeg] }],
      },
      wbCred(server),
    ),
  );

  const messages = body?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages[1], {
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: png } },
      { type: "image_url", image_url: { url: jpeg } },
    ],
  });
});

test("workbuddy：describeImageWithWorkbuddy 用视觉模型并返回文本", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ['data: {"choices":[{"delta":{"content":"一只猫"}}]}', "", "data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const text = await describeImageWithWorkbuddy(wbCred(server), image, "描述这张图");
  assert.equal(text, "一只猫");
  assert.equal(body?.model, WORKBUDDY_VISION_MODEL);
  const messages = body?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1], {
    role: "user",
    content: [
      { type: "text", text: "描述这张图" },
      { type: "image_url", image_url: { url: image } },
    ],
  });
});
