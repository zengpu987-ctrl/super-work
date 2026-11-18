/**
 * WorkBuddy（CodeBuddy / copilot.tencent.com）适配器。
 *
 * 协议要点（DESIGN v0.0.2 §3，参考 dsh-connect-workbuddy 的 wire 行为）：
 * - 凭证：`{ provider:"workbuddy", mode:"token", baseUrl, pasted:{ access, extraHeaders:{ "X-User-Id", "X-Domain" } } }`
 * - 模型目录：`GET {catalogBase}/v2/enterprises/personal/models`（Bearer），
 *   失败回退 `GET {catalogBase}/v3/config` 并投影 `data.models`；
 * - 对话：`POST {chatBase}/v2/chat/completions`，OpenAI 兼容 SSE（content + reasoning_content），
 *   首条消息必须是 system（没有就补占位）；
 * - 生图：`POST {chatBase}/v2/images/generations`，解析 `data.data[0].url|b64_json` 与 `data.usage.credit`；
 * - 国内 chat base = copilot.tencent.com，目录 base = www.codebuddy.cn；
 *   国际账号（X-Domain 含 workbuddy.ai / codebuddy.ai）按对应品牌域路由。
 *
 * 所有网络请求都走 `globalThis.fetch(url, init)`，不引入任何新依赖。
 */
import type {
  ChatCallOptions,
  ChatChunk,
  ChatMessage,
  Credential,
  ImageCallOptions,
  ImageResult,
  ModelInfo,
  ProviderAdapter,
} from "@super-work/core";
import { EFFORT_BY_ID } from "@super-work/core";
import { ProviderConfigError, ProviderHttpError } from "./errors.js";
import { hasImages, openAIChatContent } from "./images.js";
import { mapOpenAIStopReason } from "./openai-compat.js";
import { SseChannel, sseChannel } from "./sse.js";
import { validationResultFromError } from "./validation.js";
import {
  DEFAULT_TIMEOUT_MS,
  type CallContext,
  asRecord,
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
  trimBaseUrl,
} from "./util.js";

export const WORKBUDDY_ID = "workbuddy" as const;
export const WORKBUDDY_CN_CHAT_BASE = "https://copilot.tencent.com";
export const WORKBUDDY_CN_CATALOG_BASE = "https://www.codebuddy.cn";
export const WORKBUDDY_GLOBAL_BASE = "https://www.workbuddy.ai";
export const WORKBUDDY_GLOBAL_CODEBUDDY_BASE = "https://www.codebuddy.ai";
/** 首条消息不是 system 时补的占位提示词（上游官方约定）。 */
export const WORKBUDDY_FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";
/** 仿官方 CodeBuddy CLI 的 User-Agent（对话通道）。 */
export const WORKBUDDY_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
 * WorkBuddy 桌面 App 的产品身份（目录 / 生图通道）。
 * `/v3/config` 按 UA 区分渠道，只有 App 形态才返回完整目录（含媒体模型）。
 */
export const WORKBUDDY_PRODUCT_USER_AGENT = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
/** 生图单次超时（官方网关一张 1024 图约 17–39 秒，留足排队时间）。 */
export const WORKBUDDY_IMAGE_TIMEOUT_MS = 180_000;

const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_PATH = "/v2/enterprises/personal/models";
const CONFIG_PATH = "/v3/config";
const CHAT_PATH = "/v2/chat/completions";
const IMAGE_PATH = "/v2/images/generations";

/** 已知官方入口；凡不是这些地址的 baseUrl 都当作自定义端点（代理 / 本地测试）。 */
const KNOWN_BASES = new Set([
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_CN_CATALOG_BASE,
  "https://www.workbuddy.cn",
  WORKBUDDY_GLOBAL_BASE,
  WORKBUDDY_GLOBAL_CODEBUDDY_BASE,
]);

export interface WorkBuddyAdapterOptions {
  /** 默认端点；凭证 / 单次调用里的 baseUrl 优先级更高 */
  baseUrl?: string;
  /** 追加 / 覆盖的模型清单 */
  models?: ModelInfo[];
  /** 对话超时，默认 180s */
  timeoutMs?: number;
  /** 生图超时，默认 180s */
  imageTimeoutMs?: number;
}

