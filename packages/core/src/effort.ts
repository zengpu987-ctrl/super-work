/** 模型强度档位：运行中也可热调，下一次调用生效。 */
import type { EffortLevel } from "./types.js";

export interface EffortMeta {
  id: EffortLevel;
  /** 展示名（用户指定：Low、Medium、Fast、Max、Ultra） */
  name: string;
  /** 由弱到强的序号 1~5 */
  level: 1 | 2 | 3 | 4 | 5;
  /** 映射给 provider 的推理强度；null 表示不下发 */
  reasoning: "low" | "medium" | "high" | null;
  /** maxTokens 倍率（会夹紧到模型上限） */
  maxTokensMultiplier: number;
  temperature: number;
  /** 注入 system 的强度说明 */
  hint: string;
  description: string;
}

export const EFFORT_LEVELS: EffortMeta[] = [
  {
    id: "low",
    name: "Low",
    level: 1,
    reasoning: "low",
    maxTokensMultiplier: 0.5,
    temperature: 0.3,
    hint: "以最少的推理与篇幅完成任务，直接给结论。",
    description: "最省：快速、简短，适合简单问题",
  },
  {
    id: "medium",
    name: "Medium",
    level: 2,
    reasoning: "medium",
    maxTokensMultiplier: 1,
    temperature: 0.5,
    hint: "给出结论与关键依据即可，不必展开所有分支。",
    description: "均衡：默认档位",
  },
  {
    id: "fast",
    name: "Fast",
    level: 3,
    reasoning: "medium",
    maxTokensMultiplier: 1.3,
    temperature: 0.4,
    hint: "保持推理质量的同时给出可执行步骤，避免冗长铺陈。",
    description: "偏执行：结构化步骤与代码，少寒暄",
  },
  {
    id: "max",
    name: "Max",
    level: 4,
    reasoning: "high",
    maxTokensMultiplier: 2,
    temperature: 0.6,
    hint: "深入推理：列出假设、反例与权衡，给出经过验证的结论。",
    description: "高强度：深推理 + 长输出",
  },
  {
    id: "ultra",
    name: "Ultra",
    level: 5,
    reasoning: "high",
    maxTokensMultiplier: 3,
    temperature: 0.7,
    hint: "最高强度：穷尽可行方案，主动找反例与边界条件，给出完整交付稿与风险清单。",
    description: "极限：最多推理与最长输出",
  },
];

export const EFFORT_BY_ID: Record<EffortLevel, EffortMeta> = Object.fromEntries(
  EFFORT_LEVELS.map((e) => [e.id, e]),
) as Record<EffortLevel, EffortMeta>;

export const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "fast", "max", "ultra"];

export function normalizeEffort(value: unknown): EffortLevel | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.toLowerCase();
  return (EFFORT_ORDER as string[]).includes(key) ? (key as EffortLevel) : undefined;
}

/** 按倍率计算本次调用的 maxTokens（有上限时夹紧）。 */
export function applyEffortToMaxTokens(effort: EffortLevel | undefined, baseMaxTokens: number | undefined): number | undefined {
  if (!effort) return baseMaxTokens;
  const meta = EFFORT_BY_ID[effort];
  if (!meta) return baseMaxTokens;
  const base = baseMaxTokens ?? 8192;
  return Math.max(256, Math.round(base * meta.maxTokensMultiplier));
}
