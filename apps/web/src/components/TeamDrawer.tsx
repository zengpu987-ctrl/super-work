import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { CoordinationAssignment, CustomRoleDef, EffortLevel, ModelOption, ParticipantSpec, RunMode } from "@super-work/core";
import { COORD_ROLES, PROVIDER_BY_ID } from "@super-work/core";
import { brandStyle } from "../lib/brand";
import { EffortSelector } from "./EffortSelector";
import { formatNumber } from "../lib/format";
import { resolveRoleLabel, sortedCustomRoles } from "../lib/v3";
import type { RunView } from "../lib/types";
import { specFromModel, specKey } from "../lib/types";
import {
  deriveTeam,
  loadTeamTemplates,
  newTeamId,
  saveTeamTemplates,
  type TeamMember,
  type TeamTemplate,
} from "../lib/teams";
import { BrandIcon } from "./BrandIcon";
import {
  IconChevronRight,
  IconLayers,
  IconPlus,
  IconSave,
  IconSearch,
  IconStopCircle,
  IconTrash,
  IconUsers,
  IconX,
} from "./Icons";

export interface TeamDrawerProps {
  open: boolean;
  onClose: () => void;
  mode: RunMode;
  participants: ParticipantSpec[];
  coordination: CoordinationAssignment[];
  customRoles: CustomRoleDef[];
  models: ModelOption[];
  availableKeys: Set<string>;
  judgeKey: string | null;
  judgeSpec?: ParticipantSpec;
  run: RunView | null;
  running: boolean;
  onOpenOrchestration: () => void;
  onRemoveParticipant: (index: number) => void;
  onToggleParticipant: (spec: ParticipantSpec) => void;
  onToggleRoleModel: (role: string, spec: ParticipantSpec) => void;
  onStopParticipant: (participantId: string) => void;
  /** 运行中热调档位（PATCH /api/runs/:id/effort） */
  onChangeRunEffort: (participantId: string, effort: EffortLevel) => Promise<void>;
  onUpdateParticipantEffort: (index: number, effort: EffortLevel) => void;
  onUpdateRoleModelEffort: (role: string, key: string, effort: EffortLevel) => void;
  onUpdateRole: (index: number, role: string) => void;
  roleEnabled: Record<string, boolean>;
  onApplyTeam: (input: {
    mode: RunMode;
    participants: ParticipantSpec[];
    coordination: CoordinationAssignment[];
    judge?: ParticipantSpec;
  }) => void;
}

type TeamTab = "all" | "parallel" | "coordinate";

function modelName(models: TeamDrawerProps["models"], provider: string, model: string): string {
  const found = models.find((m) => m.provider === provider && m.id === model);
  return found?.name ?? model;
}

function keyOf(spec: ParticipantSpec): string {
  return `${spec.provider}:${spec.relayId ?? ""}:${spec.model}`;
}