/** 从凭证里解析出的 WorkBuddy 身份与鉴权信息。 */
export interface WorkBuddyIdentity {
  access: string;
  uid?: string;
  domain?: string;
  extraHeaders: Record<string, string>;
}

/**
 * 凭证 → 身份。账号信息由 server 放在 `pasted.extraHeaders`（X-User-Id / X-Domain），
 * 头名大小写不敏感；access 兼容 pasted / oauth / apiKey 三种存放位置。
 */
export function workbuddyIdentity(cred: Credential | null): WorkBuddyIdentity {
  const extraHeaders = cred?.pasted?.extraHeaders ?? {};
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (typeof value === "string") lower.set(key.toLowerCase(), value);
  }
  const access =
    cred?.pasted?.access?.trim() ||
    cred?.oauth?.access?.trim() ||
    cred?.apiKey?.trim() ||
    "";
  return {
    access,
    uid: lower.get("x-user-id")?.trim() || undefined,
    domain: lower.get("x-domain")?.trim() || undefined,
    extraHeaders,
  };
}

function requireAccess(identity: WorkBuddyIdentity): void {
  if (!identity.access) {
    throw new ProviderConfigError(
      "WorkBuddy 缺少访问令牌：请先在 WorkBuddy 应用登录，然后重新导入本机账号",
      { provider: "workbuddy" },
    );
  }
}

function isGlobalDomain(domain: string | undefined): boolean {
  const lowered = (domain ?? "").trim().toLowerCase();
  return (
    lowered === "workbuddy.ai" ||
    lowered.endsWith(".workbuddy.ai") ||
    lowered === "codebuddy.ai" ||
    lowered.endsWith(".codebuddy.ai")
  );
}

function globalBaseFor(domain: string | undefined): string {
  const lowered = (domain ?? "").trim().toLowerCase();
  if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) {
    return WORKBUDDY_GLOBAL_CODEBUDDY_BASE;
  }
  return WORKBUDDY_GLOBAL_BASE;
}

function knownBase(base: string | undefined): boolean {
  return Boolean(base) && KNOWN_BASES.has(trimBaseUrl(base as string).toLowerCase());
}

/** 站点 Origin/Referer：国内 codebuddy.cn，国际对应品牌域。 */
function originFor(identity: WorkBuddyIdentity): string {
  return isGlobalDomain(identity.domain)
    ? globalBaseFor(identity.domain)
    : WORKBUDDY_CN_CATALOG_BASE;
}

/** 对话 base：cred.baseUrl > 单次调用 > 构造参数；官方默认值在无国际域时用 CN。 */
function chatBaseFor(
  cred: Credential | null,
  configured: string | undefined,
  callBaseUrl: string | undefined,
  identity: WorkBuddyIdentity,
): string {
  const explicit =
    cred?.baseUrl?.trim() || callBaseUrl?.trim() || configured?.trim() || undefined;
  if (explicit && !knownBase(explicit)) return trimBaseUrl(explicit);
  if (isGlobalDomain(identity.domain)) return globalBaseFor(identity.domain);
  return trimBaseUrl(explicit || WORKBUDDY_CN_CHAT_BASE);
}

/** 目录 base：自定义端点 > 国际品牌域 > 国内 codebuddy.cn。 */
function catalogBaseFor(
  cred: Credential | null,
  configured: string | undefined,
  identity: WorkBuddyIdentity,
): string {
  const explicit = cred?.baseUrl?.trim() || configured?.trim() || undefined;
  if (explicit && !knownBase(explicit)) return trimBaseUrl(explicit);
  if (isGlobalDomain(identity.domain)) return globalBaseFor(identity.domain);
  return WORKBUDDY_CN_CATALOG_BASE;
}

