/**
 * DeepSeek 账户（DSH）适配器。
 *
 * 使用 DSH 的 DeepSeek Account 登录态：`x-dsh-auth-token` 请求
 * `https://api.deepseek.com/anthropic/v1/messages`（Anthropic Messages 协议）。
 * 模型 ID `deepseek-flash` 即 DSH 目录中的 V4.1 Flash（1M 上下文 / 多模态）。
 */
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from "@super-work/core";
import { ANTHROPIC_VERSION, buildAnthropicBody, streamAnthropicResponse } from "./anthropic.js";
import { ProviderConfigError } from "./errors.js";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  fetchOrThrow,
  joinUrl,
  normalizeProviderError,
  resolveBaseUrl,
} from "./util.js";

const BASE_URL = "https://api.deepseek.com/anthropic/v1";
const DEFAULT_MAX_TOKENS = 128_000;

const MODELS: ModelInfo[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash（DSH 账户）",
    provider: "deepseek-account",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: true,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro（DSH 账户）",
    provider: "deepseek-account",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    vision: true,
  },
];

const TOKEN_MISSING =
  "DeepSeek 账户缺少 DSH 登录态：请在 DSH 登录后，从「本机登录」导入 deepseek-account";

function tokenOf(cred: Credential | null): string {
  const token = cred?.pasted?.access?.trim() || cred?.oauth?.access?.trim() || cred?.apiKey?.trim();
  if (!token) throw new ProviderConfigError(TOKEN_MISSING, { provider: "deepseek-account" });
  return token;
}

export class DeepSeekAccountAdapter implements ProviderAdapter {
  readonly id: ProviderId = "deepseek-account";
  readonly name = "DeepSeek 账户（DSH）";
  private readonly configuredBaseUrl?: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return resolveBaseUrl(
      "deepseek-account",
      cred?.baseUrl?.trim() || callBaseUrl?.trim() || this.configuredBaseUrl || BASE_URL,
      undefined,
    );
  }

  private headers(token: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
      "x-dsh-auth-token": token,
    };
  }

  async listModels(_cred: Credential | null): Promise<ModelInfo[]> {
    return [...MODELS];
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const token = tokenOf(cred);
    const base = this.baseFor(cred, opts.baseUrl);
    const url = joinUrl(base, "/messages");
    const ctx = createCallContext("deepseek-account", url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify(buildAnthropicBody(opts, "deepseek-account", DEFAULT_MAX_TOKENS)),
      });
      yield* streamAnthropicResponse(res, ctx);
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    try {
      tokenOf(cred);
      return { ok: true, detail: "DSH 账户登录态已就绪", models: [...MODELS] };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function createDeepSeekAccountAdapter(options: { baseUrl?: string; timeoutMs?: number } = {}): DeepSeekAccountAdapter {
  return new DeepSeekAccountAdapter(options);
}
