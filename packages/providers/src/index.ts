/**
 * @super-work/providers 对外入口。
 *
 * 三个契约函数（DESIGN §5）：
 *   createAdapter(id, opts?)              → 按 provider 创建默认适配器
 *   adapterForCall(provider, cred)        → 按凭证模式选择 API / 订阅适配器
 *   listRemoteModels(provider, cred)      → 探测远端 /models（失败抛可读错误）
 *
 * 以及全部适配器类、SSE 解析、错误类型与工具函数。
 */
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from "@super-work/core";
import { AnthropicAdapter } from "./anthropic.js";
import { DeepSeekAccountAdapter } from "./deepseek-account.js";
import { ProviderConfigError } from "./errors.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiHybridAdapter, KimiSubscriptionAdapter } from "./kimi-subscription.js";
import { MockAdapter } from "./mock.js";
import { OPENAI_COMPAT_PROVIDER_IDS, OpenAICompatAdapter } from "./openai-compat.js";
import { OpenAIResponsesAdapter } from "./openai-responses.js";
import { RelayAdapter } from "./relay.js";
import { WorkBuddyAdapter } from "./workbuddy.js";

/* ------------------------------------------------------------------ */
/* 重导出：错误 / SSE / 工具                                            */
/* ------------------------------------------------------------------ */

export {
  BODY_SNIPPET_LIMIT,
  ProviderConfigError,
  ProviderHttpError,
  httpErrorFromResponse,
  isProviderConfigError,
  isProviderHttpError,
  snippet,
} from "./errors.js";
export type {
  ProviderConfigErrorDetails,
  ProviderHttpErrorDetails,
} from "./errors.js";

export { SseChannel, parseSse, sseChannel } from "./sse.js";

export {
  anthropicContent,
  geminiParts,
  hasImages,
  messageImages,
  openAIChatContent,
  parseImageDataUrl,
  responsesContent,
} from "./images.js";
export type { ParsedImageData } from "./images.js";

export {
  MODELS_UNAVAILABLE_DETAIL,
  isMissingModelsEndpointError,
  validationResultFromError,
} from "./validation.js";
export type { ValidateResult } from "./validation.js";
export type { SseChannelOptions, SseMessage } from "./sse.js";

export {
  DEFAULT_TIMEOUT_MS,
  abortError,
  asRecord,
  createCallContext,
  credentialAuth,
  errorFromUpstreamPayload,
  estimateTokens,
  fetchOrThrow,
  firstCredentialToken,
  getArray,
  getNumber,
  getProp,
  getString,
  hasUsage,
  isAbortError,
  joinUrl,
  mergeUsage,
  normalizeOpenAIUsage,
  normalizeProviderError,
  readJsonBody,
  resolveBaseUrl,
  sleep,
  throwIfAborted,
  trimBaseUrl,
} from "./util.js";
export type { CallContext, CredentialAuth } from "./util.js";

/* ------------------------------------------------------------------ */
/* 重导出：适配器与协议辅助                                             */
/* ------------------------------------------------------------------ */

export {
  OPENAI_COMPAT_PROVIDER_IDS,
  OpenAICompatAdapter,
  catalogModels,
  createOpenAICompatAdapter,
  effortReasoningLevel,
  mapOpenAIStopReason,
  reasoningExtras,
  usesMaxCompletionTokens,
} from "./openai-compat.js";
export type { OpenAICompatOptions } from "./openai-compat.js";

export {
  ANTHROPIC_VERSION,
  AnthropicAdapter,
  anthropicAuthHeaders,
  buildAnthropicBody,
  createAnthropicAdapter,
  mapAnthropicStopReason,
  streamAnthropicChannel,
  streamAnthropicResponse,
} from "./anthropic.js";
export type { AnthropicAdapterOptions } from "./anthropic.js";

export {
  DeepSeekAccountAdapter,
  createDeepSeekAccountAdapter,
} from "./deepseek-account.js";

