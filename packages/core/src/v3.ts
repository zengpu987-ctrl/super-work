/** v0.0.3 新增契约：自定义角色、附件、预算/性能、关键词、插件中心。 */
import type { EffortLevel, ProviderId } from "./types.js";
import type { ParticipantSpec, RunMode } from "./events.js";

/* ----------------------------- 自定义角色 ----------------------------- */

export interface CustomRoleDef {
  id: string;
  name: string;
  description: string;
  /** text = 产出文本；image = 直接调用图像模型 */
  kind: "text" | "image";
  /** 排序（内置角色固定 0-7，自定义从 100 开始） */
  order: number;
}

/* -------------------------------- 附件 -------------------------------- */

export type AttachmentKind = "image" | "pdf" | "docx" | "doc" | "code" | "text" | "other";

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** 提取出的纯文本（代码/文本/PDF/Word） */
  chars?: number;
  preview?: string;
  /** 图片缩略图或原图的 data URL（仅小图返回） */
  dataUrl?: string;
  /** 服务端保存路径（相对 ~/.super-work） */
  path?: string;
  /** 解析失败时的可读原因 */
  error?: string;
  createdAt?: number;
}

/** 随运行请求提交的附件（文本已由服务端解析并带回） */
export interface AttachmentInput {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** 提取出的文本；图片可为空 */
  text?: string;
  path?: string;
  size?: number;
}

export interface UploadResponse {
  attachment: AttachmentMeta & { text?: string };
}

/* --------------------------- 预算 / 性能 ---------------------------- */

export interface BudgetSettings {
  currency: "CNY" | "USD";
  /** 每日成本上限（不填 = 不限） */
  dailyCostLimit?: number;
  dailyTokenLimit?: number;
  perRunCostLimit?: number;
  perRunTokenLimit?: number;
  /** 单次调用输出上限（会再与模型上限、档位夹紧） */
  perCallMaxTokens?: number;
  /** 达到该百分比发出预警（默认 80） */
  warnAtPercent?: number;
  /** 预估成本超过该值需要用户确认一次 */
  confirmAboveCost?: number;
  /** 省钱模式：降低默认档位、压缩上下文、关闭互评 */
  cheapMode?: boolean;
}

export interface PerformanceSettings {
  /** 并发调用数 1~8 */
  concurrency?: number;
  /** 单模型调用超时（毫秒，15000~300000） */
  timeoutMs?: number;
  /** 默认最大输出 token（256~32768） */
  defaultMaxTokens?: number;
  /** 流式增量合并间隔（毫秒，0 = 不合并） */
  streamChunkThrottleMs?: number;
}

export interface BudgetUsage {
  window: "today" | "month";
  tokens: number;
  cost: number;
  currency: "CNY" | "USD";
  limitTokens?: number;
  limitCost?: number;
  percent?: number;
  blocked: boolean;
  cheapMode: boolean;
}

/* ------------------------------- 关键词 ------------------------------- */

export type KeywordMatch = "contains" | "exact" | "regex";

export type KeywordAction =
  | { type: "mode"; mode: RunMode }
  | { type: "effort"; effort: EffortLevel }
  | { type: "memory"; enabled: boolean }
  | { type: "cheapMode"; enabled: boolean }
  | { type: "role"; role: string; participants: ParticipantSpec[] }
  | { type: "judge"; judge: ParticipantSpec };

export interface KeywordRule {
  id: string;
  enabled: boolean;
  keyword: string;
  match: KeywordMatch;
  action: KeywordAction;
  priority: number;
  note?: string;
}

export interface KeywordHit {
  ruleId: string;
  keyword: string;
  action: KeywordAction;
  priority: number;
}

export interface KeywordTestResult {
  matched: KeywordHit[];
  /** 应用后最终生效的摘要（给 UI 展示） */
  effects: string[];
}

/* ------------------------------- 插件 -------------------------------- */

export type PluginKind = "native" | "bridge" | "ui-only" | "unsupported";
export type PluginStatus = "migrated" | "bridge-ready" | "pending" | "failed";

export interface PluginBridgeSpec {
  /** 可执行文件绝对路径或 PATH 命令 */
  command: string;
  /** 测试参数（一般 --version / --help） */
  testArgs: string[];
  /** 运行说明 */
  note?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  kind: PluginKind;
  status: PluginStatus;
  source: "dsh" | "builtin";
  dshPackage?: string;
  /** 迁移到 Super Work 后对应的能力入口（native） */
  capability?: string;
  bridge?: PluginBridgeSpec;
  enabled: boolean;
  /** 测试/最近一次运行 */
  lastTest?: {
    ok: boolean;
    message: string;
    latencyMs?: number;
    at: number;
  };
}

export interface PluginTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  output?: string;
}

/* ------------------------------ 运行记录扩展 ------------------------------ */

export interface RunGuardInfo {
  cheapMode?: boolean;
  matchedKeywords?: KeywordHit[];
  attachments?: AttachmentMeta[];
  budgets?: { perRunTokens?: number; perRunCost?: number; currency?: "CNY" | "USD"; blocked?: boolean; message?: string };
}

export interface RunAttachmentContext {
  provider: ProviderId;
  name: string;
  kind: AttachmentKind;
  text: string;
}
