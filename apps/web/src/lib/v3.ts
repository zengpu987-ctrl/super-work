/**
 * v0.0.3 UI 辅助：自定义角色、关键词规则、插件标签。
 * 契约类型全部来自 @super-work/core（v3 已冻结），这里只做展示/校验派生。
 */
import type {
  CustomRoleDef,
  EffortLevel,
  KeywordAction,
  KeywordHit,
  KeywordMatch,
  KeywordRule,
  KeywordTestResult,
  ParticipantSpec,
  PerformanceSettings,
  PluginInfo,
  PluginKind,
  PluginStatus,
  RunMode,
} from "@super-work/core";
import { COORD_ROLE_BY_ID, COORD_ROLES, RUN_MODE_META } from "@super-work/core";
import { EFFORT_BY_ID } from "@super-work/core";

export const DEFAULT_PERFORMANCE_SETTINGS: Required<PerformanceSettings> = {
  concurrency: 3,
  timeoutMs: 90_000,
  defaultMaxTokens: 4096,
  streamChunkThrottleMs: 120,
};

export const MAX_CUSTOM_ROLES = 24;
export const CUSTOM_ROLE_ORDER_START = 100;
export const ROLE_NAME_MIN = 2;
export const ROLE_NAME_MAX = 12;
export const ROLE_DESC_MAX = 200;

/* ---------------------------------------------------------------- 角色 */

