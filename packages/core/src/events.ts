import type { ProviderId, Usage } from "./types.js";

export type RunMode = "parallel" | "coordinate" | "chat" | "council" | "debate" | "pipeline" | "vote" | "auto";

export const RUN_MODE_META: Record<RunMode, { name: string; short: string; description: string }> = {
  parallel: {
    name: "并行",
    short: "Parallel",
    description: "所有选中的模型同时独立作答，可指定整合/裁判模型把结论合成一份。",
  },
  coordinate: {
    name: "配合",
    short: "Coordinate",
    description: "按角色分工：发令官下指令 → 强推理/代码/建模/生图/Chat 执行 → 整合优化 → 裁判裁决。",
  },
  chat: {
    name: "Chat",
    short: "Chat",
    description: "只选一个模型，像聊天一样多轮对话；可随时切回并行/配合，让模型团队接着做。",
  },
  council: {
    name: "议会",
    short: "Council",
    description: "全部模型并行作答 → 互相补充批判 → 总协调模型综合成最终答案。",
  },
  debate: {
    name: "辩论",
    short: "Debate",
    description: "分正反两方立论与反驳，最后裁判模型裁决并给出结论。",
  },
  pipeline: {
    name: "接力",
    short: "Pipeline",
    description: "按顺序逐棒加工：规划 → 执行 → 审校 → 定稿，每个模型只在前一棒成果上继续。",
  },
  vote: {
    name: "投票",
    short: "Vote",
    description: "并行独立作答，裁判模型打分并选出最佳，再补一版终稿。",
  },
  auto: {
    name: "自动调度",
    short: "Auto",
    description: "调度模型先拆任务，再按能力把子任务分给最合适的模型，最后汇总。",
  },
};

export interface ParticipantSpec {
  provider: ProviderId;
  model: string;
  /** 角色说明，会注入 system prompt */
  role?: string;
  /** provider=relay 时指定中转站账号 */
  relayId?: string;
  /** 该模型的强度档位（运行中可改，下一次调用生效） */
  effort?: import("./types.js").EffortLevel;
}

export interface Participant {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  role: string;
  /** 强度档位（运行中可热调） */
  effort?: import("./types.js").EffortLevel;
}

export type ArtifactKind = "image" | "code3d" | "file" | "video" | "audio";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  mime?: string;
  /** 服务器上的相对路径（由 /api/artifacts 提供） */
  path?: string;
  /** data URL（小图可直接内嵌） */
  dataUrl?: string;
  /** 代码或文本内容（建模/代码产物） */
  text?: string;
  meta?: Record<string, string | number | boolean>;
  createdAt: number;
}

/** 多轮对话中的一轮：用户命令 + 该轮最终答案。 */
export interface ConversationTurn {
  runId: string;
  /** 第几轮（从 1 开始） */
  round: number;
  command: string;
  finalText: string;
  at: number;
}

export interface RunOptions {
  /** 多轮对话历史（server 按预算组装；orchestrator 以 user/assistant 消息注入每一次调用） */
  conversation?: ConversationTurn[];
  /** 历史是否因上下文预算被截断 */
  conversationTruncated?: boolean;
  /** 记忆召回注入的文本（server 侧组装） */
  memoryContext?: string;
  /** 本次注入记忆的 id 列表（用于上下文洞察） */
  memoryIds?: string[];
  /** 是否启用记忆召回 */
  useMemory?: boolean;
  /** 生图尺寸 */
  imageSize?: string;
  /** 默认强度档位（未单独指定的参与者使用） */
  defaultEffort?: import("./types.js").EffortLevel;
  /** 自定义角色定义（配合模式使用） */
  customRoles?: import("./v3.js").CustomRoleDef[];
  /** 附件提取文本（server 注入，orchestrator 计入 command/reference 上下文） */
  attachmentsContext?: string;
  /** 单次调用输出上限（预算/性能守卫） */
  perCallMaxTokens?: number;
  /** 省钱模式 */
  cheapMode?: boolean;
  /** 全局并发上限（orchestrator 池大小） */
  concurrency?: number;
  /** 单次运行预算（超过后停止剩余调用） */
  budgetLimitTokens?: number;
  budgetLimitCost?: number;
  budgetCurrency?: "CNY" | "USD";
  /** 性能设置快照（并发/超时/默认 token/节流） */
  performance?: import("./v3.js").PerformanceSettings;
  /** 是否开启第二轮互评（council/debate 有效），默认 true */
  critique?: boolean;
  /** 辩论轮数，默认 2 */
  rounds?: number;
  maxTokens?: number;
  temperature?: number;
  /** 输出语言，默认 zh */
  language?: "zh" | "en";
  /** 是否让裁判输出最终稿，默认 true */
  synthesize?: boolean;
  /** 每次模型调用的超时（毫秒），默认 180000 */
  timeoutMs?: number;
}

