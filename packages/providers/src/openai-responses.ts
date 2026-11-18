/**
 * ChatGPT 订阅适配器（OpenAI Responses / Codex 后端）。
 *
 * 适用凭证（由 index.ts 的 adapterForCall 判定）：
 *   cred.mode === "oauth-browser"，或来源为本机复用的 ChatGPT 登录态（source=local + oauth）。
 *
 * 端点：`POST {baseUrl}/responses`，默认 baseUrl = https://chatgpt.com/backend-api/codex
 * 必需头：authorization: Bearer <access>、chatgpt-account-id、OpenAI-Beta: responses=experimental、
 *         originator: super_work、content-type: application/json
 * 请求体：{ model, instructions, input, stream: true, store: false }
 * SSE：response.output_text.delta / response.reasoning_summary_text.delta /
 *      response.completed(usage) / response.failed(抛错)
 */
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  ModelInfo,
  ProviderAdapter,
} from "@super-work/core";
import { EFFORT_BY_ID, PROVIDER_BY_ID, modelsForProvider } from "@super-work/core";
import { ProviderConfigError } from "./errors.js";
import { hasImages, responsesContent } from "./images.js";
import { SseChannel, sseChannel } from "./sse.js";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  errorFromUpstreamPayload,
  fetchOrThrow,
  getArray,
  getNumber,
  getProp,
  getString,
  hasUsage,
  joinUrl,
  normalizeOpenAIUsage,
  normalizeProviderError,
  readJsonBody,
} from "./util.js";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Codex 目录接口要求带 client_version 查询参数，否则返回 400
 * `{'type': 'missing', 'loc': ('query', 'client_version')}`。
 */
export const CODEX_CLIENT_VERSION = "1.0.0";

export interface OpenAIResponsesOptions {
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
}