function randomUuid(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 上游要求的会话身份三连；不校验来源，每次请求现生成一组。 */
function conversationHeaders(): Record<string, string> {
  return {
    "X-Conversation-ID": randomUuid(),
    "X-Conversation-Request-ID": randomUuid(),
    "X-Conversation-Message-ID": randomUuid(),
  };
}

/** 合并自定义头并保持大小写不敏感的唯一性（避免同名头出现两份）。 */
function applyHeaders(headers: Record<string, string>, extra: Record<string, string>): void {
  const existing = new Map<string, string>();
  for (const key of Object.keys(headers)) existing.set(key.toLowerCase(), key);
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== "string") continue;
    const previous = existing.get(key.toLowerCase());
    if (previous !== undefined && previous !== key) delete headers[previous];
    headers[key] = value;
    existing.set(key.toLowerCase(), key);
  }
}

/** 公共请求头（对话 / 目录共用）。 */
function commonHeaders(
  identity: WorkBuddyIdentity,
  accept: string,
  userAgent = WORKBUDDY_USER_AGENT,
): Record<string, string> {
  const origin = originFor(identity);
  const headers: Record<string, string> = {
    authorization: `Bearer ${identity.access}`,
    accept,
    "user-agent": userAgent,
    "x-product": "SaaS",
    "x-requested-with": "XMLHttpRequest",
    origin,
    referer: `${origin}/`,
    ...conversationHeaders(),
  };
  if (identity.uid) headers["x-user-id"] = identity.uid;
  else headers["x-no-user-id"] = "1";
  if (identity.domain) headers["x-domain"] = identity.domain;
  else headers["x-no-department-info"] = "1";
  applyHeaders(headers, identity.extraHeaders);
  return headers;
}

function chatHeaders(identity: WorkBuddyIdentity): Record<string, string> {
  return {
    ...commonHeaders(identity, "text/event-stream"),
    "content-type": "application/json",
  };
}

function catalogHeaders(identity: WorkBuddyIdentity, userAgent?: string): Record<string, string> {
  return commonHeaders(identity, "application/json", userAgent);
}

function imageHeaders(identity: WorkBuddyIdentity): Record<string, string> {
  const headers = commonHeaders(
    identity,
    "application/json, text/plain, */*",
    WORKBUDDY_PRODUCT_USER_AGENT,
  );
  // 官方生图链路刻意不带 Origin/Referer（参考实现实测口径）。
  delete headers.origin;
  delete headers.referer;
  headers["content-type"] = "application/json";
  return headers;
}

function envelopeError(payload: unknown, action: string, status = 502): ProviderHttpError {
  const code = getNumber(payload, "code");
  const message = getString(payload, "msg") ?? getString(payload, "message") ?? "未知错误";
  return new ProviderHttpError(status, payload, false, {
    provider: "workbuddy",
    message: `WorkBuddy ${action}被上游拒绝（code ${code ?? "?"}）：${message}`,
  });
}

function unwrapData(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const data = record.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return record;
}

function extractModelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  const code = getNumber(record, "code");
  if (code !== undefined && code !== 0) throw envelopeError(payload, "模型目录");
  const doc = unwrapData(payload);
  const candidates: Array<unknown[] | undefined> = [
    getArray(doc, "models"),
    getArray(doc, "list"),
    getArray(doc, "data"),
    getArray(record, "models"),
  ];
  for (const candidate of candidates) if (candidate) return candidate;
  return [];
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function reasoningSupported(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const efforts = getArray(record, "supportedEfforts");
  const defaultEffort = getString(record, "defaultEffort") ?? getString(record, "effort");
  const canDisableThinking = asBoolean(record.canDisableThinking);
  if ((efforts && efforts.length > 0) || defaultEffort !== undefined) return true;
  if (canDisableThinking === true) return true;
  return undefined;
}

function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /x\s*([0-9]*\.?[0-9]+)/i.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** 上游目录里是「路由」而不是模型的两条已确认 id（另见 isDefault 兜底）。 */
const ROUTER_MODEL_IDS = new Set(["auto", "default-model"]);
const VIDEO_TAGS = new Set(["text-to-video", "image-to-video"]);

