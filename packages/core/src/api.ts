import type { AuthMode, CredentialSource, ModelInfo, ProviderId, Usage } from "./types.js";
import type { ParticipantResult, ParticipantSpec, RunMode, RunOptions } from "./events.js";

/** ---------- providers / credentials ---------- */

export interface ConnectionStatus {
  id: string;
  provider: ProviderId;
  mode: AuthMode;
  source: CredentialSource;
  label: string;
  accountLabel?: string;
  expiresAt?: number;
  healthy: boolean;
  /** 该连接能访问的模型（订阅连接与 API 连接不同） */
  modelCount?: number;
  detail?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  short: string;
  color: string;
  kind: string;
  models: ModelInfo[];
  authModes: AuthMode[];
  subscription?: { kind: string; label: string; note?: string };
  /** 官方购买 / 充值 / 订阅入口 */
  purchase?: import("./types.js").ProviderPurchase;
  note?: string;
  connections: ConnectionStatus[];
  connected: boolean;
  /** 本机可复用的发现项（不自动导入） */
  localAccounts?: LocalAccount[];
}

export interface LocalAccount {
  id: string;
  provider: ProviderId;
  mode: AuthMode;
  label: string;
  accountLabel?: string;
  source: "dsh-credentials" | "env";
  /** 凭证剩余有效期 */
  expiresAt?: number;
  usable: boolean;
  detail?: string;
}

export interface ConnectRequest {
  mode: AuthMode;
  apiKey?: string;
  baseUrl?: string;
  token?: string;
  cookieName?: string;
  label?: string;
  /** 粘贴凭证时附加的自定义请求头（如 chatgpt-account-id、x-org-id） */
  extraHeaders?: Record<string, string>;
  /** v0.0.3：跳过网络校验直接保存（解决上游无 /models 或校验误判） */
  skipValidation?: boolean;
}

export interface LocalImportRequest {
  localAccountId: string;
}

export interface AuthStartRequest {
  mode: AuthMode;
  /** oauth-browser 必填的场景：指定使用方（如 chatgpt / claude / gemini） */
  flow?: string;
}

export interface AuthStartResponse {
  flowId: string;
  kind: string;
  provider: ProviderId;
  authorizeUrl?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
  note?: string;
}

export type AuthFlowState =
  | { status: "pending"; note?: string }
  | { status: "done"; connection: ConnectionStatus }
  | { status: "error"; message: string }
  | { status: "expired" };

export type AuthFlowPollResponse = AuthFlowState & {
  flowId: string;
  provider: ProviderId;
};

/** ---------- models ---------- */

export interface ModelOption extends ModelInfo {
  /** 是否已有可用连接 */
  available: boolean;
  connections: number;
  disabledReason?: string;
}

export interface ModelsResponse {
  models: ModelOption[];
  generatedAt: number;
}

/** ---------- runs ---------- */

export interface CreateRunRequest {
  command: string;
  mode: RunMode;
  /** 并行/旧模式使用：参与的模型 */
  participants: ParticipantSpec[];
  /** 配合模式使用：按角色分组的模型；未出现的角色严格不调用 */
  coordination?: import("./coordination.js").CoordinationAssignment[];
  judge?: ParticipantSpec;
  options?: RunOptions;
  /** 继续某个工作（多轮对话）：带上该工作 id 即追加下一轮 */
  threadId?: string;
  /** 命令区附件（上传接口返回的 id/name/kind/text） */
  attachments?: import("./v3.js").AttachmentInput[];
  /** 预算/高成本确认：用户明确确认后为 true */
  force?: boolean;
}

export interface RunListItem {
  id: string;
  command: string;
  mode: RunMode;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  participantCount: number;
  preview: string;
  usage?: Usage;
  cost?: number;
  /** 所属工作（多轮对话）id；历史运行没有时等于自身 id */
  threadId?: string;
  /** 第几轮 */
  round?: number;
}

