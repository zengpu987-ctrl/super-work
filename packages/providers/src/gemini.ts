/**
 * Google Gemini 适配器（`POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`）。
 *
 * 协议要点（DESIGN §5）：
 * - 鉴权：`x-goog-api-key`（API key），或 `authorization: Bearer`（pasted / oauth）；
 * - system 走 `systemInstruction`，对话走 `contents`（assistant → role "model"）；
 * - 每个 SSE data 行就是一条完整的 GenerateContentResponse JSON；
 * - 解析 `candidates[].content.parts[].text`、`usageMetadata`；
 * - `part.thought === true` 视为推理内容。
 */
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  EffortLevel,
  ModelInfo,
  ProviderAdapter,
  Usage,
} from "@super-work/core";
import { ProviderHttpError, ProviderConfigError } from "./errors.js";
import { geminiParts, hasImages } from "./images.js";
import { SseChannel, sseChannel } from "./sse.js";
import { validationResultFromError } from "./validation.js";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  credentialAuth,
  errorFromUpstreamPayload,
  fetchOrThrow,
  getArray,
  getNumber,
  getProp,
  getString,
  hasUsage,
  joinUrl,
  normalizeProviderError,
  readJsonBody,
  resolveBaseUrl,
} from "./util.js";

export interface GeminiAdapterOptions {
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
}

export function normalizeGeminiUsage(raw: unknown): Usage {
  const usage: Usage = {};
  const input = getNumber(raw, "promptTokenCount");
  const output = getNumber(raw, "candidatesTokenCount");
  const total = getNumber(raw, "totalTokenCount");
  const cached = getNumber(raw, "cachedContentTokenCount");
  const reasoning = getNumber(raw, "thoughtsTokenCount");
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  else if (input !== undefined || output !== undefined)
    usage.totalTokens = (input ?? 0) + (output ?? 0);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

export function mapGeminiFinishReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || !reason) return undefined;
  switch (reason.toUpperCase()) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return reason.toLowerCase();
  }
}

/**
 * 5 档 effort → Gemini thinkingBudget。
 * low 传 0（关闭思考），medium/fast/max/ultra 逐级放大。
 */
const GEMINI_THINKING_BUDGET: Record<EffortLevel, number> = {
  low: 0,
  medium: 4096,
  fast: 8192,
  max: 16384,
  ultra: 32768,
};

