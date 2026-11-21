/**
 * 中转站（relay）适配器：OpenAI 兼容协议 + 模型目录发现。
 *
 * 中转站（贾维斯 / Devin / one-api / new-api / OpenRouter / 自建网关）都提供
 * OpenAI 兼容端点，模型 id 由 server 以 `remoteId` 传入；账号级差异（Base URL、
 * Key、自定义 Header）全部来自凭证。
 *
 * 与 `OpenAICompatAdapter` 的差别只有三点：
 * 1. Base URL 优先取 `cred.baseUrl`（中转站地址存在账号里，而不是代码里）；
 * 2. `GET {baseUrl}/models` 兼容 `{data:[]}` / 裸数组 / `{data:{data:[]}}` 三种形状；
 * 3. 401/403 给可读的鉴权错误（前端可直接提示用户检查 Key）。
 */
import type {
  ChatCallOptions,
  Credential,
  ModelInfo,
  ProviderAdapter,
} from "@super-work/core";
import { ProviderConfigError, ProviderHttpError } from "./errors.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import {
  asRecord,
  createCallContext,
  fetchOrThrow,
  getNumber,
  getProp,
  getString,
  joinUrl,
  normalizeProviderError,
  readJsonBody,
  resolveBaseUrl,
  trimBaseUrl,
} from "./util.js";

/** 模型目录请求超时（发现模型不应占用太久的交互）。 */
const DISCOVER_TIMEOUT_MS = 30_000;

/** 从三种上游响应形状里取出模型数组。 */
function relayModelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (Array.isArray(record.data)) return record.data;
  const nested = asRecord(record.data);
  if (Array.isArray(nested.data)) return nested.data;
  if (Array.isArray(nested.models)) return nested.models;
  if (Array.isArray(record.models)) return record.models;
  if (Array.isArray(record.result)) return record.result;
  const result = asRecord(record.result);
  if (Array.isArray(result.models)) return result.models;
  return [];
}

/** 一行上游模型 → core ModelInfo。 */
function relayModelFromRow(row: unknown): ModelInfo | undefined {
  const id = getString(row, "id") ?? getString(row, "model") ?? getString(row, "name");
  if (!id) return undefined;
  const name =
    getString(row, "display_name") ||
    getString(row, "displayName") ||
    getString(row, "name") ||
    id;
  const model: ModelInfo = { id, name, provider: "relay" };
  const contextWindow =
    getNumber(row, "context_length") ??
    getNumber(row, "context_window") ??
    getNumber(row, "max_context_length") ??
    getNumber(row, "maxInputTokens");
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxOutputTokens =
    getNumber(row, "max_output_tokens") ?? getNumber(row, "maxOutputTokens") ?? getNumber(row, "maxTokens");
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
  const vision = getProp(row, "vision") ?? getProp(row, "supports_vision") ?? getProp(row, "supportsImages");
  if (typeof vision === "boolean") model.vision = vision;
  const reasoning =
    getProp(row, "reasoning") ?? getProp(row, "supports_reasoning") ?? getProp(row, "supportsReasoning");
  if (typeof reasoning === "boolean") model.reasoning = reasoning;
  return model;
}

/**
 * 发现中转站模型：`GET {baseUrl}/models`。
 *
 * 兼容 `{data:[...]}`（OpenAI 标准）、裸数组、以及某些聚合器套了一层的
 * `{data:{data:[...]}}`。401/403 抛可读的 `ProviderHttpError`，其余网络 / 协议
 * 错误交给 `normalizeProviderError` 归一化。
 */
export async function discoverRelayModels(
  baseUrl: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  const base = trimBaseUrl(baseUrl ?? "");
  if (!base) {
    throw new ProviderConfigError(
      "relay 缺少 Base URL：请在设置里填写中转站地址（通常以 /v1 结尾）后再拉取模型",
      { provider: "relay" },
    );
  }
  const url = joinUrl(base, "/models");
  const ctx = createCallContext("relay", url, { timeoutMs: DISCOVER_TIMEOUT_MS });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    const key = apiKey?.trim();
    if (key) headers.authorization = `Bearer ${key}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const res = await fetchOrThrow(ctx, { method: "GET", headers });
    const payload = await readJsonBody(res, "relay");
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    for (const row of relayModelRows(payload)) {
      const model = relayModelFromRow(row);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models;
  } catch (err) {
    if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
      throw new ProviderHttpError(
        err.status,
        err.bodySnippet,
        false,
        {
          provider: "relay",
          url,
          message: `relay 模型目录鉴权失败（HTTP ${err.status}）：API Key 无效、已过期，或未被该中转站接受`,
        },
      );
    }
    throw normalizeProviderError(err, ctx);
  } finally {
    ctx.dispose();
  }
}

export interface RelayAdapterOptions {
  /** 默认 Base URL；单次调用 / 凭证里的 baseUrl 优先级更高 */
  baseUrl?: string;
  /** 追加 / 覆盖的模型清单 */
  models?: ModelInfo[];
  timeoutMs?: number;
}

/** 中转站适配器：OpenAI 兼容 chat，模型目录用上面的 discover 逻辑。 */
export class RelayAdapter extends OpenAICompatAdapter implements ProviderAdapter {
  constructor(options: RelayAdapterOptions = {}) {
    super({ id: "relay", baseUrl: options.baseUrl, models: options.models, timeoutMs: options.timeoutMs });
  }

  /** 中转站地址优先取凭证（账号配置），其次单次调用，最后构造参数。 */
  protected override baseFor(cred: Credential | null, callBaseUrl?: string): string {
    return resolveBaseUrl(
      "relay",
      cred?.baseUrl?.trim() || callBaseUrl?.trim() || this.configuredBaseUrl,
      undefined,
    );
  }

  /**
   * 某些中转/Claude 网关拒绝非默认 temperature（HTTP 400
   * "does not support non-default temperature"）。对 Claude 系模型不传 temperature，
   * 保留档位对 maxTokens 与系统提示的影响；其余模型维持原行为。
   */
  override buildBody(opts: ChatCallOptions): Record<string, unknown> {
    const body = super.buildBody(opts);
    // Claude 严格网关：不传非默认 temperature，也不接受 reasoning_effort。
    // 档位仍通过 maxTokens 与 system 强度提示生效。
    if (/claude|anthropic|haiku|sonnet|opus|fable/i.test(opts.model)) {
      delete body.temperature;
      delete body.reasoning_effort;
    }
    return body;
  }

  override async listModels(cred: Credential | null): Promise<ModelInfo[]> {
    const base = this.baseFor(cred);
    const token =
      cred?.apiKey?.trim() ||
      cred?.pasted?.access?.trim() ||
      cred?.oauth?.access?.trim() ||
      "";
    const models = await discoverRelayModels(base, token, cred?.pasted?.extraHeaders);
    const seen = new Set(models.map((model) => model.id));
    return [...models, ...this.extraModels.filter((model) => !seen.has(model.id))];
  }
}

/** 与 `createAdapter("relay", opts)` 等价的便捷工厂。 */
export function createRelayAdapter(options: RelayAdapterOptions = {}): RelayAdapter {
  return new RelayAdapter(options);
}