export interface RunDetail {
  id: string;
  command: string;
  mode: RunMode;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  finalText: string;
  results: ParticipantResult[];
  usage?: Usage;
  error?: string;
  /** 所属工作（多轮对话）id */
  threadId?: string;
  /** 第几轮（从 1 开始） */
  round?: number;
  /** 本次注入的对话历史摘要 */
  history?: { rounds: number; tokens: number; truncated: boolean };
  participants: Array<{
    id: string;
    provider: ProviderId;
    model: string;
    label: string;
    role: string;
    effort?: import("./types.js").EffortLevel;
  }>;
  /** 配合模式下的角色配置 */
  coordination?: import("./coordination.js").CoordinationAssignment[];
  /** 生图 / 建模产物 */
  artifacts?: import("./events.js").Artifact[];
  /** 本次运行成本估算（有定价时） */
  cost?: import("./insight.js").CostBreakdown;
  /** 运行中可热调强度 */
  efforts?: Array<{ participantId: string; effort: import("./types.js").EffortLevel }>;
  /** 附件（名称/类型/提取字数） */
  attachments?: import("./v3.js").AttachmentMeta[];
  /** 预算/关键词/省钱模式守卫信息 */
  guard?: import("./v3.js").RunGuardInfo;
}

/** 一个工作 = 一条多轮对话线。 */
export interface ThreadSummary {
  id: string;
  /** 第一轮命令（截断展示用原文） */
  title: string;
  mode: RunMode;
  /** 当前进行到第几轮 */
  rounds: number;
  /** 最后一轮的状态 */
  status: "running" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  lastRunId: string;
  /** 最后一轮最终答案的前 160 字 */
  preview: string;
  participantCount: number;
  usage?: Usage;
  cost?: number;
  /** 已归档；默认列表不返回 */
  archived?: boolean;
  /** 若由另一条对话分支而来，记录来源 */
  parentThreadId?: string;
  branchedFromRunId?: string;
  /** 本对话的长期记忆（手动维护，注入下一次调用） */
  memory?: string;
  memoryUpdatedAt?: number;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  /** 按轮次升序的完整运行 */
  runs: RunDetail[];
}

export interface SetEffortRequest {
  participantId: string;
  effort: import("./types.js").EffortLevel;
}

export interface BudgetStatusResponse {
  today: { tokens: number; cost: number; currency: "CNY" | "USD" };
  limits: {
    dailyTokenLimit?: number;
    dailyCostLimit?: number;
    perRunTokenLimit?: number;
    perRunCostLimit?: number;
    warnAtPercent: number;
  };
  percent?: number;
  cheapMode: boolean;
  blocked: boolean;
  message?: string;
}

export interface PluginUpdateRequest {
  enabled?: boolean;
  bridge?: import("./v3.js").PluginBridgeSpec;
}

/** ---------- settings / diagnostics ---------- */

export interface AppSettings {
  proxy?: string;
  language: "zh" | "en";
  defaultMode?: RunMode;
  judge?: ParticipantSpec;
  timeoutMs?: number;
  /** 是否允许读取本机 DSH 凭证做复用 */
  allowLocalReuse: boolean;
  /** 本机凭证文件路径（默认 ~/.dsh/.credentials.yaml） */
  localCredentialPath?: string;
  /** 用户手动追加的模型（按 provider 分组） */
  customModels?: Partial<Record<ProviderId, ModelInfo[]>>;
  /** 自定义配合角色 */
  customRoles?: import("./v3.js").CustomRoleDef[];
  /** 预算与防额外消耗 */
  budgets?: import("./v3.js").BudgetSettings;
  /** 性能调控 */
  performance?: import("./v3.js").PerformanceSettings;
  /** 关键词规则 */
  keywords?: import("./v3.js").KeywordRule[];
  /** 插件中心状态（启用/覆盖桥接命令） */
  plugins?: import("./v3.js").PluginInfo[];
}

export interface ProxyDetectResponse {
  source: "env" | "system" | "none";
  httpProxy?: string;
  httpsProxy?: string;
  /** 可直接填入设置的建议值 */
  suggestion?: string;
  detail?: string;
}

export interface DiagnosticsResponse {
  version: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  dataDir: string;
  proxy?: string;
  providersConnected: number;
  providersTotal: number;
  runs: number;
}

/** ---------- SSE ---------- */

export type RunStreamEvent =
  | { type: "snapshot"; run: RunDetail }
  | { type: "event"; seq: number; event: import("./events.js").RunEvent };

export interface ErrorResponse {
  error: { code: string; message: string; detail?: string };
}
