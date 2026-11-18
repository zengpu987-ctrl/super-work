import type { AuthMode, ModelInfo, ProviderId, ProviderKind, ProviderPurchase } from "./types.js";

export interface SubscriptionMeta {
  kind: "oauth-browser" | "device-code" | "token";
  label: string;
  note?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  /** 中文展示名 */
  name: string;
  /** 徽标短名 */
  short: string;
  /** 品牌色（UI 用） */
  color: string;
  kind: ProviderKind;
  defaultBaseUrl?: string;
  docsUrl?: string;
  authModes: AuthMode[];
  subscription?: SubscriptionMeta;
  models: ModelInfo[];
  note?: string;
  /** 是否属于"联合工作"默认可选池 */
  defaultPool?: boolean;
}

const m = (
  provider: ProviderId,
  id: string,
  name: string,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({ id, name, provider, ...extra });

export const PROVIDERS: ProviderMeta[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    short: "DS",
    color: "#4d6bfe",
    kind: "openai-compat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://platform.deepseek.com/api_keys",
    authModes: ["api-key", "local", "token"],
    subscription: {
      kind: "token",
      label: "复用本机登录态",
      note: "DeepSeek 未开放订阅 OAuth；可从本机 DSH 复用 API key，或粘贴 Bearer token。",
    },
    defaultPool: true,
    note: "模型目录 2026-11-18 更新（live /models：deepseek-v4-pro / deepseek-flash）。",
    models: [
      m("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
        vision: true,
      }),
      m("deepseek", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash", {
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        reasoning: true,
        vision: true,
      }),
      m("deepseek", "deepseek-flash", "DeepSeek Flash", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
      }),
      m("deepseek", "deepseek-v3.2", "DeepSeek V3.2（兼容）", { contextWindow: 131072 }),
    ],
  },
  {
    id: "kimi",
    name: "KIMI",
    short: "KM",
    color: "#0b0b0f",
    kind: "openai-compat",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.moonshot.cn/console/api-keys",
    authModes: ["api-key", "device-code", "local", "token"],
    subscription: {
      kind: "device-code",
      label: "Kimi 会员订阅（设备码登录）",
      note: "官方设备码授权，用会员额度跑 K3.1 Pro / K3。",
    },
    defaultPool: true,
    note: "API 模型来自 live /models（kimi-k3.1-pro / k2.7-code / k2.6 / k3）；订阅目录对齐会员实时接口（2026-11-19 /coding/v1/models）：k3.1-pro、k3、k3-256k、kimi-for-coding、两个 highspeed。",
    models: [
      m("kimi", "kimi-k3.1-pro", "Kimi K3.1 Pro（API）", {
        contextWindow: 1000000,
        maxOutputTokens: 32000,
        reasoning: true,
        vision: true,
        via: "api",
      }),
      m("kimi", "kimi-k3", "Kimi K3（API）", {
        contextWindow: 1000000,
        maxOutputTokens: 32000,
        reasoning: true,
        vision: true,
        via: "api",
      }),
      m("kimi", "kimi-k2.7-code", "Kimi K2.7 Code", {
        contextWindow: 1000000,
        maxOutputTokens: 32000,
        via: "api",
        tags: ["code"],
      }),
      m("kimi", "kimi-k2.6", "Kimi K2.6", { contextWindow: 1000000, via: "api" }),
      m("kimi", "k3.1-pro", "Kimi K3.1 Pro（会员）", {
        contextWindow: 1048576,
        maxOutputTokens: 32768,
        reasoning: true,
        via: "subscription",
        tags: ["subscription"],
      }),
      m("kimi", "k3", "Kimi K3（会员）", { contextWindow: 1048576, via: "subscription", tags: ["subscription"] }),
      m("kimi", "k3-256k", "Kimi K3 256K", { contextWindow: 262144, via: "subscription", tags: ["subscription"] }),
      m("kimi", "kimi-for-coding", "Kimi For Coding（K2.8）", {
        contextWindow: 1048576,
        reasoning: true,
        vision: true,
        via: "subscription",
        tags: ["subscription", "code"],
      }),
      m("kimi", "kimi-for-coding-highspeed", "Kimi For Coding Highspeed（K2.7 2x）", {
        contextWindow: 262144,
        reasoning: true,
        vision: true,
        via: "subscription",
        tags: ["subscription", "code"],
      }),
      m("kimi", "k3.1-pro-highspeed", "K3.1 Pro Highspeed（2x）", {
        contextWindow: 1048576,
        reasoning: true,
        vision: true,
        via: "subscription",
        tags: ["subscription"],
      }),
    ],
  },
  {
    id: "openai",
    name: "GPT / OpenAI",
    short: "GPT",
    color: "#10a37f",
    kind: "openai-compat",
    defaultBaseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/api-keys",
    authModes: ["api-key", "oauth-browser", "local", "token"],
    subscription: {
      kind: "oauth-browser",
      label: "ChatGPT 订阅登录（官方 OAuth）",
      note: "浏览器 PKCE 授权，用 ChatGPT Plus/Pro 额度；通过 Codex 后端调用。",
    },
    defaultPool: true,
    note: "订阅模型对齐 Codex 实时目录（2026-11-19 /codex/models）：gpt-6.2-sol/astra、gpt-6.1-terra/sol、gpt-6-astra/luna/sol、gpt-5.6-luna/sol/terra。",
    models: [
      m("openai", "gpt-6.2-sol", "GPT-6.2 Sol", {
        contextWindow: 500000,
        reasoning: true,
        vision: true,
        via: "subscription",
        tags: ["flagship", "subscription"],
      }),
      m("openai", "gpt-6.2-astra", "GPT-6.2 Astra", {
        contextWindow: 272000,
        reasoning: true,
        vision: true,
        via: "subscription",
        tags: ["subscription"],
      }),
      m("openai", "gpt-6.1-terra", "GPT-6.1 Terra", {
        contextWindow: 500000,
        maxOutputTokens: 128000,
        reasoning: true,
        via: "any",
        tags: ["flagship"],
      }),
      m("openai", "gpt-6.1-sol", "GPT-6.1 Sol", {
        contextWindow: 500000,
        maxOutputTokens: 128000,
        reasoning: true,
        via: "any",
      }),
      m("openai", "gpt-6-astra", "GPT-6 Astra", {
        contextWindow: 272000,
        reasoning: true,
        via: "subscription",
        tags: ["subscription"],
      }),
      m("openai", "gpt-6-luna", "GPT-6 Luna", { contextWindow: 272000, reasoning: true, via: "subscription" }),
      m("openai", "gpt-6-sol", "GPT-6 Sol", { contextWindow: 272000, reasoning: true, via: "subscription" }),
      m("openai", "gpt-5.6-terra", "GPT-5.6 Terra", { contextWindow: 272000, reasoning: true, via: "subscription" }),
      m("openai", "gpt-5.6-sol", "GPT-5.6 Sol", { contextWindow: 272000, via: "subscription" }),
      m("openai", "gpt-5.6-luna", "GPT-5.6 Luna", { contextWindow: 272000, via: "subscription" }),
    ],
  },
  {
    id: "anthropic",
    name: "Claude",
    short: "CL",
    color: "#d97757",
    kind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    docsUrl: "https://console.anthropic.com/settings/keys",
    authModes: ["api-key", "token", "local"],
    subscription: {
      kind: "token",
      label: "Claude 订阅凭证",
      note: "Anthropic 未开放第三方订阅 OAuth；可粘贴 Claude Code 的 OAuth token（Bearer）。",
    },
    defaultPool: true,
    note: "2026 当前世代：Claude Opus 5.5 / Sonnet 5.5（Haiku 4.5 作为轻量选择保留）。",
    models: [
      m("anthropic", "claude-opus-5-5", "Claude Opus 5.5", {
        contextWindow: 500000,
        maxOutputTokens: 64000,
        reasoning: true,
      }),
      m("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", {
        contextWindow: 500000,
        maxOutputTokens: 64000,
        reasoning: true,
      }),
      m("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", { contextWindow: 200000, maxOutputTokens: 16000 }),
    ],
  },
  {
    id: "zhipu",
    name: "GLM / 智谱",
    short: "GLM",
    color: "#3859ff",
    kind: "openai-compat",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://bigmodel.cn/usercenter/apikeys",
    authModes: ["api-key", "token"],
    defaultPool: true,
    note: "GLM-5.3 为 2026 旗舰（1M 上下文 / 128K 输出 / 三档推理）。",
    models: [
      m("zhipu", "glm-5.3", "GLM-5.3", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
        vision: true,
      }),
      m("zhipu", "glm-5.3-flash", "GLM-5.3 Flash", { contextWindow: 1000000, maxOutputTokens: 131072, reasoning: true }),
      m("zhipu", "glm-5.2", "GLM-5.2", { contextWindow: 1000000, maxOutputTokens: 64000, reasoning: true }),
      m("zhipu", "glm-4.7", "GLM-4.7", { contextWindow: 200000, reasoning: true }),
      m("zhipu", "glm-4.6v", "GLM-4.6V（视觉）", { contextWindow: 128000, vision: true }),
    ],
  },
  {
    id: "qwen",
    name: "千问 / Qwen",
    short: "QW",
    color: "#615ced",
    kind: "openai-compat",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://bailian.console.aliyun.com/",
    authModes: ["api-key", "local", "token"],
    defaultPool: true,
    note: "Qwen4-Max 于 2026-11-16 发布；Qwen3.8 系列为当前主力。",
    models: [
      m("qwen", "qwen4-max", "Qwen4 Max", {
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        reasoning: true,
        vision: true,
        tags: ["flagship"],
      }),
      m("qwen", "qwen3.8-max", "Qwen3.8 Max", {
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        reasoning: true,
        vision: true,
      }),
      m("qwen", "qwen3.8-flash", "Qwen3.8 Flash", {
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        reasoning: true,
        vision: true,
      }),
      m("qwen", "qwen3.8-omni-flash", "Qwen3.8 Omni Flash", {
        contextWindow: 1000000,
        vision: true,
        reasoning: true,
        tags: ["omni"],
      }),
    ],
  },
  {
    id: "volcengine",
    name: "火山引擎 / 豆包",
    short: "VOLC",
    color: "#1664ff",
    kind: "openai-compat",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docsUrl: "https://console.volcengine.com/ark",
    authModes: ["api-key", "token"],
    defaultPool: true,
    note: "模型名可填方舟推理接入点 ID（ep-xxx）；Seed-Evolving 为 2026 文档中的最新模型，具体 ID 以方舟控制台为准。",
    models: [
      m("volcengine", "doubao-seed-evolving", "豆包 Seed-Evolving", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
        vision: true,
        tags: ["flagship"],
      }),
      m("volcengine", "doubao-seed-2.1", "豆包 Seed 2.1", {
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        reasoning: true,
        vision: true,
      }),
      m("volcengine", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash（方舟）", {
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        reasoning: true,
        vision: true,
      }),
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    short: "MM",
    color: "#ff4d4f",
    kind: "openai-compat",
    defaultBaseUrl: "https://api.minimax.chat/v1",
    docsUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    authModes: ["api-key", "token"],
    defaultPool: true,
    note: "2026 世代：MiniMax-M3（6 月）/ M3.1 Flash（10 月）/ M2.7 / M2.5。",
    models: [
      m("minimax", "MiniMax-M3", "MiniMax M3", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
        vision: true,
        tags: ["flagship"],
      }),
      m("minimax", "MiniMax-M3.1-Flash", "MiniMax M3.1 Flash", {
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        reasoning: true,
        vision: true,
      }),
      m("minimax", "MiniMax-M2.7", "MiniMax M2.7", { contextWindow: 200000, reasoning: true }),
      m("minimax", "MiniMax-M2.5", "MiniMax M2.5", { contextWindow: 200000, reasoning: true }),
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    short: "GM",
    color: "#4285f4",
    kind: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    docsUrl: "https://aistudio.google.com/apikey",
    authModes: ["api-key", "token"],
    subscription: {
      kind: "token",
      label: "Google 订阅凭证",
      note: "Gemini 订阅（AI Pro/Ultra）走 Google OAuth；当前支持粘贴 OAuth access token。",
    },
    defaultPool: true,
    note: "Gemini 3.1 Pro / 3.1 Flash 为当前世代（preview 期间模型名可能带 -preview）。",
    models: [
      m("gemini", "gemini-3.1-pro", "Gemini 3.1 Pro", {
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        reasoning: true,
        vision: true,
        tags: ["flagship"],
      }),
      m("gemini", "gemini-3.1-flash", "Gemini 3.1 Flash", {
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        vision: true,
      }),
      m("gemini", "gemini-3-pro", "Gemini 3 Pro（兼容）", { contextWindow: 1000000, reasoning: true, vision: true }),
    ],
  },
  {
    id: "xai",
    name: "Grok / xAI",
    short: "GRK",
    color: "#111827",
    kind: "openai-compat",
    defaultBaseUrl: "https://api.x.ai/v1",
    docsUrl: "https://console.x.ai/",
    authModes: ["api-key", "token"],
    defaultPool: true,
    note: "Grok 4.7 为当前最新（Bedrock 模型卡 2026）。",
    models: [
      m("xai", "grok-4.7", "Grok 4.7", {
        contextWindow: 512000,
        maxOutputTokens: 64000,
        reasoning: true,
        vision: true,
        tags: ["flagship"],
      }),
      m("xai", "grok-4.1", "Grok 4.1（兼容）", { contextWindow: 256000, reasoning: true }),
      m("xai", "grok-code-fast-1", "Grok Code Fast", { contextWindow: 256000, tags: ["code"] }),
    ],
  },
  {
    id: "thirdparty",
    name: "第三方 / 自建",
    short: "3RD",
    color: "#64748b",
    kind: "openai-compat",
    defaultBaseUrl: "",
    docsUrl: "",
    authModes: ["api-key", "token"],
    note: "任意 OpenAI 兼容端点：OpenRouter、硅基流动、DeepInfra、Ollama、one-api 网关等；模型可手动添加。",
    models: [],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    short: "WB",
    color: "#009273",
    kind: "openai-compat",
    defaultBaseUrl: "https://copilot.tencent.com",
    docsUrl: "https://www.codebuddy.cn",
    authModes: ["local"],
    subscription: {
      kind: "token",
      label: "本机 WorkBuddy 登录",
      note: "读取本机 WorkBuddy 账号（国内版/国际版），模型目录来自上游，按积分倍率计费。",
    },
    note: "模型在「设置 → 中转站 → WorkBuddy」里一键导入，目录随上游实时更新。",
    models: [],
  },
  {
    id: "relay",
    name: "中转站",
    short: "RLY",
    color: "#7c8cf8",
    kind: "openai-compat",
    authModes: ["api-key"],
    note: "贾维斯官网 / Devin / 自定义 OpenAI 兼容中转站，在设置里导入模型。",
    models: [],
  },
  {
    id: "mock",
    name: "演示模型",
    short: "DEMO",
    color: "#94a3b8",
    kind: "mock",
    authModes: [],
    note: "离线演示与自检用，不需要任何 key。",
    models: [
      m("mock", "mock-fast", "Demo Fast", { contextWindow: 32000 }),
      m("mock", "mock-thinker", "Demo Thinker", { contextWindow: 32000, reasoning: true }),
    ],
  },
];