/** 目录里的一行 → core ModelInfo（解析不出就跳过，不虚构能力）。 */
function workbuddyModelFromRow(row: unknown): ModelInfo | undefined {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  if (record.disabled === true) return undefined;
  const id = getString(record, "id") ?? getString(record, "model");
  if (!id) return undefined;
  const name = getString(record, "name") || getString(record, "displayName") || id;
  const rawTags = getArray(record, "tags") ?? [];
  const tags = rawTags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.toLowerCase());
  // 路由不是模型（上游 auto 会动态选模型、积分倍率浮动），默认选中项同理。
  if (record.isDefault === true || ROUTER_MODEL_IDS.has(id)) return undefined;
  // 视频模型不能对话，ModelInfo 也没有视频能力位；不导入以免被当成聊天模型。
  if (tags.some((tag) => VIDEO_TAGS.has(tag)) && !tags.includes("text-to-image")) return undefined;
  const contextWindow =
    getNumber(record, "maxInputTokens") ??
    getNumber(record, "contextWindow") ??
    getNumber(record, "context_length") ??
    getNumber(record, "max_context_length");
  const maxOutputTokens =
    getNumber(record, "maxOutputTokens") ??
    getNumber(record, "max_output_tokens") ??
    getNumber(record, "maxTokens");
  const supportsImages =
    record.disabledMultimodal === true
      ? false
      : asBoolean(record.supportsImages) ?? asBoolean(record.vision);
  const reasoning =
    asBoolean(record.reasoning) ??
    asBoolean(record.supportsReasoning) ??
    reasoningSupported(record.reasoning) ??
    (tags.includes("reasoning") || tags.includes("thinking") ? true : undefined);
  const imageGen =
    id.toLowerCase().includes("image") ||
    name.toLowerCase().includes("image") ||
    tags.includes("text-to-image");

  const model: ModelInfo = { id, name, provider: "workbuddy", providedBy: "WorkBuddy" };
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
  if (supportsImages !== undefined) model.vision = supportsImages;
  if (reasoning !== undefined) model.reasoning = reasoning;
  if (imageGen) model.imageGen = true;
  const creditMultiplier = parseCreditMultiplier(record.credits);
  if (creditMultiplier !== undefined) model.creditMultiplier = creditMultiplier;
  if (tags.length > 0) model.tags = tags;
  return model;
}

function mimeFromUrl(url: string): string | undefined {
  const path = (url.split("?")[0] ?? "").toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return undefined;
}

export interface WorkBuddyChatBodyOptions {
  /** 覆盖 effort 推导值；传 null 表示明确不带 reasoning_effort（上游拒绝后的回退重试）。 */
  reasoningEffort?: "low" | "medium" | "high" | null;
}

/**
 * 组装 chat 请求体（导出便于排查与测试）。
 * 首条消息必须是 system：把 opts.system 与 messages 里的 system 合并到最前面，
 * 一个 system 都没有时补 `You are a helpful assistant.`。
 * effort 存在时按 core 的 5 档映射透传 `reasoning_effort`（上游拒绝时由 chat 重试去掉）。
 */
export function buildWorkBuddyChatBody(
  opts: ChatCallOptions,
  options: WorkBuddyChatBodyOptions = {},
): Record<string, unknown> {
  const systemParts: string[] = [];
  if (opts.system?.trim()) systemParts.push(opts.system.trim());
  const messages: Array<{
    role: string;
    content: string | Array<Record<string, unknown>>;
  }> = [];
  for (const message of opts.messages) {
    if (message.role === "system") systemParts.push(message.content);
    else if (message.content !== "" || hasImages(message)) {
      messages.push({ role: message.role, content: openAIChatContent(message) });
    }
  }
  if (messages.length === 0) {
    throw new ProviderConfigError("WorkBuddy 调用至少需要一条 user 消息", {
      provider: "workbuddy",
    });
  }
  const system =
    systemParts.map((part) => part.trim()).filter(Boolean).join("\n\n") ||
    WORKBUDDY_FALLBACK_SYSTEM_PROMPT;

  const body: Record<string, unknown> = { ...(opts.extras ?? {}) };
  body.model = opts.model;
  body.messages = [{ role: "system", content: system }, ...messages];
  body.stream = true;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  const reasoningEffort =
    options.reasoningEffort === undefined
      ? opts.effort
        ? EFFORT_BY_ID[opts.effort]?.reasoning ?? undefined
        : undefined
      : options.reasoningEffort ?? undefined;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return body;
}

