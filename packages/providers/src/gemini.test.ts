/**
 * Gemini 协议测试：本地假服务器校验 x-goog-api-key、URL 形态、
 * systemInstruction / contents、SSE（每个 data 行一条完整 JSON）、thought parts 与 usageMetadata。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChatCallOptions, Credential, EffortLevel } from "@super-work/core";
import { GeminiAdapter, createAdapter } from "./index.js";
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
  provider: "gemini",
  model: "gemini-3-pro",
  messages: [{ role: "user", content: "你好" }],
  system: "你是助手",
};

function geminiCred(server: TestServer): Credential {
  return {
    provider: "gemini",
    mode: "api-key",
    apiKey: "google-key",
    baseUrl: `${server.url}/v1beta`,
  };
}

function data(payload: unknown): string[] {
  return [`data: ${JSON.stringify(payload)}`, ""];
}

test("gemini：x-goog-api-key + systemInstruction + SSE parts/usage", async (t) => {
  const captured: {
    path?: string;
    apiKey?: string;
    body?: Record<string, unknown>;
  } = {};
  const server = await startServer((req, res, raw) => {
    captured.path = req.url;
    captured.apiKey = typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : undefined;
    captured.body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, [
      ...data({
        candidates: [
          {
            content: {
              parts: [
                { text: "先想一想", thought: true },
                { text: "你好，" },
              ],
            },
          },
        ],
      }),
      ...data({
        candidates: [{ content: { parts: [{ text: "世界" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
          cachedContentTokenCount: 2,
          thoughtsTokenCount: 1,
        },
      }),
    ]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("gemini");
  const chunks = await collectChunks(adapter.chat(BASE_OPTS, geminiCred(server)));

  assert.equal(captured.path, "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse");
  assert.equal(captured.apiKey, "google-key");
  const body = captured.body;
  assert.ok(body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "你是助手" }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "你好" }] }]);

  assert.equal(concatText(chunks), "你好，世界");
  assert.equal(concatReasoning(chunks), "先想一想");
  assert.deepEqual(usageOf(chunks), {
    inputTokens: 9,
    outputTokens: 4,
    totalTokens: 14,
    cachedInputTokens: 2,
    reasoningTokens: 1,
  });
  assert.deepEqual(chunks[chunks.length - 1], { type: "done", stopReason: "end_turn" });
});

test("gemini：token 凭证走 Bearer；listModels 解析 models[]", async (t) => {
  let authorization: string | undefined;
  let apiKey: string | undefined;
  const server = await startServer((req, res) => {
    authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    apiKey = typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : undefined;
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(
      JSON.stringify({
        models: [
          {
            name: "models/gemini-3-pro",
            displayName: "Gemini 3 Pro",
            inputTokenLimit: 1000000,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/text-embedding-004",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      }),
    );
  });
  t.after(() => server.close());

  const adapter = createAdapter("gemini");
  const cred: Credential = {
    provider: "gemini",
    mode: "token",
    pasted: { access: "google-oauth-token", kind: "bearer" },
    baseUrl: `${server.url}/v1beta`,
  };
  const models = await adapter.listModels(cred);
  assert.equal(authorization, "Bearer google-oauth-token");
  assert.equal(apiKey, undefined);
  assert.equal(models.length, 1, "应过滤掉不支持 generateContent 的模型");
  assert.equal(models[0]?.id, "gemini-3-pro");
  assert.equal(models[0]?.name, "Gemini 3 Pro");
  assert.equal(models[0]?.contextWindow, 1000000);
});

test("gemini：5 档 effort → thinkingBudget；旧模型忽略该字段", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  const server = await startServer((_req, res, raw) => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const adapter = createAdapter("gemini");
  const cases: Array<[EffortLevel, number]> = [
    ["low", 0],
    ["medium", 4096],
    ["fast", 8192],
    ["max", 16384],
    ["ultra", 32768],
  ];
  for (const [effort] of cases) {
    await collectChunks(adapter.chat({ ...BASE_OPTS, effort }, geminiCred(server)));
  }
  // 不支持 thinkingBudget 的旧模型：即使选了 ultra 也不带 thinkingConfig。
  await collectChunks(
    adapter.chat({ ...BASE_OPTS, model: "gemini-1.5-pro", effort: "ultra" }, geminiCred(server)),
  );

  cases.forEach(([effort, budget], index) => {
    const generationConfig = bodies[index]?.generationConfig as Record<string, unknown> | undefined;
    assert.deepEqual(
      generationConfig?.thinkingConfig,
      { thinkingBudget: budget },
      `${effort} → thinkingBudget ${budget}`,
    );
  });
  const legacy = bodies[cases.length]?.generationConfig as Record<string, unknown> | undefined;
  assert.equal(legacy?.thinkingConfig, undefined, "旧模型应忽略 thinkingConfig");
});

test("gemini：图片输入映射为 inlineData parts（多图有序）", async (t) => {
  let body: Record<string, unknown> | undefined;
  const server = await startServer((_req, res, raw) => {
    body = JSON.parse(raw) as Record<string, unknown>;
    writeSse(res, ["data: [DONE]", ""]);
  });
  t.after(() => server.close());

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  await collectChunks(
    createAdapter("gemini").chat(
      {
        ...BASE_OPTS,
        messages: [{ role: "user", content: "看图", images: [png, jpeg] }],
      },
      geminiCred(server),
    ),
  );

  assert.deepEqual(body?.contents, [
    {
      role: "user",
      parts: [
        { text: "看图" },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" } },
        { inlineData: { mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" } },
      ],
    },
  ]);
});

test("gemini：无图片时 parts 只有 text（回归）", () => {
  const body = new GeminiAdapter().buildBody(BASE_OPTS);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "你好" }] }]);
});