/**
 * 各平台的官方购买 / 充值 / 订阅入口（只做跳转，软件不代收费用）。
 * 单价与可用性以各平台官网为准；入口打不开时用平台控制台首页。
 */
export const PROVIDER_PURCHASE: Partial<Record<ProviderId, ProviderPurchase>> = {
  deepseek: {
    apiKeyUrl: "https://platform.deepseek.com/api_keys",
    billingUrl: "https://platform.deepseek.com/top_up",
    subscriptionNote: "DeepSeek 为按量计费，无订阅制；也可直接复用本机 DSH 登录态。",
  },
  kimi: {
    apiKeyUrl: "https://platform.moonshot.cn/console/api-keys",
    billingUrl: "https://platform.moonshot.cn/console/account",
    subscriptionUrl: "https://www.kimi.com/",
    subscriptionNote: "Kimi 会员（coding 权益）与 API 是两套计费；会员可从本机 DSH 一键复用。",
  },
  openai: {
    apiKeyUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    subscriptionUrl: "https://chatgpt.com/pricing",
    subscriptionNote: "ChatGPT 订阅可在本应用走官方 OAuth 登录；API 用量单独计费。",
  },
  anthropic: {
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    billingUrl: "https://console.anthropic.com/settings/billing",
    subscriptionUrl: "https://claude.ai/upgrade",
    subscriptionNote: "Claude 订阅未开放第三方 OAuth；本应用支持粘贴本机登录 token 复用。",
  },
  zhipu: {
    apiKeyUrl: "https://bigmodel.cn/usercenter/apikeys",
    billingUrl: "https://bigmodel.cn/usercenter/recharge",
    subscriptionUrl: "https://bigmodel.cn/",
    subscriptionNote: "智谱有 API 按量与 Coding 订阅两种，入口都在 bigmodel 控制台。",
  },
  qwen: {
    apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    billingUrl: "https://bailian.console.aliyun.com/",
    subscriptionNote: "百炼按量计费；新用户可先领取免费额度。",
  },
  volcengine: {
    apiKeyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    billingUrl: "https://console.volcengine.com/finance/",
    subscriptionNote: "方舟按量计费，生图 / 视频按时长或张数计费。",
  },
  minimax: {
    apiKeyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    billingUrl: "https://platform.minimaxi.com/user-center/payment/balance",
    subscriptionNote: "API 按量计费。",
  },
  gemini: {
    apiKeyUrl: "https://aistudio.google.com/apikey",
    billingUrl: "https://console.cloud.google.com/billing",
    subscriptionUrl: "https://gemini.google.com/",
    subscriptionNote: "Google AI Studio 有免费额度；Gemini 会员与 API 是两套体系。",
  },
  xai: {
    apiKeyUrl: "https://console.x.ai/",
    billingUrl: "https://console.x.ai/team/default/billing",
    subscriptionUrl: "https://grok.com/",
    subscriptionNote: "SuperGrok 订阅与 xAI API 分开计费。",
  },
  workbuddy: {
    subscriptionNote: "WorkBuddy 为积分制，本应用自动读取本机登录态；充值 / 续费请在 WorkBuddy 客户端或官网完成。",
  },
  relay: {
    subscriptionNote: "中转站由各站点自行计费，本应用只保存你的 API Key，不代收费用。",
  },
  thirdparty: {
    subscriptionNote: "自建 / 兼容端点由你自行搭建与计费。",
  },
  mock: {
    subscriptionNote: "演示模型完全本地运行，不产生任何费用。",
  },
};

