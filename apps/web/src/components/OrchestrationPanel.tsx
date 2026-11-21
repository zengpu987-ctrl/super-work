import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  CustomRoleDef,
  EffortLevel,
  ModelInfo,
  ModelOption,
  ModelPrice,
  ParticipantSpec,
  RunMode,
} from "@super-work/core";
import { COORD_ROLES, PROVIDER_BY_ID } from "@super-work/core";
import { brandStyle } from "../lib/brand";
import { api } from "../lib/api";
import { effortOf } from "../lib/effort";
import type { CoordinationState, RoleEnabledState } from "../lib/useWorkbench";
import { LEGACY_MODES, specKey } from "../lib/types";
import { formatNumber } from "../lib/format";
import { sortedCustomRoles, type RoleNameCheck } from "../lib/v3";
import { BrandIcon } from "./BrandIcon";
import { CustomRoleDrawer, type CustomRoleDraft } from "./CustomRoleDrawer";
import { EffortSelector } from "./EffortSelector";
import { ModelPool, buildPoolGroups, selectedModelLabel } from "./ModelPool";
import {
  IconAlert,
  IconChat,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconCopy,
  IconEdit,
  IconGrip,
  IconLayers,
  IconPlus,
  IconStar,
  IconTrash,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

interface RoleRowMeta {
  id: string;
  name: string;
  description: string;
  kind: "text" | "image";
  hint?: string;
  custom?: CustomRoleDef;
}

export interface OrchestrationPanelProps {
  mode: RunMode;
  running: boolean;
  models: ModelOption[];
  customModels: ModelInfo[];
  participants: ParticipantSpec[];
  judgeKey: string | null;
  coordination: CoordinationState;
  roleEnabled: RoleEnabledState;
  onModeChange: (mode: RunMode) => void;
  onToggleParticipant: (spec: ParticipantSpec) => void;
  onRemoveParticipant: (index: number) => void;
  onUpdateRole: (index: number, role: string) => void;
  onUpdateParticipantEffort: (index: number, effort: EffortLevel) => void;
  onSetJudge: (key: string | null) => void;
  onToggleRoleModel: (role: string, spec: ParticipantSpec) => void;
  onUpdateRoleModelEffort: (role: string, key: string, effort: EffortLevel) => void;
  onClearRole: (role: string) => void;
  onSetRoleEnabled: (role: string, enabled: boolean) => void;
  onSetRoleParticipants: (role: string, specs: ParticipantSpec[]) => void;
  onOpenSettings: () => void;
  /* v0.0.3 自定义角色 */
  customRoles: CustomRoleDef[];
  onCreateCustomRole: (input: {
    name: string;
    description: string;
    kind: "text" | "image";
  }) => { role?: CustomRoleDef; error?: RoleNameCheck };
  onUpdateCustomRole: (id: string, patch: Partial<Omit<CustomRoleDef, "id">>) => RoleNameCheck;
  onDeleteCustomRole: (id: string) => void;
  onDuplicateCustomRole: (id: string) => CustomRoleDef | undefined;
  onReorderCustomRoles: (fromId: string, toId: string) => void;
  onMoveCustomRole: (id: string, delta: number) => void;
  /** Chat：唯一模型与档位 */
  chatModel: ParticipantSpec | null;
  onSetChatModel: (spec: ParticipantSpec | null) => void;
  onUpdateChatEffort: (effort: EffortLevel) => void;
  /** Chat 与团队互通 */
  onHandoffToTeam: (mode?: RunMode) => void;
}

const ASSUMED_INPUT = 1200;
const ASSUMED_OUTPUT = 600;

function findPrice(prices: ModelPrice[], spec: ParticipantSpec): ModelPrice | undefined {
  return (
    prices.find((price) => price.provider === spec.provider && price.model === spec.model) ??
    prices.find((price) => price.provider === spec.provider && price.model === "*")
  );
}

export function OrchestrationPanel({
  mode,
  running,
  models,
  customModels,
  participants,
  judgeKey,
  coordination,
  roleEnabled,
  onModeChange,
  onToggleParticipant,
  onRemoveParticipant,
  onUpdateRole,
  onUpdateParticipantEffort,
  onSetJudge,
  onToggleRoleModel,
  onUpdateRoleModelEffort,
  onClearRole,
  onSetRoleEnabled,
  onSetRoleParticipants,
  onOpenSettings,
  customRoles,
  onCreateCustomRole,
  onUpdateCustomRole,
  onDeleteCustomRole,
  onDuplicateCustomRole,
  onReorderCustomRoles,
  onMoveCustomRole,
  chatModel,
  onSetChatModel,
  onUpdateChatEffort,
  onHandoffToTeam,
}: OrchestrationPanelProps) {
  const [prices, setPrices] = useState<ModelPrice[] | null>(null);
  const [priceFailed, setPriceFailed] = useState(false);
  const [openRole, setOpenRole] = useState<string | null>(null);
  const [poolRole, setPoolRole] = useState<string | null>(null);
  const [poolOpen, setPoolOpen] = useState(true);
  const [drawer, setDrawer] = useState<{ mode: "create" | "edit"; roleId?: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragRoleId, setDragRoleId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.getBillingPrices();
        if (!cancelled) setPrices(list);
      } catch {
        if (!cancelled) {
          setPrices(null);
          setPriceFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => buildPoolGroups(models, customModels), [customModels, models]);
  const coordinate = mode === "coordinate";
  const chat = mode === "chat";
  const customSorted = useMemo(() => sortedCustomRoles(customRoles), [customRoles]);
  const allRoles = useMemo<RoleRowMeta[]>(
    () => [
      ...COORD_ROLES.map((role) => ({
        id: role.id as string,
        name: role.name,
        description: role.description,
        kind: role.kind,
        hint: role.hint,
      })),
      ...customSorted.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description || "自定义角色",
        kind: role.kind,
        hint: "自定义角色 · 可拖拽排序、复制或删除",
        custom: role,
      })),
    ],
    [customSorted],
  );
  const drawerRole = drawer?.roleId ? customSorted.find((role) => role.id === drawer.roleId) : undefined;

  const selectedSpecs = useMemo(() => {
    if (!coordinate) return participants;
    return allRoles.flatMap((role) => coordination[role.id] ?? []);
  }, [allRoles, coordination, coordinate, participants]);

  const selectedKeys = useMemo(() => new Set(selectedSpecs.map(specKey)), [selectedSpecs]);
  const judgeSpec = participants.find((spec) => specKey(spec) === judgeKey);
  const configuredRoles = allRoles.filter((role) => (coordination[role.id]?.length ?? 0) > 0).length;

  const estimate = useMemo(() => {
    let calls = 0;
    let cost = 0;
    let unpriced = 0;
    const addCall = (spec: ParticipantSpec) => {
      calls += 1;
      if (!prices) return;
      const price = findPrice(prices, spec);
      if (!price) {
        unpriced += 1;
        return;
      }
      const outputMultiplier = effortOf(spec.effort).maxTokensMultiplier;
      cost +=
        (ASSUMED_INPUT / 1_000_000) * price.inputPerMTokens +
        ((ASSUMED_OUTPUT * outputMultiplier) / 1_000_000) * price.outputPerMTokens;
    };
    if (chat) {
      if (chatModel) addCall(chatModel);
    } else if (coordinate) {
      for (const role of allRoles) {
        if (roleEnabled[role.id] === false) continue;
        for (const spec of coordination[role.id] ?? []) addCall(spec);
      }
    } else {
      for (const spec of participants) addCall(spec);
      if (judgeSpec) addCall(judgeSpec);
    }
    const formula = chat
      ? chatModel
        ? `Chat 单模型 · ${chatModel.model}`
        : "Chat 还没有选择模型"
      : coordinate
      ? allRoles
          .filter((role) => roleEnabled[role.id] !== false && (coordination[role.id]?.length ?? 0) > 0)
          .map((role) => `${role.name} ${coordination[role.id]!.length}`)
          .join(" + ")
      : `${participants.length} 个模型并行${judgeSpec ? " + 裁判 1" : ""}`;
    return { calls, cost, unpriced, formula };
  }, [allRoles, chat, chatModel, coordinate, coordination, judgeSpec, participants, prices, roleEnabled]);

  const costText = (() => {
    if (!prices) return priceFailed ? "未定价" : "读取价格…";
    if (estimate.calls === 0) return "—";
    if (estimate.unpriced === estimate.calls) return "未定价";
    const currency = prices[0]?.currency === "USD" ? "$" : "¥";
    return `${currency}${estimate.cost.toFixed(2)}${estimate.unpriced > 0 ? " 起" : ""}`;
  })();

  return (
    <div className="orchestration">
      <div className="orchestration__head">
        <div>
          <h2 className="rail-panel-title">{coordinate ? "角色编排" : chat ? "Chat 模型" : "参与模型"}</h2>
          <p className="rail-panel-sub">
            {coordinate
              ? `已配置 ${configuredRoles}/${allRoles.length} 个角色 · 自定义 ${customSorted.length}/24 · 未配置的角色不会调用`
              : chat
                ? "每次只能选 1 个模型聊天；支持多轮上下文与档位调节"
                : "并行模式下所有选中模型同时作答"}
          </p>
        </div>
        {running ? <span className="tag tag-warn">运行中锁定</span> : null}
      </div>

      <div className="estimate-box">
        <div className="estimate-box__row">
          <span>预计调用</span>
          <b className="mono">{formatNumber(estimate.calls)}</b>
          <span className="estimate-box__sep">次</span>
          <span className="estimate-box__cost">
            成本 <b className="mono">{costText}</b>
          </span>
        </div>
        <p
          className="estimate-box__formula"
          title="成本按每次调用约 1.2k 输入 + 0.6k 输出（再乘强度输出倍率）粗估，真实费用以计费页为准"
        >
          {estimate.formula || "还没有配置任何模型"}
          {prices && estimate.unpriced > 0 ? ` · ${estimate.unpriced} 个模型未定价` : ""}
        </p>
      </div>

      {coordinate ? (
        <div className="role-list" role="list" aria-label="角色槽位">
          {allRoles.map((role) => {
            const list = coordination[role.id] ?? [];
            const enabled = roleEnabled[role.id] !== false;
            const active = list.length > 0 && enabled;
            const open = openRole === role.id;
            const isPool = poolRole === role.id;
            const custom = role.custom;
            return (
              <div
                className={`role-row${open ? " is-open" : ""}${active ? " is-active" : ""}${list.length === 0 ? " is-empty" : ""}${custom ? " is-custom" : ""}${dragRoleId === role.id ? " is-dragging" : ""}`}
                key={role.id}
                role="listitem"
                onDragOver={
                  custom
                    ? (event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }
                    : undefined
                }
                onDrop={
                  custom
                    ? (event) => {
                        event.preventDefault();
                        const from = event.dataTransfer.getData("text/custom-role");
                        if (from && from !== role.id) onReorderCustomRoles(from, role.id);
                        setDragRoleId(null);
                      }
                    : undefined
                }
              >
                <div
                  className="role-row__head"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setOpenRole(open ? null : role.id);
                    if (open) setPoolRole(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenRole(open ? null : role.id);
                      if (open) setPoolRole(null);
                    }
                  }}
                  aria-expanded={open}
                  title={role.description}
                >
                  <span className={`role-row__chevron${open ? " is-open" : ""}`} aria-hidden="true">
                    <IconChevronDown size={11} />
                  </span>
                  {custom ? (
                    <span
                      className="role-row__grip"
                      draggable={!running}
                      title="拖拽排序"
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/custom-role", role.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragRoleId(role.id);
                      }}
                      onDragEnd={() => setDragRoleId(null)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <IconGrip size={12} />
                    </span>
                  ) : null}
                  <span className="role-row__name">
                    {role.name}
                    {role.kind === "image" ? <span className="tag tag-warn">生图</span> : null}
                    {custom ? <span className="tag tag-custom">自定义</span> : null}
                  </span>
                  <span className={`role-row__count${list.length === 0 || !enabled ? " is-empty" : ""}`}>
                    {list.length === 0
                      ? "未配置 · 不会调用"
                      : enabled
                        ? `${list.length} 模型`
                        : "已关闭 · 不会调用"}
                  </span>
                  {custom ? (
                    <span className="role-row__actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="role-row__action"
                        onClick={() => onMoveCustomRole(role.id, -1)}
                        disabled={running}
                        title="上移"
                        aria-label="上移角色"
                      >
                        <IconArrowUp size={11} />
                      </button>
                      <button
                        type="button"
                        className="role-row__action"
                        onClick={() => onMoveCustomRole(role.id, 1)}
                        disabled={running}
                        title="下移"
                        aria-label="下移角色"
                      >
                        <IconArrowDown size={11} />
                      </button>
                      <button
                        type="button"
                        className="role-row__action"
                        onClick={() => setDrawer({ mode: "edit", roleId: role.id })}
                        disabled={running}
                        title="编辑角色"
                        aria-label={`编辑 ${role.name}`}
                      >
                        <IconEdit size={11} />
                      </button>
                      <button
                        type="button"
                        className="role-row__action"
                        onClick={() => {
                          const copy = onDuplicateCustomRole(role.id);
                          if (copy) setOpenRole(copy.id);
                        }}
                        disabled={running}
                        title="复制角色"
                        aria-label={`复制 ${role.name}`}
                      >
                        <IconCopy size={11} />
                      </button>
                      <button
                        type="button"
                        className={`role-row__action is-danger${confirmDeleteId === role.id ? " is-confirm" : ""}`}
                        onClick={() => {
                          if (confirmDeleteId === role.id) {
                            onDeleteCustomRole(role.id);
                            setConfirmDeleteId(null);
                            if (openRole === role.id) setOpenRole(null);
                            return;
                          }
                          setConfirmDeleteId(role.id);
                          window.setTimeout(
                            () => setConfirmDeleteId((prev) => (prev === role.id ? null : prev)),
                            4000,
                          );
                        }}
                        disabled={running}
                        title={confirmDeleteId === role.id ? "再次点击确认删除（历史运行保留快照）" : "删除角色"}
                        aria-label={confirmDeleteId === role.id ? `确认删除 ${role.name}` : `删除 ${role.name}`}
                      >
                        {confirmDeleteId === role.id ? <span className="role-row__confirm">确认</span> : <IconTrash size={11} />}
                      </button>
                    </span>
                  ) : null}
                  <PaddleSwitch
                    size="sm"
                    checked={active}
                    disabled={running || list.length === 0}
                    onChange={() => onSetRoleEnabled(role.id, !enabled)}
                    ariaLabel={`${role.name}${enabled ? "停用" : "启用"}`}
                    title={active ? "停用该角色（不会调用）" : "启用该角色"}
                  />
                </div>

                {open ? (
                  <div className="role-row__body">
                    <p className="role-row__desc">{role.description}</p>
                    {role.hint ? <p className="role-row__hint">提示：{role.hint}</p> : null}

                    <div className="role-model-list">
                      {list.map((spec) => {
                        const provider = PROVIDER_BY_ID[spec.provider];
                        const key = specKey(spec);
                        return (
                          <div className="role-model-row" key={key}>
                            <BrandIcon provider={spec.provider} size={14} className="brand-icon--inline" title={`${provider?.name ?? spec.provider} 官方商标`} />
                            <span
                              className="role-model-row__name"
                              title={`${provider?.name ?? spec.provider} · ${spec.model}`}
                            >
                              {selectedModelLabel(spec, models)}
                              <em>{provider?.name ?? spec.provider}</em>
                            </span>
                            <EffortSelector
                              size="sm"
                              value={spec.effort}
                              onChange={(effort) => onUpdateRoleModelEffort(role.id, key, effort)}
                              disabled={running}
                              ariaLabel={`${selectedModelLabel(spec, models)} 强度`}
                            />
                            <button
                              type="button"
                              className="role-model-row__remove"
                              onClick={() => onToggleRoleModel(role.id, spec)}
                              disabled={running}
                              aria-label={`移除 ${selectedModelLabel(spec, models)}`}
                              title="移除该模型"
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      className={`role-add${isPool ? " is-open" : ""}`}
                      onClick={() => setPoolRole(isPool ? null : role.id)}
                      aria-expanded={isPool}
                    >
                      <IconPlus size={12} /> 模型
                    </button>

                    {isPool ? (
                      <div className="role-pool">
                        <ModelPool
                          groups={groups}
                          selected={new Set(list.map(specKey))}
                          onToggle={(spec) => onToggleRoleModel(role.id, spec)}
                          disabled={running}
                          selectionLabel="点击模型加入该角色；未配置的角色不会产生任何调用。"
                        />
                      </div>
                    ) : null}

                    <div className="role-row__foot">
                      <span>{list.length > 0 ? `${list.length} 个模型` : "空角色 0 次调用"}</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => onClearRole(role.id)}
                        disabled={running || list.length === 0}
                      >
                        <IconTrash size={11} /> 清空
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          <button
            type="button"
            className="role-create-slot"
            onClick={() => setDrawer({ mode: "create" })}
            disabled={running || customSorted.length >= 24}
            title={
              customSorted.length >= 24
                ? "自定义角色上限 24 个"
                : "新增自定义角色（名称 2-12 字、职责 ≤200、模型多选）"
            }
          >
            <IconPlus size={13} /> 角色
            <span className="mono">{customSorted.length}/24</span>
          </button>

          <CustomRoleDrawer
            open={!!drawer}
            mode={drawer?.mode ?? "create"}
            role={drawerRole}
            roles={customSorted}
            groups={groups}
            models={models}
            initialModels={drawerRole ? coordination[drawerRole.id] ?? [] : []}
            running={running}
            onClose={() => setDrawer(null)}
            onSave={(draft: CustomRoleDraft): RoleNameCheck => {
              if (drawer?.mode === "edit" && drawer.roleId) {
                const result = onUpdateCustomRole(drawer.roleId, {
                  name: draft.name,
                  description: draft.description,
                  kind: draft.kind,
                });
                if (!result.ok) return result;
                onSetRoleParticipants(drawer.roleId, draft.models);
                setDrawer(null);
                setOpenRole(drawer.roleId);
                return { ok: true };
              }
              const result = onCreateCustomRole({
                name: draft.name,
                description: draft.description,
                kind: draft.kind,
              });
              if (!result.role) {
                return result.error ?? { ok: false, message: "创建角色失败" };
              }
              onSetRoleParticipants(result.role.id, draft.models);
              setDrawer(null);
              setOpenRole(result.role.id);
              return { ok: true };
            }}
          />
        </div>
      ) : chat ? (
        <div className="chat-panel">
          <div className="chat-panel__hint">
            <IconChat size={12} /> 点击模型即切换；运行中可在画布上直接调档
          </div>

          {chatModel ? (
            (() => {
              const meta = PROVIDER_BY_ID[chatModel.provider];
              return (
                <div
                  className="chat-panel__current"
                  style={brandStyle(meta?.color ?? "#64748b") as unknown as CSSProperties}
                >
                  <BrandIcon provider={chatModel.provider} size={26} title={`${meta?.name ?? chatModel.provider} 官方商标`} />
                  <div className="chat-panel__names">
                    <b>{selectedModelLabel(chatModel, models)}</b>
                    <em>{meta?.name ?? chatModel.provider}</em>
                  </div>
                  <EffortSelector
                    size="sm"
                    value={chatModel.effort ?? "medium"}
                    onChange={(effort) => onUpdateChatEffort(effort)}
                    disabled={running}
                    ariaLabel="Chat 档位"
                  />
                  {!running ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onSetChatModel(null)}
                      title="清空 Chat 模型"
                      aria-label="清空 Chat 模型"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <div className="rail-empty">
              <strong>还没有选择 Chat 模型</strong>
              从下方模型池点一个；Chat 每次只能和一个模型聊天。
            </div>
          )}

          <div className="chat-panel__handoff">
            <span>聊完想交给团队？</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onHandoffToTeam("parallel")}>
              并行接手
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onHandoffToTeam("coordinate")}>
              配合接手
            </button>
          </div>

          <ModelPool
            groups={groups}
            selected={chatModel ? new Set([specKey(chatModel)]) : new Set()}
            onToggle={(spec) => onSetChatModel(spec)}
            disabled={running}
            singleSelect
            selectionLabel="Chat 只能选 1 个模型；点击即切换。"
          />
          {running ? <p className="chat-panel__run-hint">运行中可在画布上直接调档，下一轮生效。</p> : null}
        </div>
      ) : (
        <>
          <div className="orchestration__strategy">
            <label className="field-row field-row--inline">
              <span>作答策略</span>
              <select
                className="select"
                value={mode}
                onChange={(event) => onModeChange(event.target.value as RunMode)}
                disabled={running}
              >
                <option value="parallel">并行 · 独立作答 + 综合</option>
                {LEGACY_MODES.map((item) => (
                  <option value={item} key={item}>
                    {item === "council"
                      ? "议会 · 互评后综合"
                      : item === "debate"
                        ? "辩论 · 正反方 + 裁决"
                        : item === "pipeline"
                          ? "接力 · 顺序传递"
                          : item === "vote"
                            ? "投票 · 打分选优"
                            : "自动调度 · 拆任务分派"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="selected-list" role="list" aria-label="已选参与模型">
            <div className="selected-list__head">
              <span>已选 {participants.length} 个</span>
              <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
                <IconPlus size={11} /> 连接模型
              </button>
            </div>
            {participants.length === 0 ? (
              <div className="rail-empty">
                <strong>还没有参与模型</strong>
                从下方模型池勾选，或先连接一个 provider。
              </div>
            ) : (
              participants.map((spec, index) => {
                const meta = PROVIDER_BY_ID[spec.provider];
                const key = specKey(spec);
                const isJudge = judgeKey === key;
                return (
                  <div className={`selected-row${isJudge ? " is-judge" : ""}`} key={`${key}:${index}`} role="listitem">
                    <div className="selected-row__top">
                      <BrandIcon provider={spec.provider} size={15} className="brand-icon--inline" title={`${meta?.name ?? spec.provider} 官方商标`} />
                      <span className="selected-row__name" title={`${meta?.name ?? spec.provider} · ${spec.model}`}>
                        {selectedModelLabel(spec, models)}
                      </span>
                      <EffortSelector
                        size="sm"
                        value={spec.effort}
                        onChange={(effort) => onUpdateParticipantEffort(index, effort)}
                        disabled={running}
                        ariaLabel={`${selectedModelLabel(spec, models)} 强度`}
                      />
                      <button
                        type="button"
                        className={`icon-btn${isJudge ? " is-judge" : ""}`}
                        onClick={() => onSetJudge(isJudge ? null : key)}
                        disabled={running}
                        title={isJudge ? "取消裁判" : "设为裁判（最终答案由它综合）"}
                        aria-label={isJudge ? "取消裁判" : "设为裁判"}
                      >
                        <IconStar size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onRemoveParticipant(index)}
                        disabled={running}
                        aria-label={`移除 ${selectedModelLabel(spec, models)}`}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                    <input
                      className="selected-row__role"
                      value={spec.role ?? ""}
                      placeholder="角色说明（可留空）"
                      maxLength={40}
                      disabled={running}
                      onChange={(event) => onUpdateRole(index, event.target.value)}
                      aria-label={`${selectedModelLabel(spec, models)} 的角色说明`}
                    />
                  </div>
                );
              })
            )}
          </div>

          {participants.length > 1 ? (
            <div className="judge-row">
              <span>裁判 / 综合</span>
              <select
                className="select"
                value={judgeKey ?? ""}
                onChange={(event) => onSetJudge(event.target.value || null)}
                disabled={running}
                aria-label="选择裁判模型"
              >
                <option value="">不设裁判（按顺序拼接）</option>
                {participants.map((spec) => (
                  <option value={specKey(spec)} key={specKey(spec)}>
                    {selectedModelLabel(spec, models)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="pool-block">
            <button
              type="button"
              className="pool-block__head"
              onClick={() => setPoolOpen((prev) => !prev)}
              aria-expanded={poolOpen}
            >
              <IconLayers size={12} />
              模型池
              <span className="mono">{groups.reduce((sum, group) => sum + group.models.length, 0)}</span>
              <span className={`pool-block__chevron${poolOpen ? " is-open" : ""}`}>
                <IconChevronDown size={12} />
              </span>
            </button>
            {poolOpen ? (
              <ModelPool
                groups={groups}
                selected={selectedKeys}
                onToggle={onToggleParticipant}
                disabled={running}
                selectionLabel="支持 relay 站点分组与 WorkBuddy 积分模型；关闭连接的分组会置灰。"
              />
            ) : null}
          </div>
        </>
      )}

      {priceFailed ? (
        <div className="estimate-hint">
          <IconAlert size={11} /> 计费接口未就绪，成本显示为「未定价」；调用次数估算不受影响。
        </div>
      ) : null}
    </div>
  );
}
