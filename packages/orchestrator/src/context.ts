/**
 * 上下文洞察：把一次模型调用拆成 system / command / memory / reference / history 五段，
 * 用 core 的 estimateTokens 估算 token，再从 core 模型目录取上下文窗口。
 *
 * 约束（DESIGN §4）：
 * - sections 至少包含 system / command / memory / reference / history；
 * - promptTokens === sections 求和；
 * - contextWindow 找不到时留空，utilization 不超过 1。
 */
import type {
  ContextInsight,
  ContextSection,
  ContextSectionName,
  ProviderId,
  StageId,
} from "@super-work/core";
import { estimateTokens, findModel } from "@super-work/core";

/** 上下文分段顺序（UI 堆叠条按这个顺序渲染）。 */
export const CONTEXT_SECTION_ORDER: readonly ContextSectionName[] = [
  "system",
  "command",
  "memory",
  "reference",
  "history",
];

/** 各分段的原始文本（缺省视为 0 token）。 */
export type ContextTexts = Partial<Record<ContextSectionName, string>>;

export interface BuildContextInput {
  participantId: string;
  provider: ProviderId;
  model: string;
  stage: StageId;
  texts: ContextTexts;
  /** 实际注入 prompt 的记忆 id（memory 段为空时不带） */
  injectedMemoryIds?: string[];
}

/** 构造一次调用的上下文快照（纯函数，方便单测）。 */
export function buildContextInsight(input: BuildContextInput): ContextInsight {
  const texts = input.texts;
  const sections: ContextSection[] = CONTEXT_SECTION_ORDER.map((name) => ({
    name,
    tokens: estimateTokens(texts[name] ?? ""),
  }));
  const promptTokens = sections.reduce((sum, section) => sum + section.tokens, 0);
  const contextWindow = findModel(input.provider, input.model)?.contextWindow;

  const insight: ContextInsight = {
    participantId: input.participantId,
    model: input.model,
    stage: input.stage,
    sections,
    promptTokens,
  };
  if (typeof contextWindow === "number" && contextWindow > 0) {
    insight.contextWindow = contextWindow;
    insight.utilization = Math.min(1, promptTokens / contextWindow);
  }
  const memoryText = texts.memory ?? "";
  if (memoryText.trim() && input.injectedMemoryIds?.length) {
    insight.injectedMemoryIds = [...input.injectedMemoryIds];
  }
  return insight;
}
