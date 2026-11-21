/**
 * Super Work 核心类型契约。
 * 这是 server / providers / orchestrator / web 四方共用的唯一事实来源。
 * 任何一方需要扩展字段，先在 core 里加可选字段，不要各自发明。
 */

export type ProviderId =
  | "deepseek"
  | "deepseek-account"
  | "kimi"
  | "openai"
  | "anthropic"
  | "zhipu"
  | "qwen"
  | "volcengine"
  | "minimax"
  | "gemini"
  | "xai"
  | "thirdparty"
  | "workbuddy"
  | "relay"
  | "mock";

export type ProviderKind =
  | "openai-compat" // /chat/completions 协议
  | "openai-responses" // 订阅版 ChatGPT /responses
  | "anthropic" // /v1/messages 协议
  | "gemini" // generateContent 协议
  | "mock";

/** 一个凭证的取得方式。 */
export type AuthMode = "api-key" | "oauth-browser" | "device-code" | "token" | "local";

/** 模型强度档位（运行中可热调）。 */
export type EffortLevel = "low" | "medium" | "fast" | "max" | "ultra";

/** 凭证来源：用户在本站录入 / 从本机 DSH 复用 / 从环境变量导入。 */
export type CredentialSource = "user" | "local" | "env";

/** 官方购买 / 充值入口：只做站点跳转，软件不代收任何费用。 */
export interface ProviderPurchase {
  /** 获取 API Key 的官方控制台 */
  apiKeyUrl?: string;
  /** 充值 / 账单页面 */
  billingUrl?: string;
  /** 订阅（会员）购买页 */
  subscriptionUrl?: string;
  /** 计费方式说明（区分 API 按量与订阅制） */
  subscriptionNote?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** true = 推理型模型（展示思考过程） */
  reasoning?: boolean;
  vision?: boolean;
  /** 该模型通过哪种连接可用；不填 = 任意已连接凭证 */
  via?: "api" | "subscription" | "any";
  /** relay 提供方：中转站账号 id（provider=relay 时必填） */
  relayId?: string;
  /** 中转站上游的真实模型 ID（provider=relay 时使用） */
  remoteId?: string;
  /** 上游计费倍率（WorkBuddy 等积分制平台） */
  creditMultiplier?: number;
  /** 是否支持图片生成 */
  imageGen?: boolean;
  /** 中转站/平台展示名（provider=relay 时为站点名） */
  providerLabel?: string;
  /** 提供方平台名（WorkBuddy 等） */
  providedBy?: string;
  tags?: string[];
  note?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** v0.0.3：随消息携带的图片（data URL，多图有序）；适配器按平台映射为 image parts */
  images?: string[];
}

export interface OAuthToken {
  access: string;
  refresh?: string;
  /** 毫秒时间戳 */
  expiresAt?: number;
  accountId?: string;
  accountLabel?: string;
  tokenType?: string;
  scope?: string;
}

export interface PastedToken {
  /** bearer token 或 session/cookie 值 */
  access: string;
  kind: "bearer" | "cookie" | "session";
  cookieName?: string;
  extraHeaders?: Record<string, string>;
}

export interface Credential {
  provider: ProviderId;
  mode: AuthMode;
  source?: CredentialSource;
  /** api-key 模式 */
  apiKey?: string;
  /** 自定义 OpenAI 兼容端点（第三方 / 火山引擎 endpoint / 代理） */
  baseUrl?: string;
  /** oauth / device-code 模式 */
  oauth?: OAuthToken;
  /** token 粘贴模式 */
  pasted?: PastedToken;
  /** 展示名，如 "ChatGPT Pro" */
  label?: string;
  accountLabel?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatCallOptions {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** 推理强度（支持时透传） */
  reasoning?: "low" | "medium" | "high";
  /** 强度档位（5 档，ordinal 由 providers 映射到原生参数） */
  effort?: EffortLevel;
  /** 附加请求体字段（各家私有参数） */
  extras?: Record<string, unknown>;
  signal?: AbortSignal;
  /** 覆盖默认 baseUrl */
  baseUrl?: string;
}

export type ChatChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; stopReason?: string };

/** providers 包对外的统一适配器接口。 */
export interface ImageCallOptions {
  model: string;
  prompt: string;
  size?: string;
  n?: number;
  signal?: AbortSignal;
}

export interface ImageResult {
  images: Array<{ url?: string; b64?: string; mime?: string }>;
  /** WorkBuddy 等平台的积分消耗 */
  credit?: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  listModels(cred: Credential | null): Promise<ModelInfo[]>;
  /**
   * 实时模型目录（显式「更新模型」时调用）。
   *
   * 与 listModels 分开：listModels 走内置 catalog、离线可用（导入/校验用），
   * discoverModels 才真正请求上游目录，失败时由调用方记录错误。
   */
  discoverModels?(cred: Credential | null, callBaseUrl?: string): Promise<ModelInfo[]>;
  chat(opts: ChatCallOptions, cred: Credential | null): AsyncIterable<ChatChunk>;
  validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }>;
  /** 支持文生图的平台（WorkBuddy）实现它 */
  generateImage?(opts: ImageCallOptions, cred: Credential | null): Promise<ImageResult>;
}

export type AuthFlowKind = "oauth-browser" | "device-code" | "paste";

export interface AuthFlowStart {
  flowId: string;
  kind: AuthFlowKind;
  provider: ProviderId;
  /** 浏览器授权地址 */
  authorizeUrl?: string;
  /** 设备码流程展示给用户 */
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
  note?: string;
}

export type AuthFlowStatus =
  | { status: "pending"; note?: string }
  | { status: "done"; credential: Credential }
  | { status: "error"; message: string }
  | { status: "expired" };

export interface ProviderErrorShape {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
  provider?: ProviderId;
  detail?: string;
}
