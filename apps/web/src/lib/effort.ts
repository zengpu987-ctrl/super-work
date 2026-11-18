/**
 * 强度档位 UI 元数据（包装 @super-work/core 的 EFFORT_*，不复制契约）。
 *
 * 契约来源：`packages/core/src/effort.ts`
 * - EFFORT_LEVELS / EFFORT_BY_ID / EFFORT_ORDER
 * - EffortMeta：name / level / reasoning / maxTokensMultiplier / temperature / hint / description
 *
 * UI 只在这里加「展示色 / 中文短徽标 / tooltip 文案」，绝不重新定义档位语义。
 */
import {
  EFFORT_BY_ID,
  EFFORT_LEVELS,
  EFFORT_ORDER,
  applyEffortToMaxTokens,
  normalizeEffort,
} from "@super-work/core";
import type { EffortLevel, EffortMeta } from "@super-work/core";

export { EFFORT_BY_ID, EFFORT_LEVELS, EFFORT_ORDER, applyEffortToMaxTokens, normalizeEffort };
export type { EffortLevel, EffortMeta };

/** 默认档位：core 语义里的均衡档。 */
export const DEFAULT_EFFORT: EffortLevel = "medium";

export interface EffortTone {
  /** 中文单字徽标：低 / 中 / 快 / 强 / 极 */
  badge: string;
  /** 英文短标签：L / M / F / Mx / U（96px 五段控件用，hover 显示全称） */
  short: string;
  /** 档位主色（docs/kimi-ui-review-v2.md §5 指定） */
  color: string;
  /** 只读徽标底色 / 描边（低透明度） */
  soft: string;
  line: string;
  /** 五格刻度：已填充格底色（中性文字，无发光） */
  fill: string;
  /** 选中格底色（比左侧格略深） */
  fillStrong: string;
}

/**
 * 严格按 docs/kimi-ui-review-v2.md §5：
 *   --low:#64748B; --medium:#60A5FA; --fast:#3B82F6; --max:#6366F1; --ultra:#7C3AED; --track:#E2E8F0
 * 选中格与左侧所有格填充（文字中性、不用红绿/发光/渐变）。
 */
const TONES: Record<EffortLevel, EffortTone> = {
  low: {
    badge: "低", short: "L", color: "#64748B",
    soft: "rgba(100, 116, 139, 0.30)", line: "rgba(100, 116, 139, 0.55)",
    fill: "rgba(100, 116, 139, 0.30)", fillStrong: "rgba(100, 116, 139, 0.46)",
  },
  medium: {
    badge: "中", short: "M", color: "#60A5FA",
    soft: "rgba(96, 165, 250, 0.24)", line: "rgba(96, 165, 250, 0.55)",
    fill: "rgba(96, 165, 250, 0.24)", fillStrong: "rgba(96, 165, 250, 0.40)",
  },
  fast: {
    badge: "快", short: "F", color: "#3B82F6",
    soft: "rgba(59, 130, 246, 0.26)", line: "rgba(59, 130, 246, 0.55)",
    fill: "rgba(59, 130, 246, 0.26)", fillStrong: "rgba(59, 130, 246, 0.42)",
  },
  max: {
    badge: "强", short: "Mx", color: "#6366F1",
    soft: "rgba(99, 102, 241, 0.28)", line: "rgba(99, 102, 241, 0.55)",
    fill: "rgba(99, 102, 241, 0.28)", fillStrong: "rgba(99, 102, 241, 0.44)",
  },
  ultra: {
    badge: "极", short: "U", color: "#7C3AED",
    soft: "rgba(124, 58, 237, 0.30)", line: "rgba(124, 58, 237, 0.58)",
    fill: "rgba(124, 58, 237, 0.30)", fillStrong: "rgba(124, 58, 237, 0.46)",
  },
};

export interface EffortDisplay extends EffortMeta, EffortTone {
  /** 形如 "×1.3 输出预算" */
  multiplierLabel: string;
  /** title 提示：名称 · 描述｜参数 */
  tooltip: string;
}

function multiplierLabel(meta: EffortMeta): string {
  return `×${meta.maxTokensMultiplier} 输出预算`;
}

