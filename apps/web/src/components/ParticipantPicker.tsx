import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ModelInfo, ModelOption, ParticipantSpec, ProviderId, ProviderStatus, RunMode } from "@super-work/core";
import { PROVIDER_BY_ID, PROVIDERS, findModel } from "@super-work/core";
import { brandStyle } from "../lib/brand";
import { formatNumber } from "../lib/format";
import {
  estimateCalls,
  estimateSeconds,
  JUDGE_MODES,
  MAX_PARTICIPANTS,
  MODE_EXPECTATION,
  MODE_META,
  MODE_TIP,
  participantKey,
} from "../lib/types";
import { BrandIcon } from "./BrandIcon";
import {
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconChevronRight,
  IconPlus,
  IconStar,
  IconTrash,
  IconUsers,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface ParticipantPickerProps {
  participants: ParticipantSpec[];
  models: ModelOption[];
  customModels: ModelInfo[];
  providers: ProviderStatus[];
  mode: RunMode;
  rounds: number;
  critique: boolean;
  judgeKey: string | null;
  onToggleModel: (provider: ProviderId, model: string) => void;
  onMove: (index: number, delta: number) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onRoleChange: (index: number, role: string) => void;
  onSetJudge: (key: string | null) => void;
  onAddCustomModel: (provider: ProviderId, modelId: string) => boolean;
  onRoundsChange: (value: number) => void;
  onCritiqueChange: (value: boolean) => void;
  onOpenSettings: () => void;
  open?: boolean;
}

interface PickerGroup {
  providerId: ProviderId;
  meta: (typeof PROVIDERS)[number];
  models: Array<ModelInfo & { available: boolean; custom: boolean; disabledReason?: string }>;
  connected: boolean;
}

function modelDisplay(provider: ProviderId, model: string): string {
  return findModel(provider, model)?.name ?? model;
}

export function ParticipantPicker({
  participants,
  models,
  customModels,
  providers,
  mode,
  rounds,
  critique,
  judgeKey,
  onToggleModel,
  onMove,
  onReorder,
  onRemove,
  onRoleChange,
  onSetJudge,
  onAddCustomModel,
  onRoundsChange,
  onCritiqueChange,
  onOpenSettings,
  open,
}: ParticipantPickerProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [customProvider, setCustomProvider] = useState<ProviderId>("thirdparty");
  const [customModelId, setCustomModelId] = useState("");

  const selectedKeys = useMemo(
    () => new Set(participants.map((participant) => participantKey(participant))),
    [participants],
  );
  const connectedIds = useMemo(
    () => new Set(providers.filter((provider) => provider.connected).map((provider) => provider.id)),
    [providers],
  );

  const groups = useMemo<PickerGroup[]>(() => {
    return PROVIDERS.map((meta, index) => {
      const catalogModels = models.filter((model) => model.provider === meta.id);
      const extras = customModels.filter((model) => model.provider === meta.id);
      const seen = new Set<string>();
      const entries: PickerGroup["models"] = [];
      for (const model of catalogModels) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        entries.push({
          id: model.id,
          name: model.name || model.id,
          provider: model.provider,
          reasoning: model.reasoning,
          vision: model.vision,
          tags: model.tags,
          contextWindow: model.contextWindow,
          available: model.available || meta.id === "mock",
          custom: false,
          disabledReason: model.disabledReason,
        });
      }
      if (entries.length === 0) {
        // /api/models 还没回来（或该 provider 没有模型）时用 core catalog 兜底。
        for (const model of meta.models) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          entries.push({
            id: model.id,
            name: model.name,
            provider: model.provider,
            reasoning: model.reasoning,
            vision: model.vision,
            tags: model.tags,
            contextWindow: model.contextWindow,
            available: meta.id === "mock",
            custom: false,
            disabledReason: meta.id === "mock" ? undefined : "未连接",
          });
        }
      }
      for (const model of extras) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        entries.push({
          ...model,
          available: true,
          custom: true,
          disabledReason: undefined,
        });
      }
      return {
        providerId: meta.id,
        meta,
        models: entries,
        connected: connectedIds.has(meta.id) || meta.id === "mock",
      };
    }).filter((group) => group.models.length > 0);
  }, [connectedIds, customModels, models]);

  const judgeParticipant = participants.find(
    (participant) => participantKey(participant) === judgeKey,
  );
  const judgeLabel = judgeParticipant
    ? modelDisplay(judgeParticipant.provider, judgeParticipant.model)
    : participants[0]
      ? `${modelDisplay(participants[0].provider, participants[0].model)}（默认第一位）`
      : "未设置";

  const unconnected = participants.filter(
    (participant) => participant.provider !== "mock" && !connectedIds.has(participant.provider),
  ).length;
  const estimate = estimateCalls({ mode, count: participants.length, rounds, critique });
  const reasoningHeavy = participants.some((participant) => {
    const option = models.find(
      (model) => model.provider === participant.provider && model.id === participant.model,
    );
    return option?.reasoning === true || /think|reason/i.test(participant.model);
  });

  const toggleGroup = (id: string): void => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCustomAdd = (): void => {
    const ok = onAddCustomModel(customProvider, customModelId);
    if (ok) {
      onToggleModel(customProvider, customModelId.trim());
      setCustomModelId("");
    }
  };

  return (
    <aside className={`rail rail-right${open ? " is-open" : ""}`} aria-label="参与模型编排">
      <div className="rail-head">
        <h2 className="rail-head__title">参与模型编排</h2>
        <span className="rail-head__count mono">
          {participants.length}/{MAX_PARTICIPANTS}
        </span>
      </div>

      <div className="rail-scroll rail-right__scroll">
        <section className="rail-section" aria-label="参与模型顺序与角色">
          <div className="rail-section__head">
            顺序与角色
            <span className="mono">拖拽或 ↑↓ 调整</span>
          </div>
          {participants.length === 0 ? (
            <div className="order-empty">
              还没有参与模型
              <br />
              从下方模型池点击加入
            </div>
          ) : (
            <ol className="order-list">
              {participants.map((participant, index) => {
                const meta = PROVIDER_BY_ID[participant.provider];
                const key = participantKey(participant);
                const isJudge = key === judgeKey;
                return (
                  <li
                    key={`${key}:${index}`}
                    className={`order-item${dragIndex === index ? " is-dragging" : ""}${
                      overIndex === index && dragIndex !== null && dragIndex !== index ? " is-drop-target" : ""
                    }`}
                    style={brandStyle(meta?.color ?? "#64748b") as unknown as CSSProperties}
                    draggable
                    onDragStart={(event) => {
                      setDragIndex(index);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", String(index));
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (dragIndex !== null && dragIndex !== index) setOverIndex(index);
                    }}
                    onDragLeave={() => setOverIndex((prev) => (prev === index ? null : prev))}
                    onDrop={(event) => {
                      event.preventDefault();
                      const raw = dragIndex ?? Number(event.dataTransfer.getData("text/plain"));
                      if (Number.isInteger(raw) && raw !== index) onReorder(raw, index);
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }}
                  >
                    <span className="order-item__index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="order-item__main">
                      <div className="order-item__title">
                        <BrandIcon provider={participant.provider} size={15} className="brand-icon--inline" title={`${meta?.name ?? participant.provider} 官方商标`} />
                        <span className="order-item__name" title={participant.model}>
                          {modelDisplay(participant.provider, participant.model)}
                        </span>
                        {isJudge ? (
                          <span className="order-item__judge">
                            <IconStar size={9} /> 裁决
                          </span>
                        ) : null}
                      </div>
                      <input
                        className="order-item__role"
                        value={participant.role ?? ""}
                        onChange={(event) => onRoleChange(index, event.target.value)}
                        placeholder="角色（注入 system prompt）"
                        aria-label={`${modelDisplay(participant.provider, participant.model)} 的角色`}
                        maxLength={60}
                      />
                    </div>
                    <div className="order-item__actions">
                      {JUDGE_MODES.includes(mode) ? (
                        <button
                          type="button"
                          className={`icon-btn${isJudge ? " is-judge" : ""}`}
                          onClick={() => onSetJudge(isJudge ? null : key)}
                          aria-label={isJudge ? "取消裁决者" : "设为裁决者"}
                          title={isJudge ? "取消裁决者" : "设为裁决者"}
                          aria-pressed={isJudge}
                        >
                          <IconStar size={12} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onMove(index, -1)}
                        disabled={index === 0}
                        aria-label="上移"
                        title="上移"
                      >
                        <IconArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onMove(index, 1)}
                        disabled={index === participants.length - 1}
                        aria-label="下移"
                        title="下移"
                      >
                        <IconArrowDown size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn is-danger"
                        onClick={() => onRemove(index)}
                        aria-label="移除该参与者"
                        title="移除"
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section className="rail-section" aria-label="从模型池添加参与者">
          <div className="rail-section__head">
            模型池
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: "auto", height: 20, fontSize: 10, padding: "0 6px" }}
              onClick={onOpenSettings}
            >
              管理连接
            </button>
          </div>
          <div>
            {groups.map((group, groupIndex) => {
              const hasSelected =
                participants.some((participant) => participant.provider === group.providerId) ||
                group.models.some((model) => selectedKeys.has(`${group.providerId}:${model.id}`));
              const defaultOpen = hasSelected || groupIndex < 2;
              const open = collapsed[group.providerId] === undefined
                ? defaultOpen
                : !collapsed[group.providerId];
              return (
                <div
                  className={`model-group${open ? " is-open" : ""}`}
                  key={group.providerId}
                  style={brandStyle(group.meta.color) as unknown as CSSProperties}
                >
                  <button
                    type="button"
                    className="model-group__head"
                    onClick={() => toggleGroup(group.providerId)}
                    aria-expanded={open}
                    aria-label={`${group.meta.name} 模型列表，${open ? "收起" : "展开"}`}
                  >
                    <span className={`dot ${group.connected ? "dot-brand" : "dot-off"}`} aria-hidden="true" />
                    <BrandIcon provider={group.providerId} size={16} className="brand-icon--inline" title={`${group.meta.name} 官方商标`} />
                    <span className="model-group__name">{group.meta.name}</span>
                    <span className="model-group__count">
                      {group.models.filter((model) => selectedKeys.has(`${group.providerId}:${model.id}`)).length}
                      /{group.models.length}
                    </span>
                    <span className="model-group__chevron" aria-hidden="true">
                      <IconChevronRight size={11} />
                    </span>
                  </button>
                  {open ? (
                    <div className="model-group__list">
                      {group.models.map((model) => {
                        const key = `${group.providerId}:${model.id}`;
                        const selected = selectedKeys.has(key);
                        const unavailable = !model.available && !selected;
                        return (
                          <button
                            type="button"
                            key={`${key}:${model.custom ? "custom" : "catalog"}`}
                            className={`model-option${selected ? " is-selected" : ""}`}
                            onClick={() => onToggleModel(group.providerId, model.id)}
                            aria-pressed={selected}
                            title={
                              unavailable
                                ? `${group.meta.name} 尚未连接，运行时会失败（可在设置里录入凭证）`
                                : `${model.name} · ${model.id}${model.contextWindow ? ` · 上下文 ${formatNumber(model.contextWindow)}` : ""}`
                            }
                          >
                            <span className="model-option__plus" aria-hidden="true">
                              {selected ? <IconTrash size={10} /> : <IconPlus size={10} />}
                            </span>
                            <span className="model-option__name">{model.name}</span>
                            <span className="model-option__tags">
                              {model.reasoning ? <span className="model-option__tag">推理</span> : null}
                              {model.vision ? <span className="model-option__tag">视觉</span> : null}
                              {model.custom ? <span className="model-option__tag">自定义</span> : null}
                              {unavailable ? (
                                <span className="model-option__state is-off">{model.disabledReason ?? "未连接"}</span>
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <form
            className="custom-model-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleCustomAdd();
            }}
            aria-label="手动添加模型 ID"
          >
            <select
              className="select"
              value={customProvider}
              onChange={(event) => setCustomProvider(event.target.value as ProviderId)}
              aria-label="自定义模型所属 provider"
            >
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.short}
                </option>
              ))}
            </select>
            <input
              className="input"
              value={customModelId}
              onChange={(event) => setCustomModelId(event.target.value)}
              placeholder="手动添加模型 ID"
              aria-label="手动输入模型 ID"
              maxLength={120}
            />
            <button type="submit" className="btn btn-sm" disabled={customModelId.trim().length === 0}>
              添加
            </button>
          </form>
          <p className="rail-note">
            模型名可被覆盖/追加：第三方兼容端点、火山方舟接入点 <span className="mono">ep-xxx</span> 都可直接填 ID。
          </p>
        </section>

        <section className="rail-section" aria-label="模式说明">
          <div className="rail-section__head">模式 · {MODE_META[mode].name}</div>
          <div className="info-card">
            <div className="info-card__title">
              <IconUsers size={13} /> {MODE_META[mode].name}
              <span className="tag" style={{ marginLeft: "auto" }}>
                {MODE_META[mode].short}
              </span>
            </div>
            <p className="info-card__desc">{MODE_TIP[mode]}</p>
            <div className="stage-plan" aria-label="阶段预期">
              {MODE_EXPECTATION[mode].map((stage) => (
                <span className="stage-plan__item" key={stage}>
                  {stage}
                </span>
              ))}
            </div>

            {mode === "council" || mode === "debate" ? (
              <div className="option-row">
                <span className="option-row__label">
                  {mode === "debate" ? "辩论轮数" : "互评轮数"}
                </span>
                <div className="stepper" role="group" aria-label="轮数">
                  <button
                    type="button"
                    onClick={() => onRoundsChange(rounds - 1)}
                    disabled={rounds <= 1}
                    aria-label="减少轮数"
                  >
                    −
                  </button>
                  <span className="stepper__value">{rounds}</span>
                  <button
                    type="button"
                    onClick={() => onRoundsChange(rounds + 1)}
                    disabled={rounds >= 5}
                    aria-label="增加轮数"
                  >
                    +
                  </button>
                </div>
              </div>
            ) : null}

            {mode === "council" ? (
              <div className="option-row">
                <span className="option-row__label">开启互评（第二轮补充/纠错）</span>
                <PaddleSwitch
                  checked={critique}
                  onChange={(next) => onCritiqueChange(next)}
                  ariaLabel="开启互评"
                />
              </div>
            ) : null}
          </div>
        </section>

        <section className="rail-section" aria-label="本次预计行为">
          <div className="rail-section__head">本次预计</div>
          <div className="info-card">
            <div className="estimate-number">
              <span className="estimate-number__value">{estimate.calls}</span>
              <span className="estimate-number__unit">次模型调用 · {estimateSeconds(estimate.calls, reasoningHeavy)}</span>
            </div>
            <p className="estimate-formula">{estimate.formula}</p>
            <div className="judge-line">
              <IconStar size={11} /> 裁决者：<strong>{JUDGE_MODES.includes(mode) ? judgeLabel : "无（最后一棒兼定稿）"}</strong>
            </div>
            {participants.length === 0 ? (
              <div className="estimate-warnings">
                <div className="estimate-warning is-error">
                  <IconAlert size={10} /> 至少加入 1 个参与模型才能运行。
                </div>
              </div>
            ) : null}
            {mode === "debate" && participants.length < 2 ? (
              <div className="estimate-warnings">
                <div className="estimate-warning">
                  <IconAlert size={10} /> 辩论模式建议至少 2 个模型，否则只能单人执行。
                </div>
              </div>
            ) : null}
            {unconnected > 0 ? (
              <div className="estimate-warnings">
                <div className="estimate-warning">
                  <IconAlert size={10} /> {unconnected} 个模型所在 provider 未连接，调用会报错但不会中断整轮。
                </div>
              </div>
            ) : null}
            {participants.length >= MAX_PARTICIPANTS ? (
              <div className="estimate-warnings">
                <div className="estimate-warning">
                  <IconAlert size={10} /> 已达参与者上限，先移除再添加。
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="rail-right__foot">
        数据仅存本机 · 运行前请确认右上角“已连接”数量 · <span className="mono">v0.0.1</span>
      </div>
    </aside>
  );
}