export function createCustomRoleId(): string {
  return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function nextCustomRoleOrder(roles: CustomRoleDef[]): number {
  const max = roles.reduce((acc, role) => Math.max(acc, role.order ?? 0), CUSTOM_ROLE_ORDER_START - 1);
  return max + 1;
}

export interface RoleNameCheck {
  ok: boolean;
  message?: string;
}

/** 名称 2-12 字，不可与内置角色或已有自定义角色重名。 */
export function checkRoleName(
  name: string,
  roles: CustomRoleDef[],
  selfId?: string,
): RoleNameCheck {
  const trimmed = name.trim();
  if (trimmed.length < ROLE_NAME_MIN) return { ok: false, message: `名称至少 ${ROLE_NAME_MIN} 个字` };
  if (trimmed.length > ROLE_NAME_MAX) return { ok: false, message: `名称最多 ${ROLE_NAME_MAX} 个字` };
  if (COORD_ROLES.some((role) => role.name === trimmed)) {
    return { ok: false, message: "与内置角色重名，请换一个名称" };
  }
  if (roles.some((role) => role.id !== selfId && role.name.trim() === trimmed)) {
    return { ok: false, message: "已有同名角色，请换一个名称" };
  }
  return { ok: true };
}

/** 自定义角色按 order 排序；内置 8 个固定在前。 */
export function sortedCustomRoles(roles: CustomRoleDef[] | undefined): CustomRoleDef[] {
  return [...(roles ?? [])]
    .filter((role) => role && typeof role.id === "string" && typeof role.name === "string")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function resolveRoleLabel(
  roleId: string,
  customRoles: CustomRoleDef[] | undefined,
): { name: string; kind: "text" | "image"; builtin: boolean; description?: string } {
  const builtin = COORD_ROLE_BY_ID[roleId as keyof typeof COORD_ROLE_BY_ID];
  if (builtin) {
    return { name: builtin.name, kind: builtin.kind, builtin: true, description: builtin.description };
  }
  const custom = (customRoles ?? []).find((role) => role.id === roleId);
  if (custom) {
    return { name: custom.name, kind: custom.kind, builtin: false, description: custom.description };
  }
  return { name: roleId, kind: "text", builtin: false };
}

export function isBuiltinRole(roleId: string): boolean {
  return !!COORD_ROLE_BY_ID[roleId as keyof typeof COORD_ROLE_BY_ID];
}

/** 复制角色时的候选名称：`原名 副本` / `原名 副本 2`，并裁剪到 12 字。 */
export function duplicateRoleName(name: string, roles: CustomRoleDef[]): string {
  const base = name.replace(/\s*副本\s*\d*$/u, "").trim() || "角色";
  const names = new Set(roles.map((role) => role.name));
  for (let index = 1; index < 50; index += 1) {
    const suffix = index === 1 ? " 副本" : ` 副本 ${index}`;
    const candidate = `${base.slice(0, Math.max(1, ROLE_NAME_MAX - suffix.length))}${suffix}`;
    if (!names.has(candidate) && !COORD_ROLES.some((role) => role.name === candidate)) return candidate;
  }
  return `${base.slice(0, 8)} 副本`;
}

/* ---------------------------------------------------------------- 关键词 */

export const KEYWORD_MATCH_LABEL: Record<KeywordMatch, string> = {
  contains: "包含",
  exact: "精确",
  regex: "正则",
};

export const KEYWORD_ACTION_LABEL: Record<KeywordAction["type"], string> = {
  mode: "切换模式",
  effort: "设置强度",
  memory: "记忆开关",
  cheapMode: "省钱模式",
  role: "指定角色",
  judge: "指定裁判",
};

export const RUN_MODE_LABEL: Record<RunMode, string> = Object.fromEntries(
  Object.entries(RUN_MODE_META).map(([mode, meta]) => [mode, meta.name]),
) as Record<RunMode, string>;

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  fast: "Fast",
  max: "Max",
  ultra: "Ultra",
};

export function keywordRuleSummary(rule: KeywordRule, customRoles?: CustomRoleDef[]): string {
  const action = rule.action;
  if (!action) return "—";
  switch (action.type) {
    case "mode":
      return `模式 → ${RUN_MODE_LABEL[action.mode as RunMode] ?? action.mode}`;
    case "effort":
      return `强度 → ${EFFORT_LABEL[action.effort as EffortLevel] ?? action.effort}（${
        EFFORT_BY_ID[action.effort as EffortLevel]?.name ?? action.effort
      }）`;
    case "memory":
      return `记忆 → ${action.enabled ? "开启" : "关闭"}`;
    case "cheapMode":
      return `省钱模式 → ${action.enabled ? "开启" : "关闭"}`;
    case "role": {
      const count = action.participants?.length ?? 0;
      return `角色 ${roleNameFor(action.role, customRoles)} · ${count} 个模型`;
    }
    case "judge":
      return `裁判 → ${action.judge?.model ?? "未指定"}`;
    default:
      return "—";
  }
}

function roleNameFor(roleId: string, customRoles?: CustomRoleDef[]): string {
  return (
    COORD_ROLE_BY_ID[roleId as keyof typeof COORD_ROLE_BY_ID]?.name ??
    customRoles?.find((role) => role.id === roleId)?.name ??
    roleId
  );
}

function testRegex(keyword: string, text: string): boolean {
  try {
    return new RegExp(keyword, "iu").test(text);
  } catch {
    return false;
  }
}

export function ruleMatches(rule: KeywordRule, text: string): boolean {
  if (!rule.enabled || !rule.keyword) return false;
  const keyword = rule.keyword;
  switch (rule.match) {
    case "exact":
      return text.trim() === keyword.trim();
    case "regex":
      return testRegex(keyword, text);
    case "contains":
    default:
      return text.toLowerCase().includes(keyword.toLowerCase());
  }
}

/**
 * 本地关键词测试（服务端运行前会再按同一规则匹配）：
 * 返回命中规则（按优先级降序）与应用后的 effect 摘要。同优先级只取最高优先级规则。
 */
export function testKeywordRules(
  rules: KeywordRule[],
  text: string,
  customRoles?: CustomRoleDef[],
): KeywordTestResult {
  const matched: KeywordHit[] = [];
  for (const rule of rules) {
    if (!ruleMatches(rule, text)) continue;
    matched.push({
      ruleId: rule.id,
      keyword: rule.keyword,
      action: rule.action,
      priority: rule.priority ?? 0,
    });
  }
  matched.sort((a, b) => b.priority - a.priority);
  const effects: string[] = [];
  for (const hit of matched) {
    const rule = rules.find((item) => item.id === hit.ruleId);
    if (rule) effects.push(`${rule.keyword}：${keywordRuleSummary(rule, customRoles)}`);
  }
  return { matched, effects };
}

export function defaultKeywordRule(): KeywordRule {
  return {
    id: `kw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    enabled: true,
    keyword: "",
    match: "contains",
    action: { type: "mode", mode: "coordinate" },
    priority: 10,
    note: "",
  };
}

/** 动作参数默认值：切换动作类型时保证旧参数不会让表单崩。 */
export function defaultActionFor(type: KeywordAction["type"], fallback?: ParticipantSpec): KeywordAction {
  switch (type) {
    case "mode":
      return { type: "mode", mode: "coordinate" };
    case "effort":
      return { type: "effort", effort: "max" };
    case "memory":
      return { type: "memory", enabled: true };
    case "cheapMode":
      return { type: "cheapMode", enabled: true };
    case "role":
      return {
        type: "role",
        role: "reasoning",
        participants: fallback ? [{ ...fallback }] : [],
      };
    case "judge":
      return {
        type: "judge",
        judge: fallback ?? { provider: "mock" as ParticipantSpec["provider"], model: "mock-thinker" },
      };
    default:
      return { type: "mode", mode: "coordinate" };
  }
}

/* ---------------------------------------------------------------- 插件 */

export const PLUGIN_KIND_LABEL: Record<PluginKind, string> = {
  native: "已原生迁移",
  bridge: "桥接可运行",
  "ui-only": "仅 DSH UI",
  unsupported: "暂不支持",
};

export const PLUGIN_STATUS_LABEL: Record<PluginStatus, string> = {
  migrated: "已迁移",
  "bridge-ready": "桥接就绪",
  pending: "待迁移",
  failed: "失败",
};

export function pluginStatusTone(plugin: PluginInfo): "ok" | "warn" | "err" | "muted" {
  if (plugin.kind === "unsupported") return "muted";
  if (plugin.kind === "ui-only") return "warn";
  if (plugin.lastTest) return plugin.lastTest.ok ? "ok" : "err";
  if (plugin.status === "failed") return "err";
  if (plugin.status === "migrated" || plugin.status === "bridge-ready") return "ok";
  if (plugin.status === "pending") return "warn";
  return "muted";
}

/** unsupported / ui-only 不应显示成「失败」，用迁移口径展示。 */
export function pluginStatusLabel(plugin: PluginInfo): string {
  if (plugin.kind === "unsupported") return "不适用";
  if (plugin.kind === "ui-only" && plugin.status !== "failed") return "仅 DSH";
  return PLUGIN_STATUS_LABEL[plugin.status] ?? plugin.status;
}

export function pluginSourceLabel(plugin: PluginInfo): string {
  if (plugin.source === "dsh") return plugin.dshPackage ? "DSH" : "DSH";
  return "内置";
}