/** 只有 Gemini 2.5 / 3 / 4 系列支持 thinkingBudget；旧模型忽略该字段。 */
export function supportsGeminiThinkingBudget(model: string): boolean {
  return /gemini-(?:2\.5|3|4)/i.test(model.trim());
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  readonly name: string;
  readonly kind = "gemini" as const;
  private readonly configuredBaseUrl?: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;

  constructor(options: GeminiAdapterOptions = {}) {
    this.name = "Gemini";
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return resolveBaseUrl("gemini", callBaseUrl?.trim() || this.configuredBaseUrl, cred?.baseUrl);
  }

  /** API key 走 x-goog-api-key；token 走 Bearer。 */
  private authHeaders(cred: Credential | null, accept = "text/event-stream"): Record<string, string> {
    const auth = credentialAuth(cred);
    const headers: Record<string, string> = { "content-type": "application/json", accept };
    if (auth.apiKey) headers["x-goog-api-key"] = auth.apiKey;
    else if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    else {
      throw new ProviderConfigError(
        "gemini 缺少凭证：请填写 API key，或粘贴 Google OAuth access token",
      );
    }
    if (auth.extraHeaders) Object.assign(headers, auth.extraHeaders);
    return headers;
  }

  /** 组装 generateContent 请求体（导出便于测试）。 */
  buildBody(opts: ChatCallOptions): Record<string, unknown> {
    const contents: Array<{
      role: "user" | "model";
      parts: Array<Record<string, unknown>>;
    }> = [];
    const systemParts: string[] = [];
    if (opts.system?.trim()) systemParts.push(opts.system.trim());
    for (const message of opts.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.content === "" && !hasImages(message)) continue;
      const parts = geminiParts(message);
      if (parts.length === 0) continue;
      const role = message.role === "assistant" ? "model" : "user";
      const previous = contents[contents.length - 1];
      if (previous && previous.role === role) {
        // Gemini 要求 user/model 交替：把连续同角色消息并进同一个 content 的多个 part
        previous.parts.push(...parts);
        continue;
      }
      contents.push({ role, parts });
    }
    if (contents.length === 0) {
      throw new ProviderConfigError("gemini 调用至少需要一条 user 消息", { provider: "gemini" });
    }

    const body: Record<string, unknown> = {
      ...(opts.extras ?? {}),
      contents,
    };
    if (systemParts.length > 0) {
      body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    // maxOutputTokens 直接使用调用方传入值（orchestrator 已按档位放大）。
    if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens;
    if (opts.effort && supportsGeminiThinkingBudget(opts.model)) {
      generationConfig.thinkingConfig = {
        thinkingBudget: GEMINI_THINKING_BUDGET[opts.effort],
      };
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return body;
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    const base = this.baseFor(cred);
    const url = joinUrl(base, "/models?pageSize=1000");
    const ctx = createCallContext(this.id, url, { timeoutMs: this.timeoutMs });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "GET",
        headers: { ...this.authHeaders(cred, "application/json") },
      });
      const json = await readJsonBody(res, this.id);
      const rows = getArray(json, "models") ?? [];
      const models: ModelInfo[] = [];
      for (const row of rows) {
        const raw = getString(row, "name");
        if (!raw) continue;
        const id = raw.replace(/^models\//, "");
        const methods = getArray(row, "supportedGenerationMethods");
        if (methods && methods.length > 0 && !methods.includes("generateContent")) continue;
        const model: ModelInfo = {
          id,
          name: getString(row, "displayName") ?? id,
          provider: this.id,
        };
        const contextWindow = getNumber(row, "inputTokenLimit");
        if (contextWindow !== undefined) model.contextWindow = contextWindow;
        const maxOutput = getNumber(row, "outputTokenLimit");
        if (maxOutput !== undefined) model.maxOutputTokens = maxOutput;
        if (/thinking|reason/i.test(id) || getProp(row, "thinking") === true) model.reasoning = true;
        models.push(model);
      }
      const seen = new Set(models.map((model) => model.id));
      return [...models, ...this.extraModels.filter((model) => !seen.has(model.id))];
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const base = this.baseFor(cred, opts.baseUrl);
    const modelPath = opts.model.replace(/^models\//, "");
    const url = `${joinUrl(base, `/models/${encodeURIComponent(modelPath)}:streamGenerateContent`)}?alt=sse`;
    const headers = this.authHeaders(cred);
    const ctx = createCallContext(this.id, url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildBody(opts)),
      });
      channel = sseChannel(res.body, { signal: ctx.signal });
      yield* this.iterate(channel);
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      await channel?.cancel();
      ctx.dispose();
    }
  }

  private async *iterate(channel: SseChannel): AsyncGenerator<ChatChunk> {
    let stopReason: string | undefined;
    let usage: Usage | undefined;

    const handlePayload = function* (payload: unknown): Generator<ChatChunk> {
      if (getProp(payload, "error") !== undefined) {
        throw errorFromUpstreamPayload(payload, "gemini");
      }
      const blocked = getString(getProp(payload, "promptFeedback"), "blockReason");
      if (blocked) {
        throw new ProviderHttpError(400, `promptFeedback.blockReason=${blocked}`, false, {
          provider: "gemini",
          message: `Gemini 拒绝了该请求：${blocked}`,
        });
      }
      const candidates = getArray(payload, "candidates");
      const candidate = candidates && candidates.length > 0 ? candidates[0] : undefined;
      if (candidate !== undefined) {
        const parts = getArray(getProp(candidate, "content"), "parts");
        if (parts) {
          for (const part of parts) {
            const text = getString(part, "text");
            if (!text) continue;
            if (getProp(part, "thought") === true) yield { type: "reasoning", text };
            else yield { type: "text", text };
          }
        }
        const finish = getString(candidate, "finishReason");
        if (finish) stopReason = finish;
      }
      const rawUsage = getProp(payload, "usageMetadata");
      if (rawUsage && typeof rawUsage === "object") {
        const mapped = normalizeGeminiUsage(rawUsage);
        if (hasUsage(mapped)) usage = mapped; // usageMetadata 是累计值，取最后一条
      }
    };

    for await (const message of channel.messages()) {
      const data = message.data;
      if (!data || data.trim() === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        continue;
      }
      if (Array.isArray(payload)) {
        for (const item of payload) yield* handlePayload(item);
      } else {
        yield* handlePayload(payload);
      }
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "done", stopReason: mapGeminiFinishReason(stopReason) };
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    try {
      const models = await this.listModels(cred);
      return {
        ok: true,
        detail: models.length > 0 ? `连接成功，可用模型 ${models.length} 个` : "连接成功",
        models,
      };
    } catch (err) {
      return validationResultFromError(err);
    }
  }
}

export function createGeminiAdapter(options: GeminiAdapterOptions = {}): GeminiAdapter {
  return new GeminiAdapter(options);
}

/** 未使用但保留：便于将来把几何/图片输入转成 Gemini parts。 */
export function geminiInlinePart(mimeType: string, base64: string): Record<string, unknown> {
  return { inlineData: { mimeType, data: base64 } };
}
