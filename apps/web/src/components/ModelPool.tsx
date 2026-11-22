import { useMemo, useState } from "react";
import type { ModelInfo, ModelOption, ParticipantSpec, ProviderId } from "@super-work/core";
import { PROVIDER_BY_ID } from "@super-work/core";
import { specFromModel, specKey } from "../lib/types";
import { BrandIcon } from "./BrandIcon";
import { IconChevronDown, IconSearch, IconStar } from "./Icons";

export interface PoolGroup {
  key: string;
  label: string;
  sub?: string;
  provider: ProviderId;
  models: ModelOption[];
}

export function buildPoolGroups(models: ModelOption[], customModels: ModelInfo[]): PoolGroup[] {
  const map = new Map<string, PoolGroup>();
  const add = (raw: ModelInfo, available: boolean, disabledReason?: string) => {
    const provider = raw.provider;
    const relayId = raw.relayId;
    const key =
      provider === "relay"
        ? `relay:${relayId ?? "unknown"}`
        : provider === "workbuddy"
          ? `workbuddy:${raw.relayId ?? raw.providedBy ?? "default"}`
          : `provider:${provider}`;
    let group = map.get(key);
    if (!group) {
      const providerMeta = PROVIDER_BY_ID[provider as keyof typeof PROVIDER_BY_ID];
      let label = providerMeta?.name ?? provider;
      if (provider === "relay") label = raw.providerLabel ?? providerMeta?.name ?? "中转站";
      if (provider === "workbuddy") label = raw.providedBy ?? "WorkBuddy";
      group = {
        key,
        label,
        sub:
          provider === "workbuddy"
            ? raw.creditMultiplier
              ? `积分 ×${raw.creditMultiplier}`
              : "本机账号"
            : provider === "relay"
              ? "中转站"
              : undefined,
        provider,
        models: [],
      };
      map.set(key, group);
    }
    if (group.models.some((item) => item.id === raw.id && item.provider === provider)) return;
    group.models.push({
      ...raw,
      available,
      connections: available ? 1 : 0,
      disabledReason,
    });
  };
  for (const model of models) add(model, model.available, model.disabledReason);
  for (const model of customModels) add(model, true);
  // 选中的 / 已连接的组排在前面
  return [...map.values()]
    .map((group) => ({
      ...group,
      models: [...group.models].sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        return a.name.localeCompare(b.name, "zh");
      }),
    }))
    .sort((a, b) => {
      const aOn = a.models.some((m) => m.available) ? 0 : 1;
      const bOn = b.models.some((m) => m.available) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.label.localeCompare(b.label, "zh");
    });
}

export interface ModelPoolProps {
  groups: PoolGroup[];
  selected: Set<string>;
  onToggle: (spec: ParticipantSpec) => void;
  disabled?: boolean;
  emptyHint?: string;
  /** 每行额外显示的角色标签 */
  selectionLabel?: string;
  /** 单选模式（Chat）：同一时间只能选中一个 */
  singleSelect?: boolean;
}

export function ModelPool({ groups, selected, onToggle, disabled, emptyHint, selectionLabel, singleSelect }: ModelPoolProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter(
          (model) =>
            model.name.toLowerCase().includes(q) ||
            model.id.toLowerCase().includes(q) ||
            group.label.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);

  if (groups.length === 0) {
    return (
      <div className="pool-empty">
        {emptyHint ?? "还没有可用模型。先在设置里连接一个 provider，或导入中转站 / WorkBuddy。"}
      </div>
    );
  }

  return (
    <div className="model-pool">
      <div className="model-pool__search">
        <IconSearch size={12} />
        <input
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型 / 站点"
          aria-label="搜索模型"
        />
      </div>
      <div className="model-pool__groups">
        {filtered.length === 0 ? (
          <div className="pool-empty">没有匹配「{query}」的模型。</div>
        ) : (
          filtered.map((group) => {
            const open = query.trim().length > 0 ? true : !collapsed[group.key];
            const count = group.models.filter((model) => selected.has(specKey(specFromModel(model)))).length;
            return (
              <section className="pool-group" key={group.key}>
                <button
                  type="button"
                  className="pool-group__head"
                  onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
                  aria-expanded={open}
                >
                  <span className={`pool-group__chevron${open ? " is-open" : ""}`}>
                    <IconChevronDown size={11} />
                  </span>
                  <BrandIcon provider={group.provider} size={16} className="brand-icon--inline" title={`${group.label} 官方商标`} />
                  <span className="pool-group__name">{group.label}</span>
                  {group.sub ? <span className="pool-group__sub">{group.sub}</span> : null}
                  <span className="pool-group__count mono">
                    {count > 0 ? `${count} / ` : ""}
                    {group.models.length}
                  </span>
                </button>
                {open ? (
                  <div className="pool-group__list">
                    {group.models.map((model) => {
                      const spec = specFromModel(model);
                      const key = specKey(spec);
                      const isSelected = selected.has(key);
                      const unavailable = !model.available && !isSelected;
                      return (
                        <button
                          type="button"
                          key={`${group.key}:${model.id}`}
                          className={`pool-model${isSelected ? " is-selected" : ""}`}
                          onClick={() => onToggle(spec)}
                          disabled={disabled || unavailable}
                          aria-pressed={isSelected}
                          title={
                            unavailable
                              ? model.disabledReason ?? "该模型当前不可用"
                              : model.contextWindow
                                ? `上下文 ${model.contextWindow.toLocaleString()} tokens`
                                : model.name
                          }
                        >
                          <span
                            className={`pool-model__check${isSelected ? " is-on" : ""}${singleSelect ? " pool-model__check--radio" : ""}`}
                            aria-hidden="true"
                          >
                            {isSelected ? (singleSelect ? "●" : "✓") : singleSelect ? "○" : ""}
                          </span>
                          <BrandIcon provider={model.provider} size={13} className="brand-icon--inline" title={`${group.label} 官方商标`} />
                          <span className="pool-model__name">{model.name}</span>
                          {model.imageGen ? <span className="tag tag-warn">生图</span> : null}
                          {model.reasoning ? <span className="tag">推理</span> : null}
                          {model.provider === "workbuddy" && model.creditMultiplier ? (
                            <span className="tag">×{model.creditMultiplier}</span>
                          ) : null}
                          {model.contextWindow ? (
                            <span className="pool-model__ctx mono">
                              {Math.round(model.contextWindow / 1000)}k
                            </span>
                          ) : null}
                          {unavailable ? <span className="pool-model__off">不可用</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
      {selectionLabel ? <p className="model-pool__hint">{selectionLabel}</p> : null}
    </div>
  );
}

/** 已选模型的紧凑标签（并行模式顶部用）。 */
export function selectedModelLabel(model: ParticipantSpec, models: ModelOption[]): string {
  const found = models.find(
    (item) =>
      item.provider === model.provider &&
      (item.provider === "relay" ? (item.remoteId ?? item.id) === model.model : item.id === model.model) &&
      (model.relayId ? item.relayId === model.relayId : true),
  );
  return found?.name ?? model.model;
}

export function judgeBadge(isJudge: boolean) {
  return isJudge ? (
    <span className="tag tag-accent">
      <IconStar size={9} /> 裁判
    </span>
  ) : null;
}
