/** 中转站（模型聚合/转售平台）与 WorkBuddy 导入相关类型。 */
import type { ModelInfo, ProviderId } from "./types.js";

export type RelayKind = "openai-compat" | "workbuddy";

/** 中转站/平台预设：贾维斯官网、Devin、WorkBuddy，以及自定义。 */
export interface RelayPreset {
  id: string;
  name: string;
  kind: RelayKind;
  /** 预填的 Base URL（可留空，用户自己填） */
  baseUrl?: string;
  /** 说明与获取 Key 的地址 */
  note: string;
  docsUrl?: string;
  requiresKey: boolean;
  /** true = 可从本机已登录客户端自动导入（目前只有 WorkBuddy） */
  localDetect?: boolean;
}

export const RELAY_PRESETS: RelayPreset[] = [
  {
    id: "jarvis",
    name: "贾维斯官网（我的贾维斯）",
    kind: "openai-compat",
    baseUrl: "https://api.aijws.com/v1",
    docsUrl: "https://api.aijws.com",
    note: "OpenAI 兼容中转站。默认 Base URL 已填 https://api.aijws.com/v1；填入 API Key 后自动拉取 Claude / GPT 模型。本机 DSH 的 JWS_API_KEY / JWS1_API_KEY 可直接复用（见 docs/JARVIS.md）。",
    requiresKey: true,
  },
  {
    id: "devin",
    name: "Devin",
    kind: "openai-compat",
    baseUrl: "",
    note: "Devin 中转/代理端点。填入 Base URL 与 Key；如果上游用非 OpenAI 协议，请选「自定义 Header」并在模型 ID 里填上游真实名称。",
    requiresKey: true,
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    kind: "workbuddy",
    note: "自动读取本机 WorkBuddy 登录态（国内版 / 国际版），导入 50+ 模型（含 Kimi K3.1 Pro、GLM-5.3、DeepSeek-V4-Pro 与生图模型）。",
    requiresKey: false,
    localDetect: true,
  },
  {
    id: "custom",
    name: "自定义中转站",
    kind: "openai-compat",
    baseUrl: "",
    note: "任意 OpenAI 兼容端点：one-api / new-api / OpenRouter / 自建网关。",
    requiresKey: true,
  },
];

export interface RelayModel {
  /** 上游真实模型 ID */
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  imageGen?: boolean;
  videoGen?: boolean;
  creditMultiplier?: number;
  enabled: boolean;
}

export interface RelayAccount {
  id: string;
  name: string;
  kind: RelayKind;
  presetId?: string;
  baseUrl: string;
  /** 是否已配置凭证（密钥本身永不回传前端） */
  hasKey: boolean;
  /** WorkBuddy 登录账号展示名 */
  accountLabel?: string;
  source: "manual" | "preset" | "local";
  enabled: boolean;
  models: RelayModel[];
  /** 最近一次发现模型的时间 */
  discoveredAt?: number;
  credits?: { balance?: number; currency?: string; multiplier?: number };
  health: "unknown" | "ok" | "error";
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RelayCreateRequest {
  name: string;
  kind: RelayKind;
  presetId?: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

export interface RelayUpdateRequest {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  enabled?: boolean;
  modelIds?: string[];
}

export interface RelayDiscoverResponse {
  models: RelayModel[];
  accountLabel?: string;
  credits?: { balance?: number; currency?: string; multiplier?: number };
  detail?: string;
}

export function relayModelToModelInfo(relay: RelayAccount, model: RelayModel): ModelInfo {
  return {
    // relay 模型用 "<relayId>::<remoteId>" 做全局唯一 id
    id: `${relay.id}::${model.id}`,
    name: model.name,
    provider: "relay",
    providerLabel: relay.name,
    relayId: relay.id,
    remoteId: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    vision: model.supportsImages,
    reasoning: model.supportsReasoning,
    imageGen: model.imageGen,
    creditMultiplier: model.creditMultiplier,
  } as ModelInfo;
}

export function workbuddyModelToModelInfo(model: RelayModel): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    provider: "workbuddy",
    providedBy: "WorkBuddy",
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    vision: model.supportsImages,
    reasoning: model.supportsReasoning,
    imageGen: model.imageGen,
    creditMultiplier: model.creditMultiplier,
  } as ModelInfo;
}

export type RelayProviderId = Extract<ProviderId, "relay" | "workbuddy">;