export {
  GeminiAdapter,
  createGeminiAdapter,
  geminiInlinePart,
  mapGeminiFinishReason,
  normalizeGeminiUsage,
  supportsGeminiThinkingBudget,
} from "./gemini.js";
export type { GeminiAdapterOptions } from "./gemini.js";

export {
  DEFAULT_CODEX_BASE_URL,
  OpenAIResponsesAdapter,
  createOpenAIResponsesAdapter,
  responsesEndpoint,
} from "./openai-responses.js";
export type { OpenAIResponsesOptions } from "./openai-responses.js";

export {
  DEFAULT_KIMI_CODING_BASE_URL,
  KIMI_CLI_USER_AGENT,
  KIMI_DEFAULT_MAX_TOKENS,
  KimiHybridAdapter,
  KimiSubscriptionAdapter,
  createKimiSubscriptionAdapter,
  isKimiSubscriptionModel,
  routeKimiCall,
} from "./kimi-subscription.js";
export type { KimiSubscriptionOptions } from "./kimi-subscription.js";

export { MockAdapter, createMockAdapter, splitIntoBlocks } from "./mock.js";
export type { MockAdapterOptions } from "./mock.js";

export { openaiCompatChunks } from "./openai-compat.js";

export { RelayAdapter, createRelayAdapter, discoverRelayModels } from "./relay.js";
export type { RelayAdapterOptions } from "./relay.js";

export {
  WORKBUDDY_CN_CATALOG_BASE,
  WORKBUDDY_CN_CHAT_BASE,
  WORKBUDDY_FALLBACK_SYSTEM_PROMPT,
  WORKBUDDY_GLOBAL_BASE,
  WORKBUDDY_GLOBAL_CODEBUDDY_BASE,
  WORKBUDDY_ID,
  WORKBUDDY_IMAGE_TIMEOUT_MS,
  WORKBUDDY_PRODUCT_USER_AGENT,
  WORKBUDDY_USER_AGENT,
  WORKBUDDY_VISION_MODEL,
  WorkBuddyAdapter,
  buildWorkBuddyChatBody,
  createWorkBuddyAdapter,
  describeImageWithWorkbuddy,
  workbuddyIdentity,
} from "./workbuddy.js";
export type {
  DescribeImageOptions,
  WorkBuddyAdapterOptions,
  WorkBuddyIdentity,
} from "./workbuddy.js";

/* ------------------------------------------------------------------ */
/* 工厂                                                                 */
/* ------------------------------------------------------------------ */

export interface AdapterOptions {
  /** 显式端点，优先级：单次调用 opts.baseUrl > 这里的 baseUrl > cred.baseUrl > catalog 默认 */
  baseUrl?: string;
  /** 追加 / 覆盖的模型清单（手动添加模型时用） */
  models?: ModelInfo[];
  /** 单次请求超时（默认 180s） */
  timeoutMs?: number;
}

/**
 * 按 provider 创建"默认形态"的适配器。
 * 注意：订阅通道由 adapterForCall 依据凭证模式选择，这里默认是 API 形态
 * （mock / anthropic / gemini 本身没有订阅分支）。
 */
export function createAdapter(id: ProviderId, opts: AdapterOptions = {}): ProviderAdapter {
  switch (id) {
    case "mock":
      return new MockAdapter({ models: opts.models, timeoutMs: opts.timeoutMs });
    case "anthropic":
      return new AnthropicAdapter(opts);
    case "deepseek-account":
      return new DeepSeekAccountAdapter(opts);
    case "gemini":
      return new GeminiAdapter(opts);
    case "kimi":
      return new OpenAICompatAdapter({ id: "kimi", ...opts });
    case "openai":
      return new OpenAICompatAdapter({ id: "openai", ...opts });
    case "thirdparty":
      return new OpenAICompatAdapter({ id: "thirdparty", ...opts });
    case "relay":
      return new RelayAdapter(opts);
    case "workbuddy":
      return new WorkBuddyAdapter(opts);
    default:
      if (!OPENAI_COMPAT_PROVIDER_IDS.includes(id)) {
        throw new ProviderConfigError(`未知 provider：${String(id)}`);
      }
      return new OpenAICompatAdapter({ id, ...opts });
  }
}