function accessTokenOf(cred: Credential | null): string | undefined {
  return cred?.oauth?.access?.trim() || cred?.pasted?.access?.trim() || undefined;
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly name: string;
  readonly kind = "openai-responses" as const;
  private readonly configuredBaseUrl?: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;

  constructor(options: OpenAIResponsesOptions = {}) {
    this.name = `${PROVIDER_BY_ID.openai?.name ?? "GPT / OpenAI"}（ChatGPT 订阅）`;
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private baseFor(cred: Credential | null, callBaseUrl?: string): string {
    const explicit = callBaseUrl?.trim() || this.configuredBaseUrl;
    return explicit || cred?.baseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
  }

  private endpointFor(cred: Credential | null, callBaseUrl?: string): string {
    const base = this.baseFor(cred, callBaseUrl);
    return /\/responses$/.test(base) ? base : joinUrl(base, "/responses");
  }

  private requireAccess(cred: Credential | null): string {
    const access = accessTokenOf(cred);
    if (!access) {
      throw new ProviderConfigError(
        "openai 订阅缺少访问令牌：请先完成 ChatGPT OAuth 登录，或从本机已登录账户导入",
        { provider: this.id },
      );
    }
    return access;
  }

  private headers(cred: Credential | null, access: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${access}`,
      "openai-beta": "responses=experimental",
      originator: "super_work",
    };
    const accountId = cred?.oauth?.accountId?.trim() || cred?.pasted?.extraHeaders?.["chatgpt-account-id"];
    if (accountId) headers["chatgpt-account-id"] = accountId;
    if (cred?.pasted?.extraHeaders) Object.assign(headers, cred.pasted.extraHeaders);
    return headers;
  }

  /** 组装 Responses 请求体（导出便于测试）。 */
  buildBody(opts: ChatCallOptions): Record<string, unknown> {
    const systemParts: string[] = [];
    if (opts.system?.trim()) systemParts.push(opts.system.trim());
    const input: Array<Record<string, unknown>> = [];
    for (const message of opts.messages) {
      if (message.role === "system") {
        systemParts.push(message.content);
        continue;
      }
      if (message.content === "" && !hasImages(message)) continue;
      const content = responsesContent(message);
      if (content.length === 0) continue;
      input.push({
        type: "message",
        role: message.role,
        content,
      });
    }
    if (input.length === 0) {
      throw new ProviderConfigError("openai 订阅调用至少需要一条 user 消息", {
        provider: this.id,
      });
    }

    const body: Record<string, unknown> = {
      ...(opts.extras ?? {}),
      model: opts.model,
      input,
      stream: true,
      store: false,
    };
    if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");
    if (opts.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
    // Codex 后端（chatgpt.com/backend-api/codex）不接受 temperature：
    // 传了会被 400 拒绝 `{"detail":"Unsupported parameter: temperature"}`，
    // 所以订阅通道一律不下发该参数（档位差异由 reasoning.effort 表达）。
    // 5 档 effort 优先映射为 Responses 的 reasoning.effort（low/medium/high）。
    const effortReasoning = opts.effort ? EFFORT_BY_ID[opts.effort]?.reasoning : undefined;
    if (effortReasoning) body.reasoning = { effort: effortReasoning };
    else if (opts.reasoning) body.reasoning = { effort: opts.reasoning };
    return body;
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    // ChatGPT 订阅没有 /models 探测端点：用 catalog 中的订阅模型（外加手动添加项）。
    if (!accessTokenOf(cred)) {
      throw new ProviderConfigError(
        "openai 订阅缺少访问令牌：请先完成 ChatGPT OAuth 登录，或从本机已登录账户导入",
        { provider: this.id },
      );
    }
    const all = modelsForProvider("openai", this.extraModels);
    const subscription = all.filter((model) => model.via !== "api");
    return subscription.length > 0 ? subscription : all;
  }

  /**
   * 实时订阅模型目录：`GET {base}/models?client_version=…`。
   *
   * 与 `listModels`（catalog 兜底、离线可用）分开：只有「更新模型」这类显式动作
   * 才走网络，导入/校验保持秒级、不受网络影响。
   */
  async discoverModels(cred: Credential | null, callBaseUrl?: string): Promise<ModelInfo[]> {
    const access = this.requireAccess(cred);
    const url = `${joinUrl(this.baseFor(cred, callBaseUrl), "/models")}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
    const ctx = createCallContext(this.id, url, { timeoutMs: this.timeoutMs });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "GET",
        headers: this.headers(cred, access),
      });
      const json = await readJsonBody(res, this.id);
      const rows = getArray(json, "models") ?? getArray(json, "data") ?? [];
      const models: ModelInfo[] = [];
      for (const row of rows) {
        const id = getString(row, "slug") ?? getString(row, "id");
        if (!id) continue;
        const visibility = getString(row, "visibility");
        if (visibility && visibility !== "list") continue;
        const name = getString(row, "display_name") ?? getString(row, "name") ?? id;
        const contextWindow =
          getNumber(row, "context_window") ?? getNumber(row, "max_context_window");
        const modalities = (getProp(row, "input_modalities") as unknown[] | undefined) ?? [];
        const levels = getArray(row, "supported_reasoning_levels") ?? [];
        const model: ModelInfo = {
          id,
          name,
          provider: "openai",
          via: "subscription",
          reasoning: levels.length > 0,
          vision: Array.isArray(modalities) && modalities.includes("image"),
        };
        if (contextWindow !== undefined) model.contextWindow = contextWindow;
        models.push(model);
      }
      return models.length > 0 ? models : this.listModels(cred);
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const url = this.endpointFor(cred, opts.baseUrl);
    const access = this.requireAccess(cred);
    const ctx = createCallContext(this.id, url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers: this.headers(cred, access),
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
    let doneEmitted = false;
    let stopReason: string | undefined;

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
        case "response.output_text.delta": {
          const delta = getString(payload, "delta");
          if (delta) yield { type: "text", text: delta };
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
        case "response.reasoning.delta": {
          const delta = getString(payload, "delta");
          if (delta) yield { type: "reasoning", text: delta };
          break;
        }
        case "response.output_text.done": {
          // 文本已经通过 delta 逐块下发；这里只用于吞掉该事件，避免重复
          break;
        }
        case "response.completed": {
          const usage = normalizeOpenAIUsage(
            getProp(getProp(payload, "response"), "usage") ?? getProp(payload, "usage"),
          );
          if (hasUsage(usage)) yield { type: "usage", usage };
          const responseObj = getProp(payload, "response");
          const rawStop =
            getString(responseObj, "status") ?? getString(getProp(responseObj, "incomplete_details"), "reason");
          if (rawStop === "incomplete") stopReason = "max_tokens";
          yield { type: "done", stopReason: stopReason ?? "end_turn" };
          doneEmitted = true;
          break outer;
        }
        case "response.incomplete": {
          const usage = normalizeOpenAIUsage(
            getProp(getProp(payload, "response"), "usage") ?? getProp(payload, "usage"),
          );
          if (hasUsage(usage)) yield { type: "usage", usage };
          yield { type: "done", stopReason: "max_tokens" };
          doneEmitted = true;
          break outer;
        }
        case "response.failed": {
          const nestedError =
            getProp(getProp(payload, "response"), "error") ??
            getProp(payload, "error") ??
            getProp(payload, "response") ??
            payload;
          throw errorFromUpstreamPayload(nestedError, this.id, "ChatGPT 订阅返回失败");
        }
        case "error": {
          throw errorFromUpstreamPayload(payload, this.id, "ChatGPT 订阅流返回错误");
        }
        default:
          break;
      }
    }

    if (!doneEmitted) {
      yield { type: "done", stopReason };
    }
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    const access = accessTokenOf(cred);
    if (!access) {
      return { ok: false, detail: "缺少访问令牌：请先完成 ChatGPT OAuth 登录" };
    }
    if (cred.oauth?.expiresAt !== undefined && cred.oauth.expiresAt < Date.now()) {
      return { ok: false, detail: "访问令牌已过期，请重新登录或刷新 token" };
    }
    try {
      const models = await this.listModels(cred);
      return {
        ok: true,
        detail: "订阅凭证已就绪（实际可用性在调用时由 ChatGPT 后端校验）",
        models,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createOpenAIResponsesAdapter(
  options: OpenAIResponsesOptions = {},
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter(options);
}

/** 单测/调试用：把 base 归一成 /responses 端点（空值回落到 Codex 默认端点）。 */
export function responsesEndpoint(baseUrl?: string): string {
  const base = baseUrl?.trim() || DEFAULT_CODEX_BASE_URL;
  return /\/responses$/.test(base) ? base : joinUrl(base, "/responses");
}
