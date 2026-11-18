/**
 * Providers 共用工具：
 * - 请求上下文（超时 + 外部 AbortSignal 合并、资源释放）
 * - fetch 包装（错误归一化，绝不抛裸 "fetch failed"）
 * - baseUrl 解析（opts.baseUrl > cred.baseUrl > catalog 默认）
 * - Usage 归一化 / 合并、token 粗估
 */
import type { Credential, ProviderId, Usage } from "@super-work/core";
import { PROVIDER_BY_ID } from "@super-work/core";
import {
  ProviderConfigError,
  ProviderHttpError,
  httpErrorFromResponse,
  snippet,
} from "./errors.js";

/** 单次模型调用默认超时（与 DESIGN §6 的 180s 对齐）。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

const UPSTREAM_MESSAGE_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* Abort / 错误归一化                                                   */
/* ------------------------------------------------------------------ */

/** 构造一个 name 为 AbortError 的 DOMException（调用方据此识别取消）。 */
export function abortError(message = "请求已取消"): DOMException {
  return new DOMException(message, "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      ((err as { name?: unknown }).name === "AbortError" ||
        (err as { code?: unknown }).code === "ABORT_ERR"),
  );
}

function isTimeoutError(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as { name?: unknown }).name === "TimeoutError",
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    const code =
      cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : "";
    const suffix = code ? `（${code}）` : causeText && causeText !== err.message ? `（${causeText}）` : "";
    return `${err.message}${suffix}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 定时器 unref（避免未清理的超时计时器把进程挂住）。 */
function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === "object" && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

/** 一次模型调用的上下文：合并后的 signal、超时判定、释放钩子。 */
export interface CallContext {
  provider: ProviderId;
  url: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** 是否是调用方（用户）主动取消 */
  abortedByCaller(): boolean;
  /** 是否是适配器超时 */
  timedOut(): boolean;
  /** 清理超时计时器 */
  dispose(): void;
}

export function createCallContext(
  provider: ProviderId,
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): CallContext {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException(`请求超时（${timeoutMs}ms）`, "TimeoutError"));
  }, timeoutMs);
  unrefTimer(timer);

  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  return {
    provider,
    url,
    signal,
    timeoutMs,
    abortedByCaller: () => Boolean(opts.signal?.aborted),
    timedOut: () => timeoutController.signal.aborted,
    dispose: () => clearTimeout(timer),
  };
}

function timeoutError(ctx: CallContext): ProviderHttpError {
  return new ProviderHttpError(408, `请求超过 ${ctx.timeoutMs}ms 未完成`, true, {
    provider: ctx.provider,
    url: ctx.url,
    message: `${ctx.provider} 请求超时（${ctx.timeoutMs}ms）`,
  });
}

/**
 * 把任意异常归一成 ProviderHttpError / ProviderConfigError / AbortError。
 * 注意：调用方主动取消必须继续以 AbortError 冒泡，不能被包装成普通错误。
 */
export function normalizeProviderError(err: unknown, ctx: CallContext): Error {
  if (err instanceof ProviderHttpError || err instanceof ProviderConfigError) return err;
  if (isAbortError(err)) {
    if (ctx.timedOut() && !ctx.abortedByCaller()) return timeoutError(ctx);
    return abortError();
  }
  if (isTimeoutError(err)) return timeoutError(ctx);
  return new ProviderHttpError(0, errorMessage(err), true, {
    provider: ctx.provider,
    url: ctx.url,
    message: `${ctx.provider} 请求失败：${errorMessage(err)}`,
    cause: err,
  });
}

/* ------------------------------------------------------------------ */
/* fetch 包装                                                          */
/* ------------------------------------------------------------------ */

/** fetch 并在失败时抛归一化错误（网络错误 → ProviderHttpError(status=0)）。 */
export async function fetchOrThrow(
  ctx: CallContext,
  init: Omit<RequestInit, "signal"> = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(ctx.url, { ...init, signal: ctx.signal });
  } catch (err) {
    throw normalizeProviderError(err, ctx);
  }
  if (!res.ok) throw await httpErrorFromResponse(res, ctx.provider);
  return res;
}

/** 读取 JSON 响应体（空 body → {}；非 JSON → 可读的 ProviderHttpError）。 */
export async function readJsonBody(res: Response, provider?: ProviderId): Promise<unknown> {
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderHttpError(0, errorMessage(err), true, {
      provider,
      url: res.url,
      message: `${provider ?? "provider"} 读取响应失败：${errorMessage(err)}`,
    });
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderHttpError(502, text, true, {
      provider,
      url: res.url,
      message: `${provider ?? "provider"} 返回了非 JSON 响应：${snippet(text, 160)}`,
    });
  }
}

/** 上游 SSE 里内嵌的 error 事件 → ProviderHttpError。 */
export function errorFromUpstreamPayload(
  payload: unknown,
  provider: ProviderId,
  fallbackMessage = "上游返回错误",
): ProviderHttpError {
  const record = asRecord(payload);
  const errorObj = asRecord(record.error);
  const message =
    firstString(errorObj.message, record.message, errorObj.type, record.type) ?? fallbackMessage;
  const hinted = firstNumber(
    errorObj.status,
    record.status,
    errorObj.status_code,
    record.status_code,
    errorObj.code,
    record.code,
  );
  const lower = `${message} ${firstString(errorObj.code, record.code) ?? ""}`.toLowerCase();
  let status = hinted !== undefined && hinted >= 400 && hinted <= 599 ? Math.trunc(hinted) : 0;
  if (!status) {
    if (/rate|quota|too many|429/.test(lower)) status = 429;
    else if (/auth|unauthor|forbidden|invalid api key|401|403/.test(lower)) status = 401;
    else if (/not found|unknown model|404/.test(lower)) status = 404;
    else if (/overload|unavailable|timeout|500|502|503|504/.test(lower)) status = 503;
    else status = 502;
  }
  const retryable = status >= 429 && status !== 404;
  return new ProviderHttpError(status, snippet(payload, UPSTREAM_MESSAGE_LIMIT), retryable, {
    provider,
    message: `${provider} ${fallbackMessage}：${snippet(message, 300)}`,
  });
}

/* ------------------------------------------------------------------ */
/* URL / baseUrl                                                       */
/* ------------------------------------------------------------------ */

export function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 拼接 base + path（避免重复/缺失斜杠）。 */
export function joinUrl(base: string, path: string): string {
  const trimmed = trimBaseUrl(base);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

/**
 * baseUrl 取值优先级：显式 opts.baseUrl > cred.baseUrl > catalog 默认。
 * `explicit` 由调用方合并 ChatCallOptions.baseUrl 与适配器构造参数后传入。
 * thirdparty 没有默认端点，缺失时给出可读错误。
 */
export function resolveBaseUrl(
  id: ProviderId,
  explicit: string | undefined,
  credBaseUrl: string | undefined,
): string {
  const candidates = [explicit, credBaseUrl, PROVIDER_BY_ID[id]?.defaultBaseUrl];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return trimBaseUrl(candidate);
  }
  if (id === "thirdparty") {
    throw new ProviderConfigError(
      "thirdparty 需要提供 baseUrl：请在凭证里填写 OpenAI 兼容端点地址（如 https://openrouter.ai/api/v1 或 http://127.0.0.1:11434/v1）",
      { provider: id },
    );
  }
  throw new ProviderConfigError(`provider ${id} 缺少 baseUrl，请填写端点地址`, { provider: id });
}

/** 从响应头取 bearer token（如需要）。 */
export function bearerToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
}

/** 从凭证里提取鉴权信息：apiKey 优先，其次是粘贴/订阅 token。 */
export interface CredentialAuth {
  /** api-key 模式写入头 `x-api-key` 或 `authorization: Bearer` */
  apiKey?: string;
  /** token / oauth / local 复用得到的 bearer */
  bearer?: string;
  /** 用户粘贴凭证时允许额外携带的头 */
  extraHeaders?: Record<string, string>;
}

export function credentialAuth(cred: Credential | null): CredentialAuth {
  const auth: CredentialAuth = {};
  const apiKey = cred?.apiKey?.trim();
  if (apiKey) auth.apiKey = apiKey;
  const pasted = cred?.pasted?.access?.trim();
  const oauth = cred?.oauth?.access?.trim();
  const bearer = pasted || oauth;
  if (bearer) auth.bearer = bearer;
  if (cred?.pasted?.extraHeaders) auth.extraHeaders = cred.pasted.extraHeaders;
  return auth;
}

/** 第一个可用的 token（apiKey > pasted > oauth）。 */
export function firstCredentialToken(cred: Credential | null): string | undefined {
  const auth = credentialAuth(cred);
  return auth.apiKey ?? auth.bearer;
}

/* ------------------------------------------------------------------ */
/* 通用数据读取                                                        */
/* ------------------------------------------------------------------ */

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function getProp(obj: unknown, key: string): unknown {
  return asRecord(obj)[key];
}

export function getString(obj: unknown, key: string): string | undefined {
  const value = getProp(obj, key);
  return typeof value === "string" ? value : undefined;
}

export function getNumber(obj: unknown, key: string): number | undefined {
  const value = getProp(obj, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getArray(obj: unknown, key: string): unknown[] | undefined {
  const value = getProp(obj, key);
  return Array.isArray(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export function hasUsage(usage: Usage | undefined): boolean {
  return Boolean(usage) && Object.values(usage as Usage).some((v) => typeof v === "number");
}

/** OpenAI 兼容 / OpenAI Responses 的 usage 字段归一化。 */
export function normalizeOpenAIUsage(raw: unknown): Usage {
  const usage: Usage = {};
  const input = getNumber(raw, "prompt_tokens") ?? getNumber(raw, "input_tokens");
  const output = getNumber(raw, "completion_tokens") ?? getNumber(raw, "output_tokens");
  const total = getNumber(raw, "total_tokens");
  const cached =
    getNumber(getProp(raw, "prompt_tokens_details"), "cached_tokens") ??
    getNumber(getProp(raw, "input_tokens_details"), "cached_tokens") ??
    getNumber(raw, "cached_tokens");
  const reasoning =
    getNumber(getProp(raw, "completion_tokens_details"), "reasoning_tokens") ??
    getNumber(getProp(raw, "output_tokens_details"), "reasoning_tokens") ??
    getNumber(raw, "reasoning_tokens");
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  else if (input !== undefined || output !== undefined)
    usage.totalTokens = (input ?? 0) + (output ?? 0);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

/** Usage 合并（字段相加）；缺 totalTokens 时按 input+output 补。 */
export function mergeUsage(base: Usage, next: Usage): Usage {
  const out: Usage = { ...base };
  const keys: Array<keyof Usage> = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ];
  for (const key of keys) {
    const value = next[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = (out[key] ?? 0) + value;
    }
  }
  if (out.totalTokens === undefined && (out.inputTokens !== undefined || out.outputTokens !== undefined)) {
    out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0);
  }
  return out;
}

/** 粗略 token 估算（中文按 1.5 字符 / token），仅用于 mock 演示统计。 */
export function estimateTokens(text: string): number {
  const chars = Array.from(text).length;
  if (chars === 0) return 0;
  return Math.max(1, Math.round(chars / 1.5));
}

/* ------------------------------------------------------------------ */
/* 其它                                                                */
/* ------------------------------------------------------------------ */

/** 可被 AbortSignal 取消的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 生成一个 0..maxExclusive-1 的整数（mock 用）。 */
export function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}