/** OpenAI 凭证是否应走 ChatGPT 订阅（Responses）通道。 */
export function isOpenAIResponsesCredential(cred: Credential | null): boolean {
  if (!cred) return false;
  if (cred.mode === "oauth-browser") return true; // 官方 OAuth 登录
  if (cred.mode === "local") return true; // 本机登录态复用
  if (cred.source === "local" && (cred.oauth?.access || cred.pasted?.access) && !cred.apiKey) {
    return true;
  }
  return false;
}

/** Kimi 凭证是否包含会员订阅成分。 */
export function isKimiSubscriptionCredential(cred: Credential | null): boolean {
  if (!cred) return false;
  if (cred.mode === "device-code") return true; // 官方设备码
  if (cred.mode === "local") return true; // 本机登录态复用
  if (cred.source === "local" && (cred.oauth?.access || cred.pasted?.access) && !cred.apiKey) {
    return true;
  }
  return false;
}

/**
 * 依据凭证模式选择适配器：
 * - mock → 演示适配器；
 * - anthropic / gemini → 各自协议；
 * - openai：oauth-browser / local 复用 → ChatGPT 订阅（openai-responses），否则 API key；
 * - kimi：device-code 或本机订阅登录 → 会员订阅（kimi-subscription），
 *         同时带 API key 时用混合适配器按模型选路；否则 API key 版 openai-compat；
 * - relay → 中转站适配器（OpenAI 兼容，baseUrl 来自账号凭证）；
 * - workbuddy → WorkBuddy 适配器（模型目录 / SSE 对话 / 生图）；
 * - 其余（deepseek / zhipu / qwen / volcengine / minimax / xai / thirdparty）→ openai-compat。
 *
 * 无凭证（null）时返回该 provider 的默认形态；调用 chat() 时才给出"缺少凭证"的可读错误。
 */
export function adapterForCall(
  provider: ProviderId,
  cred: Credential | null,
): ProviderAdapter {
  switch (provider) {
    case "mock":
      return new MockAdapter();
    case "anthropic":
      return new AnthropicAdapter();
    case "deepseek-account":
      return new DeepSeekAccountAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "openai":
      return isOpenAIResponsesCredential(cred)
        ? new OpenAIResponsesAdapter()
        : new OpenAICompatAdapter({ id: "openai" });
    case "kimi": {
      if (isKimiSubscriptionCredential(cred)) {
        return cred?.apiKey?.trim() ? new KimiHybridAdapter() : new KimiSubscriptionAdapter();
      }
      return new OpenAICompatAdapter({ id: "kimi" });
    }
    case "thirdparty":
      return new OpenAICompatAdapter({ id: "thirdparty" });
    case "relay":
      return new RelayAdapter();
    case "workbuddy":
      return new WorkBuddyAdapter();
    case "deepseek":
    case "zhipu":
    case "qwen":
    case "volcengine":
    case "minimax":
    case "xai":
      return new OpenAICompatAdapter({ id: provider });
    default:
      throw new ProviderConfigError(`未知 provider：${String(provider)}`);
  }
}

/**
 * 远端模型探测：按凭证选对通道后调用 listModels。
 * 网络 / 鉴权失败会抛 ProviderHttpError，配置缺失抛 ProviderConfigError（消息可直接展示给用户）。
 */
export async function listRemoteModels(
  provider: ProviderId,
  cred: Credential | null,
): Promise<ModelInfo[]> {
  return adapterForCall(provider, cred).listModels(cred);
}