export const PROVIDER_BY_ID: Record<ProviderId, ProviderMeta> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
) as Record<ProviderId, ProviderMeta>;

/** 默认参与联合工作的 6 家主力模型（用户可在 UI 里改）。 */
export const DEFAULT_POOL: Array<{ provider: ProviderId; model: string; role: string }> = [
  { provider: "openai", model: "gpt-6.1-terra", role: "总协调 / 综合" },
  { provider: "anthropic", model: "claude-opus-5-5", role: "深度分析" },
  { provider: "kimi", model: "k3.1-pro", role: "长文与代码" },
  { provider: "deepseek", model: "deepseek-v4-pro", role: "推理校验" },
  { provider: "qwen", model: "qwen4-max", role: "资料整合" },
  { provider: "gemini", model: "gemini-3.1-pro", role: "多模态视角" },
];

export function findModel(provider: ProviderId, modelId: string): ModelInfo | undefined {
  return PROVIDER_BY_ID[provider]?.models.find((x) => x.id === modelId);
}

export function modelsForProvider(provider: ProviderId, extra: ModelInfo[] = []): ModelInfo[] {
  const base = PROVIDER_BY_ID[provider]?.models ?? [];
  const seen = new Set(base.map((x) => x.id));
  return [...base, ...extra.filter((x) => !seen.has(x.id))];
}
