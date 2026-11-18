/**
 * Anthropic Messages 协议适配器（`POST {baseUrl}/messages`）。
 *
 * 覆盖：anthropic（API key / 粘贴 token / OAuth bearer）。
 * Kimi 会员订阅复用同一套 SSE 解析（见 kimi-subscription.ts）。
 *
 * 协议要点（DESIGN §5）：
 * - headers：`x-api-key`（API key）或 `authorization: Bearer`（pasted / oauth），
 *   固定 `anthropic-version: 2023-06-01`；
 * - system 是独立字段，不能混在 messages 里；
 * - SSE：`message_start`(input_tokens) → `content_block_delta`(text_delta / thinking_delta)
 *   → `message_delta`(output_tokens) → `message_stop`。
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
import { PROVIDER_BY_ID } from "@super-work/core";
import { ProviderConfigError } from "./errors.js";
import { anthropicContent, hasImages } from "./images.js";
import { SseChannel, sseChannel } from "./sse.js";
import { validationResultFromError } from "./validation.js";
import {
  DEFAULT_TIMEOUT_MS,
  type CallContext,
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

export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicAdapterOptions {
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
}

/** Anthropic 协议鉴权头（API key 走 x-api-key，token 走 Bearer）。 */
export function anthropicAuthHeaders(cred: Credential | null): Record<string, string> {
  const auth = credentialAuth(cred);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
  else if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  else {
    throw new ProviderConfigError(
      "anthropic 缺少凭证：请填写 API key，或粘贴 Claude Code 的 OAuth token",
      { provider: "anthropic" },
    );
  }
  if (auth.extraHeaders) Object.assign(headers, auth.extraHeaders);
  return headers;
}

/**
 * 5 档 effort → extended thinking budget（Anthropic 协议）。
 *
 * low 不启用 thinking；medium/fast 用中等预算；max/ultra 用大预算。
 * 上游要求 max_tokens > budget_tokens，因此启用 thinking 时会把 max_tokens
 * 抬到预算之上（其余档位仍使用调用方传入值）。
 */
const ANTHROPIC_THINKING_BUDGET: Partial<Record<EffortLevel, number>> = {
  medium: 8192,
  fast: 4096,
  max: 16384,
  ultra: 32768,
};

/** 组装 Anthropic Messages 请求体（Kimi 订阅复用）。 */
export function buildAnthropicBody(
  opts: ChatCallOptions,
  provider: ProviderId,
  defaultMaxTokens: number,
): Record<string, unknown> {
  const messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }> = [];
  const systemParts: string[] = [];
  if (opts.system?.trim()) systemParts.push(opts.system.trim());
  for (const message of opts.messages) {
    if (message.role === "system") systemParts.push(message.content);
    else if (message.content !== "" || hasImages(message)) {
      const content = anthropicContent(message);
      if (content === "" || (Array.isArray(content) && content.length === 0)) continue;
      messages.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content,
      });
    }
  }
  if (messages.length === 0) {
    throw new ProviderConfigError(`${provider} 调用至少需要一条 user 消息`, { provider });
  }

  const requestedMaxTokens = opts.maxTokens ?? defaultMaxTokens;
  const thinkingBudget = opts.effort ? ANTHROPIC_THINKING_BUDGET[opts.effort] : undefined;

  const body: Record<string, unknown> = {
    ...(opts.extras ?? {}),
    model: opts.model,
    max_tokens: thinkingBudget !== undefined
      ? Math.max(requestedMaxTokens, thinkingBudget + 1024)
      : requestedMaxTokens,
    messages,
    stream: true,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (thinkingBudget !== undefined) {
    // 官方要求：启用 thinking 时 temperature 只能为默认值（不传）。
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  } else if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }
  return body;
}

interface AnthropicUsageState {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

function readAnthropicUsage(raw: unknown, state: AnthropicUsageState): void {
  const input = getNumber(raw, "input_tokens");
  const output = getNumber(raw, "output_tokens");
  const cacheRead = getNumber(raw, "cache_read_input_tokens");
  const cacheCreate = getNumber(raw, "cache_creation_input_tokens");
  if (input !== undefined) state.inputTokens = input;
  // message_delta 里的 output_tokens 是"累计值"，直接覆盖而不是相加
  if (output !== undefined) state.outputTokens = output;
  if (cacheRead !== undefined) state.cachedInputTokens = cacheRead;
  else if (cacheCreate !== undefined) state.cachedInputTokens = cacheCreate;
}

function usageFromState(state: AnthropicUsageState): Usage {
  const usage: Usage = {};
  if (state.inputTokens !== undefined) usage.inputTokens = state.inputTokens;
  if (state.outputTokens !== undefined) usage.outputTokens = state.outputTokens;
  if (state.cachedInputTokens !== undefined) usage.cachedInputTokens = state.cachedInputTokens;
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage;
}

export function mapAnthropicStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || !reason) return undefined;
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_calls";
    default:
      return reason;
  }
}