export function TeamDrawer({
  open,
  onClose,
  mode,
  participants,
  coordination,
  customRoles,
  models,
  availableKeys,
  judgeKey,
  judgeSpec,
  run,
  running,
  onOpenOrchestration,
  onRemoveParticipant,
  onToggleParticipant,
  onToggleRoleModel,
  onStopParticipant,
  onChangeRunEffort,
  onUpdateParticipantEffort,
  onUpdateRoleModelEffort,
  onUpdateRole,
  roleEnabled,
  onApplyTeam,
}: TeamDrawerProps) {
  const [tab, setTab] = useState<TeamTab>("all");
  const [templates, setTemplates] = useState<TeamTemplate[]>(() => loadTeamTemplates());
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addTarget, setAddTarget] = useState<string>("parallel");

  const members = useMemo(() => deriveTeam(participants, coordination), [participants, coordination]);
  const filtered = useMemo(
    () =>
      tab === "all"
        ? members
        : members.filter((member) => member.bindings.some((binding) => binding.mode === tab)),
    [members, tab],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const liveFor = (member: TeamMember) =>
    run?.participants.find(
      (participant) =>
        participant.provider === member.provider &&
        participant.model === member.model &&
        (!member.relayId || (participant as { relayId?: string }).relayId === member.relayId),
    );

  const callsFor = (member: TeamMember): number => member.bindings.length;
  const unavailable = (member: TeamMember): boolean =>
    !availableKeys.has(
      member.relayId ? `${member.provider}:${member.relayId}:${member.model}` : `${member.provider}:${member.model}`,
    );
  const activeCount = members.filter((member) => member.bindings.length > 0).length;

  const roleOptions = [
    ...COORD_ROLES.filter((role) => roleEnabled[role.id] !== false).map((role) => ({
      id: role.id as string,
      name: role.name,
      builtin: true,
    })),
    ...sortedCustomRoles(customRoles).map((role) => ({ id: role.id, name: role.name, builtin: false })),
  ];

  const addQueryLower = addQuery.trim().toLowerCase();
  const addable = models
    .filter((model) => !addQueryLower || `${model.name} ${model.id}`.toLowerCase().includes(addQueryLower))
    .slice(0, 60);

  const saveTemplate = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next: TeamTemplate = {
      id: newTeamId(),
      name: trimmed.slice(0, 24),
      createdAt: Date.now(),
      mode,
      participants: participants.map((spec) => ({ ...spec })),
      coordination: coordination.map((assignment) => ({
        role: assignment.role,
        participants: assignment.participants.map((spec) => ({ ...spec })),
      })),
      judge: judgeSpec ? { ...judgeSpec } : undefined,
    };
    const list = [next, ...templates].slice(0, 20);
    setTemplates(list);
    saveTeamTemplates(list);
    setName("");
    setSaving(false);
  };

  const removeTemplate = (id: string): void => {
    const list = templates.filter((item) => item.id !== id);
    setTemplates(list);
    saveTeamTemplates(list);
  };

  const keyOfSpec = (spec: ParticipantSpec): string =>
    `${spec.provider}:${spec.relayId ?? ""}:${spec.model}`;

  const applyEffort = (member: TeamMember, effort: EffortLevel): void => {
    if (member.parallelIndex != null) onUpdateParticipantEffort(member.parallelIndex, effort);
    for (const binding of member.bindings) {
      if (binding.mode === "coordinate") onUpdateRoleModelEffort(binding.roleId, keyOfSpec(binding.spec), effort);
    }
    const live = liveFor(member);
    if (live && run?.state === "running") void onChangeRunEffort(live.id, effort);
  };

  const removeMember = (member: TeamMember): void => {
    if (member.parallelIndex != null) onRemoveParticipant(member.parallelIndex);
    for (const binding of member.bindings) {
      if (binding.mode === "coordinate") onToggleRoleModel(binding.roleId, binding.spec);
    }
  };

  const addSpec = (spec: ParticipantSpec): void => {
    if (addTarget === "parallel") {
      const exists = participants.some((p) => specKey(p) === specKey(spec));
      if (exists) return;
      onToggleParticipant(spec);
    } else {
      const role = addTarget;
      const existing = coordination.find((item) => item.role === role)?.participants ?? [];
      if (existing.some((p) => specKey(p) === specKey(spec))) return;
      onToggleRoleModel(role, spec);
    }
  };

  return (
    <div className="team-layer" role="dialog" aria-modal="true" aria-label="模型团队">
      <button type="button" className="team-backdrop" aria-label="关闭模型团队" onClick={onClose} />
      <aside className="team-drawer">
        <header className="team-drawer__head">
          <span className="team-drawer__icon" aria-hidden="true">
            <IconUsers size={15} />
          </span>
          <div className="team-drawer__titles">
            <h2>模型团队</h2>
            <p>
              本次任务共 {members.length} 个模型 · 并行 {participants.length} / 配合{" "}
              {coordination.reduce((sum, item) => sum + (item.participants?.length ?? 0), 0)}
              {" · "}
              直接增删成员、调档位与角色
            </p>
          </div>
          <span className="team-drawer__count mono">{formatNumber(activeCount)}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭模型团队">
            <IconX size={14} />
          </button>
        </header>

        <div className="team-toolbar">
          <div className="team-tabs" role="tablist" aria-label="团队视图">
            {(
              [
                ["all", "全部"],
                ["parallel", "并行"],
                ["coordinate", "配合"],
              ] as Array<[TeamTab, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`team-tab${tab === value ? " is-active" : ""}`}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="team-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAdding((prev) => !prev);
                setAddTarget(tab === "coordinate" && roleOptions[0] ? roleOptions[0].id : "parallel");
              }}
              aria-expanded={adding}
              aria-label="添加模型到编队"
            >
              <IconPlus size={12} /> 添加模型
            </button>
            {saving ? (
              <span className="team-save">
                <input
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveTemplate();
                    if (event.key === "Escape") setSaving(false);
                  }}
                  placeholder="团队模板名称"
                  maxLength={24}
                  autoFocus
                  aria-label="团队模板名称"
                />
                <button type="button" className="btn btn-sm" onClick={saveTemplate} disabled={!name.trim()}>
                  保存
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaving(false)}>
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setSaving(true)}
                disabled={running || members.length === 0}
                title={running ? "运行中不修改团队，结束后再保存" : "把当前并行 + 配合的模型配置存为模板"}
              >
                <IconSave size={12} /> 保存为模板
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenOrchestration}>
              <IconLayers size={12} /> 打开编排
            </button>
          </div>
        </div>

        {templates.length > 0 ? (
          <div className="team-templates" aria-label="团队模板">
            <span className="team-templates__label">模板</span>
            {templates.map((template) => (
              <span className="team-template" key={template.id}>
                <button
                  type="button"
                  className="team-template__apply"
                  onClick={() => {
                    onApplyTeam({
                      mode: template.mode,
                      participants: template.participants,
                      coordination: template.coordination,
                      judge: template.judge,
                    });
                    onClose();
                  }}
                  disabled={running}
                  title={`套用「${template.name}」：覆盖当前并行与配合配置`}
                >
                  {template.name}
                </button>
                <button
                  type="button"
                  className="team-template__remove"
                  onClick={() => removeTemplate(template.id)}
                  aria-label={`删除模板 ${template.name}`}
                  disabled={running}
                >
                  <IconX size={9} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {adding ? (
          <div className="team-picker" role="region" aria-label="添加模型到编队">
            <div className="team-picker__row">
              {roleOptions.length > 0 ? (
                <label className="team-picker__target">
                  添加到
                  <select
                    className="select"
                    value={addTarget}
                    onChange={(event) => setAddTarget(event.target.value)}
                    aria-label="添加到并行或角色"
                  >
                    <option value="parallel">并行模式</option>
                    {roleOptions.map((role) => (
                      <option value={role.id} key={role.id}>
                        配合 · {role.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <span className="team-picker__search">
                <IconSearch size={12} />
                <input
                  className="input"
                  value={addQuery}
                  onChange={(event) => setAddQuery(event.target.value)}
                  placeholder="搜索模型 / 平台"
                  aria-label="搜索要添加的模型"
                  autoFocus
                />
              </span>
              <button type="button" className="icon-btn" onClick={() => setAdding(false)} aria-label="关闭添加面板">
                <IconX size={12} />
              </button>
            </div>
            <div className="team-picker__list">
              {addable.length === 0 ? (
                <p className="team-picker__empty">没有匹配的模型；先到设置里连接 provider。</p>
              ) : (
                addable.map((model) => {
                  const spec = specFromModel(model);
                  const inParallel = participants.some((p) => specKey(p) === specKey(spec));
                  const roleList = addTarget === "parallel" ? null : coordination.find((item) => item.role === addTarget)?.participants ?? [];
                  const inRole = roleList?.some((p) => specKey(p) === specKey(spec)) ?? false;
                  const active = addTarget === "parallel" ? inParallel : inRole;
                  return (
                    <button
                      type="button"
                      key={`${model.provider}:${model.id}`}
                      className={`team-picker__item${active ? " is-added" : ""}`}
                      onClick={() => addSpec(spec)}
                      disabled={!model.available || active}
                      title={model.available ? undefined : "该模型当前不可用"}
                    >
                      <BrandIcon provider={model.provider} size={16} title={PROVIDER_BY_ID[model.provider]?.name ?? model.provider} />
                      <span className="team-picker__name">
                        {model.name}
                        <em>{PROVIDER_BY_ID[model.provider]?.name ?? model.provider}</em>
                      </span>
                      <span className="team-picker__act">{active ? "已在编队" : model.available ? "添加" : "不可用"}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        <div className="team-body">
          {members.length === 0 ? (
            <div className="team-empty">
              <strong>团队还没有成员</strong>
              <p>在右栏编排里给并行模式选模型，或给配合角色配置模型；这里会自动归纳成一张团队总览。</p>
              <button type="button" className="btn btn-sm" onClick={onOpenOrchestration}>
                去编排 <IconChevronRight size={11} />
              </button>
            </div>
          ) : (
            <table className="team-table">
              <thead>
                <tr>
                  <th>模型 / 平台</th>
                  <th>角色 · 模式</th>
                  <th>强度</th>
                  <th>连接</th>
                  <th>调用</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((member) => {
                  const meta = PROVIDER_BY_ID[member.provider];
                  const live = liveFor(member);
                  const streaming = live?.state === "streaming";
                  const stopped = live?.state === "stopped";
                  const judge = judgeKey === keyOf(member.bindings[0]?.spec ?? { provider: member.provider, model: member.model });
                  return (
                    <tr
                      key={member.key}
                      className={`team-row${unavailable(member) ? " is-off" : ""}${stopped ? " is-stopped" : ""}`}
                      style={brandStyle(meta?.color ?? "#64748b") as unknown as CSSProperties}
                    >
                      <td>
                        <div className="team-model">
                          <BrandIcon provider={member.provider} size={22} title={`${meta?.name ?? member.provider} 官方商标`} />
                          <span className="team-model__names">
                            <b title={member.model}>{modelName(models, member.provider, member.model)}</b>
                            <em>{meta?.name ?? member.provider}</em>
                          </span>
                          {judge ? <span className="tag tag-accent">裁判</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="team-bindings">
                          {member.bindings.map((binding) => {
                            const roleName =
                              binding.mode === "coordinate"
                                ? resolveRoleLabel(binding.roleId, customRoles).name
                                : binding.roleName;
                            return (
                              <span className={`team-binding is-${binding.mode}`} key={`${binding.mode}:${binding.roleId}`}>
                                <span className="team-binding__mode">{binding.mode === "parallel" ? "并行" : "配合"}</span>
                                {roleName}
                                <button
                                  type="button"
                                  className="team-binding__remove"
                                  onClick={() => {
                                    if (binding.mode === "parallel") {
                                      if (member.parallelIndex != null) onRemoveParticipant(member.parallelIndex);
                                    } else {
                                      onToggleRoleModel(binding.roleId, binding.spec);
                                    }
                                  }}
                                  aria-label={`从${binding.mode === "parallel" ? "并行" : roleName}移除`}
                                  title={running ? "从该模式 / 角色移除（只影响下一次任务）" : "从该模式 / 角色移除"}
                                >
                                  <IconX size={8} />
                                </button>
                              </span>
                            );
                          })}
                          {member.parallelIndex != null ? (
                            <input
                              className="team-role-input"
                              value={participants[member.parallelIndex]?.role ?? ""}
                              onChange={(event) => onUpdateRole(member.parallelIndex as number, event.target.value)}
                              placeholder="角色说明"
                              maxLength={40}
                              aria-label="编辑并行角色说明"
                              title="并行模式下的角色说明（影响提示词）"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="team-effort">
                        <EffortSelector
                          size="sm"
                          value={member.effort ?? "medium"}
                          onChange={(effort) => applyEffort(member, effort)}
                          ariaLabel={`${modelName(models, member.provider, member.model)} 强度`}
                        />
                      </td>
                      <td>
                        <span className={`team-conn ${unavailable(member) ? "is-off" : "is-on"}`}>
                          <span className="dot" aria-hidden="true" />
                          {unavailable(member) ? "未连接" : "可用"}
                        </span>
                      </td>
                      <td className="mono team-calls">{callsFor(member)}</td>
                      <td className="team-row__actions">
                        {streaming && live ? (
                          <button
                            type="button"
                            className="team-stop"
                            onClick={() => onStopParticipant(live.id)}
                            title="只停止这个模型，其余模型继续"
                          >
                            <IconStopCircle size={11} /> 停止
                          </button>
                        ) : stopped ? (
                          <span className="team-stopped">已停止</span>
                        ) : null}
                        <button
                          type="button"
                          className="team-row__remove"
                          onClick={() => removeMember(member)}
                          aria-label={`移除 ${modelName(models, member.provider, member.model)}`}
                          title={running ? "从编队移除（只影响下一次任务）" : "从编队移除"}
                        >
                          <IconTrash size={11} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <footer className="team-drawer__foot">
          <span>运行中：增删/角色改动只影响下一次任务；档位实时生效</span>
          <span className="mono">运行中可单独停止某个模型</span>
        </footer>
      </aside>
    </div>
  );
}