/** 上游不认识 reasoning_effort 时的可重试判定（去掉该字段重发一次）。 */
function isEffortFieldRejection(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  return /reasoning[_-]?effort|unknown (field|parameter)|unrecognized|unsupported|invalid/i.test(
    `${err.bodySnippet} ${err.message}`,
  );
}

/** WorkBuddy 平台适配器。 */
export class WorkBuddyAdapter implements ProviderAdapter {
  readonly id = WORKBUDDY_ID;
  readonly name = "WorkBuddy";
  private readonly configuredBaseUrl?: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;
  private readonly jsonTimeoutMs: number;
  private readonly imageTimeoutMs: number;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    this.configuredBaseUrl = options.baseUrl?.trim() || undefined;
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.jsonTimeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
    this.imageTimeoutMs = options.imageTimeoutMs ?? WORKBUDDY_IMAGE_TIMEOUT_MS;
  }

  /** 把 401/403 换成可直接展示的重新登录提示，其余错误走统一归一化。 */
  private mapError(err: unknown, ctx: CallContext): Error {
    if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
      return new ProviderHttpError(err.status, err.bodySnippet, false, {
        provider: "workbuddy",
        url: ctx.url,
        message: `WorkBuddy 登录态失效（HTTP ${err.status}）：请在 WorkBuddy 应用重新登录后重新导入账号`,
      });
    }
    return normalizeProviderError(err, ctx);
  }

  private projectModels(payload: unknown): ModelInfo[] {
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const row of extractModelRows(payload)) {
      const model = workbuddyModelFromRow(row);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models;
  }

  private withExtraModels(models: ModelInfo[]): ModelInfo[] {
    const seen = new Set(models.map((model) => model.id));
    return [...models, ...this.extraModels.filter((model) => !seen.has(model.id))];
  }

  private async getJson(
    url: string,
    identity: WorkBuddyIdentity,
    timeoutMs: number,
    userAgent?: string,
  ): Promise<unknown> {
    const ctx = createCallContext("workbuddy", url, { timeoutMs });
    try {
      const res = await fetchOrThrow(ctx, {
        method: "GET",
        headers: catalogHeaders(identity, userAgent),
      });
      return await readJsonBody(res, "workbuddy");
    } catch (err) {
      throw this.mapError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  private async listModelsWithTimeout(cred: Credential | null, timeoutMs: number): Promise<ModelInfo[]> {
    const identity = workbuddyIdentity(cred);
    requireAccess(identity);
    const catalogBase = catalogBaseFor(cred, this.configuredBaseUrl, identity);
    const primary = joinUrl(catalogBase, CATALOG_PATH);
    const startedAt = Date.now();

    let primaryError: unknown;
    try {
      const models = this.projectModels(await this.getJson(primary, identity, timeoutMs));
      if (models.length > 0) return this.withExtraModels(models);
      primaryError = new ProviderHttpError(502, "模型目录为空", true, {
        provider: "workbuddy",
        url: primary,
        message: "WorkBuddy 模型目录为空，改读备用目录",
      });
    } catch (err) {
      primaryError = err;
    }

    // 两次尝试共享同一个超时预算（validate 传 8s 时不会变成 16s）。
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    // /v3/config 用 App 产品身份才返回完整目录（CLI 形态是它的子集）。
    const fallback = joinUrl(catalogBase, CONFIG_PATH);
    try {
      return this.withExtraModels(
        this.projectModels(
          await this.getJson(fallback, identity, remaining, WORKBUDDY_PRODUCT_USER_AGENT),
        ),
      );
    } catch (err) {
      // 两个目录都失败时保留主目录的错误信息（通常更有诊断价值）。
      throw primaryError instanceof Error ? primaryError : err;
    }
  }

  async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    return this.listModelsWithTimeout(cred, this.jsonTimeoutMs);
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const identity = workbuddyIdentity(cred);
    requireAccess(identity);
    const base = chatBaseFor(cred, this.configuredBaseUrl, opts.baseUrl, identity);
    const url = joinUrl(base, CHAT_PATH);
    const ctx = createCallContext("workbuddy", url, {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    let channel: SseChannel | undefined;
    try {
      const send = (
        reasoningEffort?: "low" | "medium" | "high" | null,
      ): Promise<Response> =>
        fetchOrThrow(ctx, {
          method: "POST",
          headers: chatHeaders(identity),
          body: JSON.stringify(buildWorkBuddyChatBody(opts, { reasoningEffort })),
        });
      let res: Response;
      try {
        res = await send(opts.effort ? undefined : null);
      } catch (err) {
        // 上游若拒绝 reasoning_effort（未知字段），去掉它重发一次。
        if (!opts.effort || !isEffortFieldRejection(err)) throw err;
        res = await send(null);
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("text/event-stream")) {
        yield* this.chatFromJson(await readJsonBody(res, "workbuddy"));
        return;
      }
      channel = sseChannel(res.body, { signal: ctx.signal });
      yield* this.iterate(channel);
    } catch (err) {
      throw this.mapError(err, ctx);
    } finally {
      await channel?.cancel();
      ctx.dispose();
    }
  }

  /** 上游没按 SSE 回包时的降级解析（JSON 信封错误 / 非流式 completion）。 */
  private async *chatFromJson(payload: unknown): AsyncGenerator<ChatChunk> {
    const code = getNumber(payload, "code");
    const choices = getArray(payload, "choices");
    if ((!choices || choices.length === 0) && code !== undefined && code !== 0) {
      throw envelopeError(payload, "对话");
    }
    const choice = choices && choices.length > 0 ? choices[0] : undefined;
    if (choice !== undefined) {
      const message = getProp(choice, "message");
      const reasoning =
        getString(message, "reasoning_content") ??
        getString(message, "reasoning") ??
        getString(message, "thinking");
      if (reasoning) yield { type: "reasoning", text: reasoning };
      const content = getString(message, "content");
      if (content) yield { type: "text", text: content };
      const usage = normalizeOpenAIUsage(getProp(payload, "usage"));
      if (hasUsage(usage)) yield { type: "usage", usage };
      yield {
        type: "done",
        stopReason: mapOpenAIStopReason(getString(choice, "finish_reason")),
      };
      return;
    }
    throw new ProviderHttpError(502, payload, true, {
      provider: "workbuddy",
      message: "WorkBuddy 返回了非 SSE 且无法解析的响应",
    });
  }

  private async *iterate(channel: SseChannel): AsyncGenerator<ChatChunk> {
    let stopReason: string | undefined;
    let usage: ReturnType<typeof normalizeOpenAIUsage> | undefined;
    for await (const message of channel.messages()) {
      const data = message.data;
      if (!data || data.trim() === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        continue; // 跳过 keep-alive / 非 JSON 行
      }
      const choices = getArray(payload, "choices");
      const code = getNumber(payload, "code");
      if ((!choices || choices.length === 0) && code !== undefined && code !== 0) {
        throw envelopeError(payload, "对话");
      }
      if (getProp(payload, "error") !== undefined) {
        throw errorFromUpstreamPayload(payload, "workbuddy");
      }
      const choice = choices && choices.length > 0 ? choices[0] : undefined;
      if (choice !== undefined) {
        const delta = getProp(choice, "delta");
        const messageBody = getProp(choice, "message");
        const source =
          delta !== null && typeof delta === "object" && Object.keys(delta as object).length > 0
            ? delta
            : messageBody;
        const reasoning =
          getString(source, "reasoning_content") ??
          getString(source, "reasoning") ??
          getString(source, "thinking");
        if (reasoning) yield { type: "reasoning", text: reasoning };
        const content = getString(source, "content");
        if (content) yield { type: "text", text: content };
        const finish = getString(choice, "finish_reason") ?? getString(choice, "finishReason");
        if (finish) stopReason = finish;
      }
      const rawUsage = getProp(payload, "usage");
      if (rawUsage !== null && typeof rawUsage === "object") {
        const mapped = normalizeOpenAIUsage(rawUsage);
        if (hasUsage(mapped)) usage = mapped;
      }
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "done", stopReason: mapOpenAIStopReason(stopReason) };
  }

  async generateImage(opts: ImageCallOptions, cred: Credential | null): Promise<ImageResult> {
    const identity = workbuddyIdentity(cred);
    requireAccess(identity);
    const base = chatBaseFor(cred, this.configuredBaseUrl, undefined, identity);
    const url = joinUrl(base, IMAGE_PATH);
    const ctx = createCallContext("workbuddy", url, {
      signal: opts.signal,
      timeoutMs: this.imageTimeoutMs,
    });
    try {
      const body = {
        model: opts.model,
        prompt: opts.prompt,
        size: opts.size ?? "1024x1024",
        n: opts.n ?? 1,
      };
      const res = await fetchOrThrow(ctx, {
        method: "POST",
        headers: imageHeaders(identity),
        body: JSON.stringify(body),
      });
      const payload = await readJsonBody(res, "workbuddy");
      const code = getNumber(payload, "code");
      if (code !== undefined && code !== 0) throw envelopeError(payload, "生图");

      const data = asRecord(getProp(payload, "data"));
      const items = getArray(data, "data") ?? [];
      const images: Array<{ url?: string; b64?: string; mime?: string }> = [];
      for (const item of items) {
        const imageUrl = getString(item, "url");
        const b64 = getString(item, "b64_json") ?? getString(item, "b64");
        if (!imageUrl && !b64) continue;
        const image: { url?: string; b64?: string; mime?: string } = {};
        if (imageUrl) {
          image.url = imageUrl;
          const mime = mimeFromUrl(imageUrl);
          if (mime) image.mime = mime;
        }
        if (b64) {
          image.b64 = b64;
          image.mime = image.mime ?? "image/png";
        }
        images.push(image);
      }
      if (images.length === 0) {
        throw new ProviderHttpError(502, payload, true, {
          provider: "workbuddy",
          url,
          message: "WorkBuddy 生图返回成功，但 data.data 里既没有 url 也没有 b64_json",
        });
      }
      const credit = getNumber(getProp(data, "usage"), "credit");
      return credit !== undefined ? { images, credit } : { images };
    } catch (err) {
      throw this.mapError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    const identity = workbuddyIdentity(cred);
    if (!identity.access) {
      return {
        ok: false,
        detail: "WorkBuddy 缺少访问令牌：请先在 WorkBuddy 应用登录，然后重新导入本机账号",
      };
    }
    try {
      const models = await this.listModelsWithTimeout(cred, 8_000);
      return {
        ok: true,
        detail:
          models.length > 0
            ? `连接成功，可用模型 ${models.length} 个`
            : "连接成功（模型目录为空）",
        models,
      };
    } catch (err) {
      return validationResultFromError(err);
    }
  }
}

/** 图片理解默认使用的视觉模型（可在 options.model 覆盖）。 */
export const WORKBUDDY_VISION_MODEL = "glm-4.6v";

export interface DescribeImageOptions {
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 用 WorkBuddy 的视觉模型描述一张 data URL 图片（供 server 做附件理解）。
 * 复用 chat 通道与图片 content 映射；返回正文文本（无文本时抛可读错误）。
 */
export async function describeImageWithWorkbuddy(
  cred: Credential | null,
  dataUrl: string,
  prompt = "请用中文描述这张图片的内容。",
  options: DescribeImageOptions = {},
): Promise<string> {
  const message: ChatMessage = { role: "user", content: prompt, images: [dataUrl] };
  const adapter = new WorkBuddyAdapter();
  let text = "";
  for await (const chunk of adapter.chat(
    {
      provider: "workbuddy",
      model: options.model?.trim() || WORKBUDDY_VISION_MODEL,
      messages: [message],
      maxTokens: options.maxTokens ?? 1024,
      signal: options.signal,
    },
    cred,
  )) {
    if (chunk.type === "text") text += chunk.text;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ProviderHttpError(502, "empty response", false, {
      provider: "workbuddy",
      message: "WorkBuddy 图片理解没有返回文本",
    });
  }
  return trimmed;
}

/** 与 `createAdapter("workbuddy", opts)` 等价的便捷工厂。 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions = {}): WorkBuddyAdapter {
  return new WorkBuddyAdapter(options);
}
