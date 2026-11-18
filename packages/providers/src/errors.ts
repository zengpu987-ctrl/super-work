/**
 * Providers 统一错误类型。
 *
 * 设计目标（DESIGN §5）：
 * - 任何适配器都不得抛裸异常；
 * - HTTP 非 2xx 统一抛 `ProviderHttpError`，带 status、bodySnippet（≤300 字符）、retryable；
 * - 配置类问题（缺少 key / baseUrl）抛 `ProviderConfigError`，消息可读、带 provider；
 * - 用户取消仍以 AbortError 冒泡，方便 orchestrator/server 区分"取消"与"失败"。
 */
import type { ProviderId } from "@super-work/core";

/** bodySnippet 的最大长度（DESIGN §5 要求 ≤300）。 */
export const BODY_SNIPPET_LIMIT = 300;

/** 把任意响应体压成不超过 `limit` 字符的单行摘要。 */
export function snippet(value: unknown, limit = BODY_SNIPPET_LIMIT): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export interface ProviderHttpErrorDetails {
  provider?: ProviderId;
  url?: string;
  /** 覆盖默认 message（默认自动拼装 provider/status/snippet）。 */
  message?: string;
  cause?: unknown;
}

/**
 * 上游 HTTP / 网络错误。
 *
 * 用法与 DESIGN 约定一致：`new ProviderHttpError(status, bodySnippet, retryable)`；
 * 第 4 个参数是可选的上下文（provider、url、自定义 message、cause）。
 * `status === 0` 表示"没有拿到 HTTP 状态"的传输层错误（DNS / TLS / 连接中断等）。
 */
export class ProviderHttpError extends Error {
  readonly name = "ProviderHttpError";
  readonly code = "provider_http_error";
  readonly status: number;
  readonly bodySnippet: string;
  readonly retryable: boolean;
  readonly provider?: ProviderId;
  readonly url?: string;

  constructor(status: number, body?: unknown, retryable?: boolean, details: ProviderHttpErrorDetails = {}) {
    const bodySnippet = snippet(body);
    const where = details.provider ? `${details.provider} ` : "";
    const message =
      details.message ??
      `${where}请求失败（HTTP ${status}）${bodySnippet ? `：${bodySnippet}` : ""}`;
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.retryable = retryable ?? status >= 429;
    this.provider = details.provider;
    this.url = details.url;
  }
}

export interface ProviderConfigErrorDetails {
  provider?: ProviderId;
  cause?: unknown;
}

/** 凭证 / 端点配置问题（缺 key、缺 baseUrl 等），重试无意义。 */
export class ProviderConfigError extends Error {
  readonly name = "ProviderConfigError";
  readonly code = "provider_config_error";
  readonly provider?: ProviderId;

  constructor(message: string, details: ProviderConfigErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.provider = details.provider;
  }
}

export function isProviderHttpError(value: unknown): value is ProviderHttpError {
  return value instanceof ProviderHttpError;
}

export function isProviderConfigError(value: unknown): value is ProviderConfigError {
  return value instanceof ProviderConfigError;
}

/** 把非 2xx 的 Response 转成 ProviderHttpError（读取 body 做片段）。 */
export async function httpErrorFromResponse(
  res: Response,
  provider?: ProviderId,
): Promise<ProviderHttpError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* 响应体读取失败时保留空片段即可 */
  }
  return new ProviderHttpError(res.status, text, res.status >= 429, {
    provider,
    url: res.url,
  });
}
