/**
 * 模型团队：把「一次任务里并行模式 + 配合模式的模型」归纳成一份总览。
 *
 * 团队的真相仍是编排（parallel participants / coordination），这里只做派生视图，
 * 避免出现第二份可编辑状态；模板只保存结构与参数，不保存任何密钥。
 */
import type { CoordinationAssignment, EffortLevel, ParticipantSpec, ProviderId, RunMode } from "@super-work/core";

export interface TeamTemplate {
  id: string;
  name: string;
  createdAt: number;
  mode: RunMode;
  participants: ParticipantSpec[];
  coordination: CoordinationAssignment[];
  judge?: ParticipantSpec;
}

export interface TeamMemberBinding {
  mode: "parallel" | "coordinate";
  /** coordinate 时为角色 id，parallel 为固定值 "parallel" */
  roleId: string;
  roleName: string;
  spec: ParticipantSpec;
}

export interface TeamMember {
  key: string;
  provider: ProviderId;
  model: string;
  relayId?: string;
  bindings: TeamMemberBinding[];
  /** 多模式绑定时取第一个强度展示 */
  effort?: EffortLevel;
  /** 并行模式下的数组下标（用于删除） */
  parallelIndex?: number;
}

function memberKey(spec: Pick<ParticipantSpec, "provider" | "model" | "relayId">): string {
  return `${spec.provider}:${spec.relayId ?? ""}:${spec.model}`;
}

export function deriveTeam(
  participants: ParticipantSpec[],
  coordination: CoordinationAssignment[],
): TeamMember[] {
  const map = new Map<string, TeamMember>();
  const ensure = (spec: ParticipantSpec): TeamMember => {
    const key = memberKey(spec);
    let member = map.get(key);
    if (!member) {
      member = {
        key,
        provider: spec.provider,
        model: spec.model,
        relayId: spec.relayId,
        bindings: [],
        effort: spec.effort,
      };
      map.set(key, member);
    }
    if (spec.effort && !member.effort) member.effort = spec.effort;
    return member;
  };
  participants.forEach((spec, index) => {
    const member = ensure(spec);
    member.parallelIndex = index;
    member.bindings.push({
      mode: "parallel",
      roleId: "parallel",
      roleName: (spec.role ?? "").trim() || "并行",
      spec,
    });
  });
  for (const assignment of coordination) {
    for (const spec of assignment.participants ?? []) {
      const member = ensure(spec);
      member.bindings.push({
        mode: "coordinate",
        roleId: assignment.role,
        roleName: assignment.role,
        spec,
      });
    }
  }
  return [...map.values()];
}

export function teamCount(
  participants: ParticipantSpec[],
  coordination: CoordinationAssignment[],
): number {
  return deriveTeam(participants, coordination).length;
}

const STORAGE_KEY = "superwork.teams.v1";

export function loadTeamTemplates(): TeamTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TeamTemplate =>
        !!item &&
        typeof item === "object" &&
        typeof (item as TeamTemplate).id === "string" &&
        typeof (item as TeamTemplate).name === "string" &&
        Array.isArray((item as TeamTemplate).participants) &&
        Array.isArray((item as TeamTemplate).coordination),
    );
  } catch {
    return [];
  }
}

export function saveTeamTemplates(templates: TeamTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.slice(0, 20)));
  } catch {
    /* localStorage 满或不可用时静默失败，模板只影响便捷性 */
  }
}

export function newTeamId(): string {
  return `team_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
