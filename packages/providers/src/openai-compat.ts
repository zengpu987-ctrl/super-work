/**
 * OpenAI 兼容协议适配器（`POST {baseUrl}/chat/completions`）。
 *
 * 覆盖 provider：
 *   deepseek / kimi(API key) / openai(API key) / zhipu / qwen /
 *   volcengine / minimax / xai / thirdparty
 *
 * 流式要点（DESIGN §5）：
 * - 请求体固定 `stream: true` + `stream_options: { include_usage: true }`；
 * - delta 里的 `content` 与 `reasoning_content` / `reasoning` 都要解析；
 * - usage 转成 core 的 Usage；
 * - 非 2xx 抛 ProviderHttpError(status, bodySnippet<=300, retryable=status>=429)。
 */
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  EffortLevel,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  Usage,
} from "@super-work/core";
import { EFFORT_BY_ID, PROVIDER_BY_ID, modelsForProvider } from "@super-work/core";
import { ProviderConfigError } from "./errors.js";
import { hasImages, openAIChatContent } from "./images.js";
import { SseChannel, sseChannel } from "./sse.js";
import { validationResultFromError } from "./validation.js";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  errorFromUpstreamPayload,
  fetchOrThrow,
  firstCredentialToken,
  getArray,
  getNumber,
  getProp,
  getString,
  hasUsage,
  joinUrl,
  normalizeOpenAIUsage,
  normalizeProviderError,
  readJsonBody,
  resolveBaseUrl,
} from "./util.js";

export interface OpenAICompatOptions {
  id: ProviderId;
  /** 显式端点（优先级高于 cred.baseUrl，低于单次调用的 opts.baseUrl） */
  baseUrl?: string;
  /** 追加/覆盖模型清单 */
  models?: ModelInfo[];
  timeoutMs?: number;
}

/** 走 OpenAI 兼容协议的 provider。 */
export const OPENAI_COMPAT_PROVIDER_IDS: ProviderId[] = [
  "deepseek",
  "kimi",
  "openai",
  "zhipu",
  "qwen",
  "volcengine",
  "minimax",
  "xai",
  "thirdparty",
];

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 5 档强度 → provider 原生推理档位。
 *
 * low→low，medium/fast→medium，max/ultra→high；与 core 的 EFFORT_BY_ID 一致，
 * 但这里显式返回 `undefined`（不认识档位时不猜）。
 */
export function effortReasoningLevel(
  effort: EffortLevel | undefined,
): "low" | "medium" | "high" | undefined {
  if (!effort) return undefined;
  const mapped = EFFORT_BY_ID[effort]?.reasoning;
  return mapped ?? undefined;
}

/**
 * OpenAI 推理模型（o 系列 / gpt-5+）只接受 `max_completion_tokens`，
 * 普通 chat 模型用 `max_tokens`；两者不同时发送。
 */
export function usesMaxCompletionTokens(model: string): boolean {
  return /(?:^|\/)(o[1-9]|gpt-5)/i.test(model.trim());
}

/**
 * 各家的推理强度参数不同，只在已知支持时透传。
 *
 * `fromEffort` 为 true 表示档位来自 5 档 effort：此时对没有专属参数形式的
 * OpenAI 兼容端点（deepseek / kimi / minimax / relay / thirdparty 等）也透传
 * `reasoning_effort`，让中转站的上游模型能收到强度信号。
 */
export function reasoningExtras(
  id: ProviderId,
  level: "low" | "medium" | "high" | undefined,
  fromEffort = false,
): Record<string, unknown> {
  if (!level) return {};
  switch (id) {
    case "openai":
    case "xai":
    case "relay":
    case "thirdparty":
      return { reasoning_effort: level };
    case "zhipu":
    case "volcengine":
      return { thinking: { type: level === "low" ? "disabled" : "enabled" } };
    case "qwen":
      return { enable_thinking: level !== "low" };
    default:
      // deepseek / kimi / minimax：普通 reasoning 由模型自己决定；
      // 显式 5 档 effort 时也透传 reasoning_effort（多数 OpenAI 兼容端点会忽略未知字段）。
      return fromEffort ? { reasoning_effort: level } : {};
  }
}

export function mapOpenAIStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || !reason) return undefined;
  switch (reason) {
    case "stop":
    case "end_turn":
      return "end_turn";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return reason;
  }
}

/**
 * 解析 OpenAI 兼容协议的 SSE 流（`choices[0].delta.content` + `reasoning_content` + usage）。
 *
 * 抽成独立函数是为了让 relay / workbuddy 等适配器复用同一套解析逻辑，
 * 避免各家各写一份后行为漂移。`provider` 只用于错误归属。
 */