export interface RunRequest {
  command: string;
  mode: RunMode;
  participants: ParticipantSpec[];
  judge?: ParticipantSpec;
  options?: RunOptions;
  /** 继续某个已有会话（把历史作为上下文摘要注入） */
  conversationId?: string;
  /** 继续某个已有工作（多轮对话的工作 id） */
  threadId?: string;
  /** 配合模式的角色编排；未出现的角色严格不调用 */
  coordination?: import("./coordination.js").CoordinationAssignment[];
  /** 命令区上传的附件（服务端已解析出文本） */
  attachments?: import("./v3.js").AttachmentInput[];
  /** 运行时的预算/省钱/关键词等守卫信息（server 填充） */
  guard?: import("./v3.js").RunGuardInfo;
}

export type StageId =
  | "command"
  | "chat"
  | "specialist"
  | "integrate"
  | "render"
  | "memory"
  | "workflow"
  | "plan"
  | "opening"
  | "fanout"
  | "critique"
  | "rebuttal"
  | "handoff"
  | "judge"
  | "synthesis"
  | "final";

export type RunEvent =
  | { type: "run.start"; runId: string; mode: RunMode; participants: Participant[]; at: number }
  | { type: "stage"; stage: StageId; label: string; at: number }
  | { type: "model.start"; participantId: string; at: number; label: string }
  | {
      type: "model.delta";
      participantId: string;
      channel: "text" | "reasoning";
      text: string;
      at: number;
    }
  | {
      type: "model.done";
      participantId: string;
      text: string;
      usage?: Usage;
      latencyMs: number;
      at: number;
      /** 本次调用生效的强度档位 */
      effort?: import("./types.js").EffortLevel;
    }
  | { type: "model.error"; participantId: string; message: string; at: number }
  | {
      type: "model.stopped";
      participantId: string;
      /** 停止前的已生成内容仍保留在 UI / 记录里 */
      text?: string;
      message?: string;
      at: number;
    }
  | { type: "final.delta"; text: string; at: number }
  | { type: "final"; text: string; usage?: Usage; at: number }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string; at: number }
  | { type: "context"; participantId: string; stage: StageId; insight: import("./insight.js").ContextInsight; at: number }
  | { type: "artifact"; participantId?: string; artifact: Artifact; at: number }
  | { type: "run.done"; runId: string; at: number; usage?: Usage }
  | { type: "run.error"; message: string; at: number };

/** 某个参与者在某个阶段的发言（用于回看"独立作答 / 互评 / 反驳"）。 */
export interface ParticipantStageResult {
  stage: StageId;
  text: string;
  reasoning?: string;
}

/** 一个参与者在一次运行里的产出。 */
export interface ParticipantResult {
  participantId: string;
  provider: ProviderId;
  model: string;
  label: string;
  role: string;
  /** 首次成功作答的正文（后续阶段不覆盖） */
  text: string;
  reasoning?: string;
  /** 各阶段发言，按发生顺序 */
  stages?: ParticipantStageResult[];
  usage?: Usage;
  latencyMs?: number;
  error?: string;
  /** 生效的强度档位 */
  effort?: import("./types.js").EffortLevel;
}

export interface RunRecord {
  id: string;
  command: string;
  mode: RunMode;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  finalText: string;
  participants: ParticipantResult[];
  usage?: Usage;
  error?: string;
  options?: RunOptions;
  artifacts?: Artifact[];
}

export interface OrchestratorDeps {
  callModel(req: {
    provider: ProviderId;
    model: string;
    system?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    reasoning?: "low" | "medium" | "high";
    /** 强度档位（providers 可据此做原生映射） */
    effort?: import("./types.js").EffortLevel;
    signal?: AbortSignal;
  }): AsyncIterable<
    { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "usage"; usage: Usage }
  >;
  /** 生图能力（配合模式的 image 角色） */
  generateImage?(req: {
    provider: ProviderId;
    model: string;
    prompt: string;
    size?: string;
    signal?: AbortSignal;
  }): Promise<import("./types.js").ImageResult>;
}

export interface RunControl {
  /** 单独停止某个参与模型（其余模型继续跑）；返回是否确实停止/标记了目标 */
  stopParticipant(participantId: string): boolean;
  /** 已被用户单独停止的模型 id 列表 */
  stoppedParticipants(): string[];
}

export interface OrchestrateArgs {
  runId: string;
  request: Required<Pick<RunRequest, "command" | "mode" | "participants">> & RunRequest;
  participants: Participant[];
  judge?: Participant;
  options?: RunOptions;
  signal?: AbortSignal;
  /** orchestrator 把运行期控制句柄交回给调用方（server 用它单独停止某个模型） */
  onControl?: (control: RunControl) => void;
}

export interface OrchestrateResult {
  finalText: string;
  results: ParticipantResult[];
  usage: Usage;
}
