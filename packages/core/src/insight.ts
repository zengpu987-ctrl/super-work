/** 上下文洞察 + 计费。 */
import type { ProviderId } from "./types.js";
import type { StageId } from "./events.js";

export type ContextSectionName =
  | "system"
  | "command"
  | "memory"
  | "reference"
  | "history"
  | "output";

export interface ContextSection {
  name: ContextSectionName;
  tokens: number;
}

/** 一次模型调用的上下文构成快照。 */
export interface ContextInsight {
  participantId: string;
  model: string;
  stage: StageId;
  sections: ContextSection[];
  /** 本次请求提示词总 token（估算） */
  promptTokens: number;
  contextWindow?: number;
  /** promptTokens / contextWindow，0~1 */
  utilization?: number;
  /** 召回但未注入的记忆 id */
  recalledMemoryIds?: string[];
  /** 实际注入的记忆 id */
  injectedMemoryIds?: string[];
}

export interface ContextRunSummary {
  runId: string;
  calls: Array<ContextInsight & { at: number }>;
  /** 单次调用峰值 token */
  peakPromptTokens: number;
  peakUtilization?: number;
  /** 上下文窗口最小的模型，便于提示"最紧的那根弦" */
  tightest?: { model: string; contextWindow: number; utilization: number };
  totalPromptTokens: number;
}

/* ------------------------------- 计费 ------------------------------- */

export interface ModelPrice {
  provider: ProviderId;
  /** 模型 ID；"*" 表示该 provider 下未单独定价的模型 */
  model: string;
  currency: "CNY" | "USD";
  inputPerMTokens: number;
  outputPerMTokens: number;
  cachedInputPerMTokens?: number;
  /** 积分制平台的倍率（WorkBuddy） */
  creditMultiplier?: number;
  updatedAt?: number;
}

export interface CostBreakdown {
  currency: "CNY" | "USD";
  inputCost: number;
  outputCost: number;
  totalCost: number;
  /** 没有定价（不显示 0 假装免费） */
  priced: boolean;
  credit?: number;
}

export interface BillingModelRow {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  cost: number;
  priced: boolean;
  currency: "CNY" | "USD";
  credit?: number;
}

export interface BillingWindow {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  currency: "CNY" | "USD";
  runs: number;
  /** 有未定价的模型 */
  hasUnpriced: boolean;
}

export interface BillingSummary {
  today: BillingWindow;
  month: BillingWindow;
  all: BillingWindow;
  byModel: BillingModelRow[];
  /** 最近 30 天，按天 */
  daily: Array<{ day: string; tokens: number; cost: number; runs: number }>;
  /** 导入的 DSH 账本行数（0 表示无历史数据） */
  importedRows: number;
  generatedAt: number;
}

/** DSH TokenLedger 一行（导入用）。 */
export interface DshLedgerRow {
  sessionId?: string;
  day: string;
  site: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  requests: number;
}
