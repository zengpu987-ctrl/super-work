/**
 * Kimi 会员订阅适配器（Anthropic 协议 + Kimi CLI 公共头）。
 *
 * 端点：`POST https://api.kimi.com/coding/v1/messages`
 * 鉴权：Bearer <会员 access token>（cred.oauth / cred.pasted）
 * 额外头（模拟官方 Kimi CLI）：
 *   User-Agent: KimiCLI/1.0
 *   X-Msh-Platform: kimi_cli
 *   X-Msh-Version: 1.0
 *   X-Msh-Device-Name / X-Msh-Device-Model / X-Msh-Os-Version / X-Msh-Device-Id
 *
 * 注意：`max_tokens` 必填（默认 8192）；SSE 事件与 anthropic.ts 完全一致。
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from "@super-work/core";
import { findModel, modelsForProvider } from "@super-work/core";
import { ProviderConfigError } from "./errors.js";
import {
  ANTHROPIC_VERSION,
  buildAnthropicBody,
  streamAnthropicChannel,
} from "./anthropic.js";
import { SseChannel, sseChannel } from "./sse.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  fetchOrThrow,
  getArray,
  getNumber,
  getProp,
  getString,
  joinUrl,
  normalizeProviderError,
  readJsonBody,
} from "./util.js";

export const DEFAULT_KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CLI_USER_AGENT = "KimiCLI/1.0";
export const KIMI_DEFAULT_MAX_TOKENS = 8192;

/** 进程内复用同一个设备 ID（去横线的 uuid）。 */
const KIMI_DEVICE_ID = randomUUID().replace(/-/g, "");

function deviceModel(): string {
  try {
    const cpu = os.cpus()?.[0]?.model?.trim();
    if (cpu) return cpu.slice(0, 80);
  } catch {
    /* 忽略：极少数沙箱环境禁用 os.cpus */
  }
  return `${os.platform()}-${os.arch()}`;
}

function deviceName(): string {
  try {
    return os.hostname() || "super-work";
  } catch {
    return "super-work";
  }
}

function osVersion(): string {
  try {
    return `${os.type()} ${os.release()}`.trim();
  } catch {
    return os.platform();
  }
}

export interface KimiSubscriptionOptions {
  baseUrl?: string;
  models?: ModelInfo[];
  timeoutMs?: number;
  defaultMaxTokens?: number;
}

function subscriptionTokenOf(cred: Credential | null): string | undefined {
  return cred?.oauth?.access?.trim() || cred?.pasted?.access?.trim() || cred?.apiKey?.trim() || undefined;
}

/** 该模型是否属于 Kimi 会员订阅模型（catalog 里 via=subscription / 带 subscription tag）。 */
export function isKimiSubscriptionModel(model: string): boolean {
  const info = findModel("kimi", model);
  if (!info) return false;
  return info.via === "subscription" || Boolean(info.tags?.includes("subscription"));
}

/**
 * 一个凭证同时具备 API key 与订阅 token 时，按模型选路：
 * - 订阅模型（k3 / k3.1-pro / kimi-for-coding）→ 订阅通道；
 * - 明确的 API 模型 → API 通道（没有 key 时退回订阅通道）；
 * - 未知模型 → 有订阅 token 且没有 API key 时走订阅，否则走 API。
 */
export function routeKimiCall(model: string, cred: Credential | null): "subscription" | "api" {
  const hasSubscription = Boolean(cred?.oauth?.access?.trim() || cred?.pasted?.access?.trim());
  const hasApiKey = Boolean(cred?.apiKey?.trim());
  if (isKimiSubscriptionModel(model)) return hasSubscription || !hasApiKey ? "subscription" : "api";
  const info = findModel("kimi", model);
  if (info?.via === "api") return hasApiKey || !hasSubscription ? "api" : "subscription";
  if (hasSubscription && !hasApiKey) return "subscription";
  return "api";
}

export class KimiSubscriptionAdapter implements ProviderAdapter {
  readonly id: ProviderId = "kimi";
  readonly name: string;
  readonly kind = "anthropic" as const;
  private readonly configuredBaseUrl?: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;

  constructor(options: KimiSubscriptionOptions = {}) {
    this.name = "KIMI（会员订阅）";
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? KIMI_DEFAULT_MAX_TOKENS;
  }