export async function* openaiCompatChunks(
  channel: SseChannel,
  provider: ProviderId,
): AsyncGenerator<ChatChunk> {
  let stopReason: string | undefined;
  let usage: Usage | undefined;
  for await (const message of channel.messages()) {
    const data = message.data;
    if (!data || data.trim() === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      continue; // 跳过多余的 keep-alive / 非 JSON 行
    }
    if (getProp(payload, "error") !== undefined) {
      throw errorFromUpstreamPayload(payload, provider);
    }

    const choices = getArray(payload, "choices");
    const choice = choices && choices.length > 0 ? choices[0] : undefined;
    if (choice !== undefined) {
      const delta = getProp(choice, "delta");
      const messageBody = getProp(choice, "message");
      const source =
        delta !== undefined && delta !== null && Object.keys(delta as object).length > 0
          ? delta
          : messageBody;
      const reasoning = firstNonEmptyString(
        getProp(source, "reasoning_content"),
        getProp(source, "reasoning"),
        getProp(source, "thinking"),
      );
      if (reasoning) yield { type: "reasoning", text: reasoning };
      const content = getString(source, "content");
      if (content) yield { type: "text", text: content };
      const finish = getString(choice, "finish_reason") ?? getString(choice, "finishReason");
      if (finish) stopReason = finish;
    }

    const rawUsage = getProp(payload, "usage");
    if (rawUsage && typeof rawUsage === "object") {
      const mapped = normalizeOpenAIUsage(rawUsage);
      if (hasUsage(mapped)) usage = mapped;
    }
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "done", stopReason: mapOpenAIStopReason(stopReason) };
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly kind = "openai-compat" as const;
  protected readonly configuredBaseUrl?: string;
  protected readonly extraModels: ModelInfo[];
  protected readonly timeoutMs: number;

  constructor(options: OpenAICompatOptions) {
    const meta = PROVIDER_BY_ID[options.id];
    this.id = options.id;
    this.name = meta?.name ?? options.id;
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  protected baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return resolveBaseUrl(
      this.id,
      callBaseUrl?.trim() || this.configuredBaseUrl,
      cred?.baseUrl,
    );
  }

  protected requireToken(cred: Credential | null): string | undefined {
    const token = firstCredentialToken(cred);
    if (!token && this.id !== "thirdparty") {
      throw new ProviderConfigError(
        `${this.id} 缺少凭证：请在设置里填写 API key，或粘贴可用的 token`,
        { provider: this.id },
      );
    }
    return token;
  }

  protected authHeaders(cred: Credential | null, token: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (cred?.pasted?.extraHeaders) Object.assign(headers, cred.pasted.extraHeaders);
    return headers;
  }

  /** 组装请求体（导出便于测试与排查）。 */
  buildBody(opts: ChatCallOptions): Record<string, unknown> {
    const messages: Array<{
      role: string;
      content: string | Array<Record<string, unknown>>;
    }> = [];
    const systemParts: string[] = [];
    if (opts.system?.trim()) systemParts.push(opts.system.trim());
    for (const message of opts.messages) {
      if (message.role === "system") systemParts.push(message.content);
      else if (message.content !== "" || hasImages(message)) {
        messages.push({ role: message.role, content: openAIChatContent(message) });
      }
    }
    if (messages.length === 0) {
      throw new ProviderConfigError(`${this.id} 调用至少需要一条 user 消息`, {
        provider: this.id,
      });
    }
    if (systemParts.length > 0) {
      messages.unshift({ role: "system", content: systemParts.join("\n\n") });
    }

    const effortLevel = effortReasoningLevel(opts.effort);
    const body: Record<string, unknown> = {
      ...reasoningExtras(
        this.id,
        effortLevel ?? opts.reasoning,
        opts.effort !== undefined,
      ),
      ...(opts.extras ?? {}),
      model: opts.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    // max_tokens 一律使用调用方传入值（orchestrator 已按档位放大，这里不再二次放大）。
    if (opts.maxTokens !== undefined) {
      if (usesMaxCompletionTokens(opts.model)) body.max_completion_tokens = opts.maxTokens;
      else body.max_tokens = opts.maxTokens;
    }
    // o 系列 / gpt-5+ 只接受默认 temperature，传了会被上游 400 拒绝。
    if (opts.temperature !== undefined && usesMaxCompletionTokens(opts.model)) delete body.temperature;
    return body;
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    const base = this.baseFor(cred);
    const token = this.requireToken(cred);
    const url = joinUrl(base, "/models");
    const ctx = createCallContext(this.id, url, { timeoutMs: this.timeoutMs });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "GET",
        headers: this.authHeaders(cred, token),
      });
      const json = await readJsonBody(res, this.id);
      const rows = getArray(json, "data") ?? getArray(json, "models") ?? [];
      const models: ModelInfo[] = [];
      for (const row of rows) {
        const id = getString(row, "id") ?? getString(row, "name");
        if (!id) continue;
        const display = getString(row, "display_name") ?? getString(row, "displayName") ?? id;
        const contextWindow =
          getNumber(row, "context_window") ??
          getNumber(row, "context_length") ??
          getNumber(row, "max_context_length");
        const maxOutputTokens = getNumber(row, "max_output_tokens");
        const model: ModelInfo = { id, name: display, provider: this.id };
        if (contextWindow !== undefined) model.contextWindow = contextWindow;
        if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
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
    const token = this.requireToken(cred);
    const url = joinUrl(base, "/chat/completions");
    const ctx = createCallContext(this.id, url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers: this.authHeaders(cred, token),
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

  protected async *iterate(channel: SseChannel): AsyncGenerator<ChatChunk> {
    yield* openaiCompatChunks(channel, this.id);
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    try {
      const models = await this.listModels(cred);
      return {
        ok: true,
        detail: models.length > 0 ? `连接成功，可用模型 ${models.length} 个` : "连接成功（端点未返回模型列表）",
        models,
      };
    } catch (err) {
      return validationResultFromError(err);
    }
  }
}

/** 与 createAdapter 的 openai-compat 分支等价的便捷工厂。 */
export function createOpenAICompatAdapter(
  id: ProviderId,
  options: Omit<OpenAICompatOptions, "id"> = {},
): OpenAICompatAdapter {
  return new OpenAICompatAdapter({ id, ...options });
}

/** 供 mock / 其它模块复用的模型清单。 */
export function catalogModels(
  id: ProviderId,
  extras: ModelInfo[] = [],
): ModelInfo[] {
  return modelsForProvider(id, extras);
}
