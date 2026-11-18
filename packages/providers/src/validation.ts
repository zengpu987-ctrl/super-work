/**
 * 凭证校验（validate）的兜底规则。
 *
 * 背景（DESIGN v0.0.3 §6）：「模型导入校验无法通过」的根因是部分 OpenAI 兼容中转站
 * 根本没有 `/models` 端点（404/405，或返回 HTML 首页）。这并不代表 Key 不可用，
 * 因此不能把网络校验失败直接判成凭证失败。
 *
 * 规则：
 * - 404/405/非 JSON（HTML）→ ok:true，detail 固定为 {@link MODELS_UNAVAILABLE_DETAIL}；
 * - 401/403、超时、网络错误 → ok:false；
 * - 其余 HTTP 错误（429/5xx 等）→ ok:true（端点存在但暂时不可用，凭证格式可用），
 *   实际可用性留给真正调用时校验。
 */
import type { ModelInfo } from "@super-work/core";
import { ProviderConfigError, ProviderHttpError } from "./errors.js";

/** 上游没有 /models 时的固定提示（server / UI 会直接展示）。 */
export const MODELS_UNAVAILABLE_DETAIL = "上游未提供 /models，已跳过网络校验";

export interface ValidateResult {
  ok: boolean;
  detail: string;
  models?: ModelInfo[];
}

/** 该错误是否表示「上游没有 /models 端点」（404/405 或返回 HTML / 非 JSON）。 */
export function isMissingModelsEndpointError(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status === 404 || err.status === 405) return true;
  // readJsonBody 把 200 的 HTML / 非 JSON 响应归为 502，并带「非 JSON 响应」文案。
  return (
    err.status === 502 &&
    /非\s*JSON|not\s*json|non-?json|html/i.test(`${err.message} ${err.bodySnippet}`)
  );
}

/** 判断某次校验失败是否还能算「凭证格式可用、只是无法网络校验」。 */
export function validationResultFromError(err: unknown): ValidateResult {
  if (isMissingModelsEndpointError(err)) {
    return { ok: true, detail: MODELS_UNAVAILABLE_DETAIL };
  }
  if (err instanceof ProviderConfigError) {
    return { ok: false, detail: err.message };
  }
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) {
      return { ok: false, detail: err.message };
    }
    if (err.status === 408 || err.status === 0) {
      return { ok: false, detail: err.message };
    }
    return { ok: true, detail: `上游校验暂不可用（HTTP ${err.status}），已跳过网络校验` };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return { ok: false, detail: "校验已取消或超时" };
  }
  return { ok: false, detail: err instanceof Error ? err.message : String(err) };
}