  private baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return (
      callBaseUrl?.trim() ||
      this.configuredBaseUrl ||
      cred?.baseUrl?.trim() ||
      DEFAULT_KIMI_CODING_BASE_URL
    );
  }

  private endpointFor(cred: Credential | null, callBaseUrl?: string): string {
    const base = this.baseFor(cred, callBaseUrl);
    return /\/messages$/.test(base) ? base : joinUrl(base, "/messages");
  }

  private requireToken(cred: Credential | null): string {
    const token = subscriptionTokenOf(cred);
    if (!token) {
      throw new ProviderConfigError(
        "KIMI 会员订阅缺少访问令牌：请先完成设备码登录，或从本机已登录账户导入",
        { provider: "kimi" },
      );
    }
    return token;
  }

  /** Kimi CLI 公共头 + Anthropic 协议头。 */
  headers(cred: Credential | null, token: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "user-agent": KIMI_CLI_USER_AGENT,
      "x-msh-platform": "kimi_cli",
      "x-msh-version": "1.0",
      "x-msh-device-name": deviceName(),
      "x-msh-device-model": deviceModel(),
      "x-msh-os-version": osVersion(),
      "x-msh-device-id": KIMI_DEVICE_ID,
    };
    if (cred?.pasted?.extraHeaders) Object.assign(headers, cred.pasted.extraHeaders);
    return headers;
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    this.requireToken(cred);
    const all = modelsForProvider("kimi", this.extraModels);
    const subscription = all.filter(
      (model) => model.via === "subscription" || model.tags?.includes("subscription"),
    );
    return subscription.length > 0 ? subscription : all;
  }

  /**
   * 实时会员模型目录：`GET {base}/models`（Kimi CLI 公共头即可，无需额外参数）。
   *
   * 与 `listModels`（catalog 兜底、离线可用）分开：只有「更新模型」这类显式动作
   * 才走网络，导入/校验保持秒级、不受网络影响。
   */
  async discoverModels(cred: Credential | null, callBaseUrl?: string): Promise<ModelInfo[]> {
    const token = this.requireToken(cred);
    const url = joinUrl(this.baseFor(cred, callBaseUrl), "/models");
    const ctx = createCallContext(this.id, url, { timeoutMs: this.timeoutMs });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "GET",
        headers: { ...this.headers(cred, token), accept: "application/json" },
      });
      const json = await readJsonBody(res, this.id);
      const rows = getArray(json, "data") ?? getArray(json, "models") ?? [];
      const models: ModelInfo[] = [];
      for (const row of rows) {
        const id = getString(row, "id") ?? getString(row, "slug");
        if (!id) continue;
        const name = getString(row, "display_name") ?? getString(row, "name") ?? id;
        const contextWindow = getNumber(row, "context_length") ?? getNumber(row, "context_window");
        const inputs = (getProp(getProp(row, "modalities"), "input") as unknown[] | undefined) ?? [];
        models.push({
          id,
          name,
          provider: "kimi",
          via: "subscription",
          reasoning: getProp(row, "supports_reasoning") === true,
          vision:
            getProp(row, "supports_image_in") === true ||
            (Array.isArray(inputs) && inputs.includes("image")),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        });
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
    const token = this.requireToken(cred);
    const headers = this.headers(cred, token);
    const ctx = createCallContext(this.id, url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const body = buildAnthropicBody(opts, this.id, this.defaultMaxTokens);
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
    const token = subscriptionTokenOf(cred);
    if (!token) {
      return { ok: false, detail: "缺少会员访问令牌：请先完成设备码登录" };
    }
    if (cred.oauth?.expiresAt !== undefined && cred.oauth.expiresAt < Date.now()) {
      return { ok: false, detail: "会员访问令牌已过期，请重新登录" };
    }
    try {
      const models = await this.listModels(cred);
      return {
        ok: true,
        detail: "会员凭证已就绪（实际可用性在调用时由 Kimi 后端校验）",
        models,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Kimi 混合适配器：同一个凭证里既有 API key 又有会员 token 时按模型自动选路。
 * 也用于 source=local 的本机复用场景（不知道导入的是哪一种 token）。
 */
export class KimiHybridAdapter implements ProviderAdapter {
  readonly id: ProviderId = "kimi";
  readonly name = "KIMI（API + 会员订阅）";
  private readonly api: OpenAICompatAdapter;
  private readonly subscription: KimiSubscriptionAdapter;

  constructor(options: KimiSubscriptionOptions = {}) {
    this.api = new OpenAICompatAdapter({
      id: "kimi",
      baseUrl: options.baseUrl,
      models: options.models,
      timeoutMs: options.timeoutMs,
    });
    this.subscription = new KimiSubscriptionAdapter(options);
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    const apiModels = cred?.apiKey?.trim()
      ? await this.api.listModels(cred).catch(() => [] as ModelInfo[])
      : [];
    const subModels = await this.subscription.listModels(cred).catch(() => [] as ModelInfo[]);
    const merged: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const model of [...subModels, ...apiModels]) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    return merged;
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const route = routeKimiCall(opts.model, cred);
    if (route === "subscription") {
      yield* this.subscription.chat(opts, cred);
    } else {
      yield* this.api.chat(opts, cred);
    }
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    const results: Array<{ ok: boolean; detail?: string; models?: ModelInfo[] }> = [];
    if (subscriptionTokenOf(cred)) results.push(await this.subscription.validate(cred));
    if (cred.apiKey?.trim()) results.push(await this.api.validate(cred));
    if (results.length === 0) {
      return { ok: false, detail: "KIMI 凭证缺少 API key 或会员访问令牌" };
    }
    const ok = results.some((result) => result.ok);
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      for (const model of result.models ?? []) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
    }
    const details = results.map((result) => result.detail).filter(Boolean);
    return {
      ok,
      detail: details.join("；") || undefined,
      models: models.length > 0 ? models : undefined,
    };
  }
}

export function createKimiSubscriptionAdapter(
  options: KimiSubscriptionOptions = {},
): KimiSubscriptionAdapter {
  return new KimiSubscriptionAdapter(options);
}