function buildDisplay(meta: EffortMeta): EffortDisplay {
  const tone = TONES[meta.id] ?? TONES.medium;
  const reasoning = meta.reasoning ? `reasoning ${meta.reasoning}` : "不下发 reasoning";
  return {
    ...meta,
    ...tone,
    multiplierLabel: multiplierLabel(meta),
    tooltip: `${meta.name} · ${meta.description}｜${reasoning} · ${multiplierLabel(meta)} · 温度 ${meta.temperature}`,
  };
}

/** 用户指定顺序：Low → Medium → Fast → Max → Ultra（直接取 core 的 EFFORT_ORDER）。 */
export const EFFORT_UI_ORDER: readonly EffortLevel[] =
  EFFORT_ORDER.length > 0 ? [...EFFORT_ORDER] : ["low", "medium", "fast", "max", "ultra"];

export const EFFORT_OPTIONS: EffortDisplay[] = EFFORT_UI_ORDER.map(
  (id) => EFFORT_BY_ID[id] as EffortMeta,
).map(buildDisplay);

export const EFFORT_DISPLAY: Record<EffortLevel, EffortDisplay> = EFFORT_OPTIONS.reduce(
  (acc, option) => {
    acc[option.id] = option;
    return acc;
  },
  {} as Record<EffortLevel, EffortDisplay>,
);

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_UI_ORDER as readonly string[]).includes(value);
}

/** 允许 undefined → 返回 Medium 的展示信息。 */
export function effortOf(level?: EffortLevel | null): EffortDisplay {
  return (level && EFFORT_DISPLAY[level]) || EFFORT_DISPLAY[DEFAULT_EFFORT];
}

export function effortMeta(level?: EffortLevel | null): EffortMeta {
  return EFFORT_BY_ID[level ?? DEFAULT_EFFORT] ?? EFFORT_BY_ID[DEFAULT_EFFORT];
}

export function effortName(level?: EffortLevel | null): string {
  return effortOf(level).name;
}

/** 中文单字徽标（chips / 卡片角标）。 */
export function effortBadge(level?: EffortLevel | null): string {
  return effortOf(level).badge;
}

/** 英文短标签 L / M / F / Mx / U（紧凑控件）。 */
export function effortShort(level?: EffortLevel | null): string {
  return effortOf(level).short;
}

export function effortDescription(level?: EffortLevel | null): string {
  return effortOf(level).description;
}

export function effortMultiplierLabel(level?: EffortLevel | null): string {
  return effortOf(level).multiplierLabel;
}

export function effortTooltip(level?: EffortLevel | null): string {
  return effortOf(level).tooltip;
}

export function effortColor(level?: EffortLevel | null): string {
  return effortOf(level).color;
}

/**
 * 供 style={} 使用的 CSS 变量：
 * --effort-color 主色 / --effort-soft 徽标底 / --effort-line 徽标描边
 * --effort-fill 已填充格 / --effort-fill-strong 选中格
 */
export function effortVars(level?: EffortLevel | null): Record<string, string> {
  const display = effortOf(level);
  return {
    "--effort-color": display.color,
    "--effort-soft": display.soft,
    "--effort-line": display.line,
    "--effort-fill": display.fill,
    "--effort-fill-strong": display.fillStrong,
  };
}

/** 按 core 规则计算该档位下的 maxTokens（未给 base 时按 core 的 8192 基线）。 */
export function effortMaxTokens(
  level: EffortLevel | undefined,
  baseMaxTokens?: number,
): number | undefined {
  return applyEffortToMaxTokens(level, baseMaxTokens);
}

/** 方向键切换用：delta=±1，循环。 */
export function nextEffort(current: EffortLevel | undefined, delta: number): EffortLevel {
  const order = EFFORT_UI_ORDER;
  const index = Math.max(0, order.indexOf(current ?? DEFAULT_EFFORT));
  const next = (index + delta + order.length) % order.length;
  return order[next] ?? DEFAULT_EFFORT;
}

export function effortEdge(edge: "first" | "last"): EffortLevel {
  const order = EFFORT_UI_ORDER;
  return edge === "first" ? order[0] ?? DEFAULT_EFFORT : order[order.length - 1] ?? DEFAULT_EFFORT;
}