/**
 * 解析 Anthropic 风格的 SSE 流（含 Kimi 订阅）。
 * 调用方持有 channel 并负责在 finally 里 cancel()。
 */
export async function* streamAnthropicChannel(
  channel: SseChannel,
  ctx: CallContext,
): AsyncGenerator<ChatChunk> {
  const usageState: AnthropicUsageState = {};
  let stopReason: string | undefined;
  let usageEmitted = false;
  outer: for await (const message of channel.messages()) {
    const data = message.data;
    if (!data || data.trim() === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    const type = getString(payload, "type") ?? message.event;
    if (!type) continue;

    switch (type) {
      case "message_start": {
        readAnthropicUsage(getProp(getProp(payload, "message"), "usage"), usageState);
        break;
      }
      case "content_block_start": {
        // 非标准实现偶尔把首块文本放在这里，兼容处理
        const text = getString(getProp(payload, "content_block"), "text");
        if (text) yield { type: "text", text };
        break;
      }
      case "content_block_delta": {
        const delta = getProp(payload, "delta");
        const deltaType = getString(delta, "type");
        if (deltaType === "thinking_delta" || deltaType === "reasoning_delta") {
          const thinking = getString(delta, "thinking") ?? getString(delta, "text");
          if (thinking) yield { type: "reasoning", text: thinking };
        } else {
          const text = getString(delta, "text");
          if (text) yield { type: "text", text };
        }
        break;
      }
      case "message_delta": {
        readAnthropicUsage(getProp(payload, "usage"), usageState);
        const rawStop =
          getString(getProp(payload, "delta"), "stop_reason") ?? getString(payload, "stop_reason");
        if (rawStop) stopReason = rawStop;
        const usage = usageFromState(usageState);
        if (!usageEmitted && hasUsage(usage)) {
          yield { type: "usage", usage };
          usageEmitted = true;
        }
        break;
      }
      case "message_stop": {
        break outer;
      }
      case "error": {
        throw errorFromUpstreamPayload(payload, ctx.provider, "流式响应返回错误");
      }
      case "ping":
      default:
        break;
    }
  }
  if (!usageEmitted) {
    const usage = usageFromState(usageState);
    if (hasUsage(usage)) yield { type: "usage", usage };
  }
  yield { type: "done", stopReason: mapAnthropicStopReason(stopReason) };
}

/** 便捷入口：直接从 Response 解析，内部持有并释放 SseChannel。 */
export async function* streamAnthropicResponse(
  res: Response,
  ctx: CallContext,
): AsyncGenerator<ChatChunk> {
  const channel = sseChannel(res.body, { signal: ctx.signal });
  try {
    yield* streamAnthropicChannel(channel, ctx);
  } finally {
    await channel.cancel();
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: ProviderId = "anthropic";
  readonly name: string;
  readonly kind = "anthropic" as const;
  private readonly configuredBaseUrl?: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.name = PROVIDER_BY_ID.anthropic?.name ?? "Claude";
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = 4096;
  }

  private baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return resolveBaseUrl(
      this.id,
      callBaseUrl?.trim() || this.configuredBaseUrl,
      cred?.baseUrl,
    );
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    const base = this.baseFor(cred);
    const url = joinUrl(base, "/models?limit=1000");
    const ctx = createCallContext(this.id, url, { timeoutMs: this.timeoutMs });
    try {
      const headers = { ...anthropicAuthHeaders(cred), accept: "application/json" };
      const res = await fetchOrThrow(ctx, { method: "GET", headers });
      const json = await readJsonBody(res, this.id);
      const rows = getArray(json, "data") ?? [];
      const models: ModelInfo[] = [];
      for (const row of rows) {
        const id = getString(row, "id");
        if (!id) continue;
        const display = getString(row, "display_name") ?? id;
        const model: ModelInfo = { id, name: display, provider: this.id };
        const contextWindow = getNumber(row, "context_window");
        if (contextWindow !== undefined) model.contextWindow = contextWindow;
        if (/thinking|reason/i.test(id)) model.reasoning = true;
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
    const url = joinUrl(base, "/messages");
    const headers = anthropicAuthHeaders(cred);
    const ctx = createCallContext(this.id, url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers,
        body: JSON.stringify(buildAnthropicBody(opts, this.id, this.defaultMaxTokens)),
      });
      channel = sseChannel(res.body, { signal: ctx.signal });
      yield* streamAnthropicChannel(channel, ctx);
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      await channel?.cancel();
      ctx.dispose();
    }
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

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): AnthropicAdapter {
  return new AnthropicAdapter(options);
}
