/** 自定义角色新增/编辑抽屉（420px）：名称 2-12 字、职责 ≤200、是否生图、模型多选。 */
import { useEffect, useMemo, useState } from "react";
import type { CustomRoleDef, EffortLevel, ModelOption, ParticipantSpec } from "@super-work/core";
import type { PoolGroup } from "./ModelPool";
import { ModelPool, selectedModelLabel } from "./ModelPool";
import { EffortSelector } from "./EffortSelector";
import {
  ROLE_DESC_MAX,
  ROLE_NAME_MAX,
  ROLE_NAME_MIN,
  checkRoleName,
  type RoleNameCheck,
} from "../lib/v3";
import { specKey } from "../lib/types";
import { IconAlert, IconCheck, IconImage, IconX } from "./Icons";

export interface CustomRoleDraft {
  name: string;
  description: string;
  kind: "text" | "image";
  models: ParticipantSpec[];
}

export interface CustomRoleDrawerProps {
  open: boolean;
  mode: "create" | "edit";
  role?: CustomRoleDef;
  roles: CustomRoleDef[];
  groups: PoolGroup[];
  initialModels: ParticipantSpec[];
  models: ModelOption[];
  running: boolean;
  onClose: () => void;
  onSave: (draft: CustomRoleDraft) => RoleNameCheck;
}

export function CustomRoleDrawer({
  open,
  mode,
  role,
  roles,
  groups,
  initialModels,
  models,
  running,
  onClose,
  onSave,
}: CustomRoleDrawerProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"text" | "image">("text");
  const [selected, setSelected] = useState<ParticipantSpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? "");
    setDescription(role?.description ?? "");
    setKind(role?.kind ?? "text");
    setSelected(initialModels.map((spec) => ({ ...spec, effort: spec.effort ?? "medium" })));
    setError(null);
    setSaved(false);
  }, [open, role?.id, role?.name, role?.description, role?.kind]);

  const nameCheck = useMemo(
    () => checkRoleName(name, roles, role?.id),
    [name, role?.id, roles],
  );
  const descTooLong = description.length > ROLE_DESC_MAX;
  const valid = nameCheck.ok && !descTooLong;

  if (!open) return null;

  const toggleModel = (spec: ParticipantSpec): void => {
    const key = specKey(spec);
    setSelected((prev) =>
      prev.some((item) => specKey(item) === key)
        ? prev.filter((item) => specKey(item) !== key)
        : [...prev, { ...spec, effort: spec.effort ?? "medium" }],
    );
  };

  const setEffort = (key: string, effort: EffortLevel): void => {
    setSelected((prev) => prev.map((spec) => (specKey(spec) === key ? { ...spec, effort } : spec)));
  };

  const submit = (): void => {
    if (!valid) return;
    const result = onSave({
      name: name.trim(),
      description: description.trim(),
      kind,
      models: selected.map((spec) => ({ ...spec, effort: spec.effort ?? "medium" })),
    });
    if (!result.ok) {
      setError(result.message ?? "保存失败");
      return;
    }
    setSaved(true);
    window.setTimeout(onClose, 180);
  };

  return (
    <div className="role-drawer-layer" role="presentation">
      <button type="button" className="role-drawer__backdrop" aria-label="关闭角色抽屉" onClick={onClose} />
      <aside
        className="role-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="role-drawer-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header className="role-drawer__head">
          <div>
            <h3 className="role-drawer__title" id="role-drawer-title">
              {mode === "create" ? "新建自定义角色" : "编辑自定义角色"}
            </h3>
            <p className="role-drawer__sub">
              内置 8 槽固定 · 自定义角色随配合提交 · 未选模型不会产生调用
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={15} />
          </button>
        </header>

        <div className="role-drawer__body">
          <div className="role-field">
            <label className="role-field__label" htmlFor="role-name">
              角色名称 <span className="role-field__req">必填</span>
            </label>
            <div className={`role-field__input${name.length > 0 && !nameCheck.ok ? " is-invalid" : ""}`}>
              <input
                id="role-name"
                className="input"
                value={name}
                maxLength={ROLE_NAME_MAX}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                placeholder="例如：安全审计"
                autoFocus
                spellCheck={false}
              />
              <span className={`role-field__count mono${name.length < ROLE_NAME_MIN ? " is-warn" : ""}`}>
                {name.length}/{ROLE_NAME_MAX}
              </span>
            </div>
            {name.length > 0 && !nameCheck.ok ? (
              <p className="role-field__error">
                <IconAlert size={10} /> {nameCheck.message}
              </p>
            ) : (
              <p className="role-field__hint">名称 {ROLE_NAME_MIN}–{ROLE_NAME_MAX} 字，不可与内置或已有角色重名</p>
            )}
          </div>

          <div className="role-field">
            <label className="role-field__label" htmlFor="role-desc">
              职责说明 <span className="role-field__opt">可选</span>
            </label>
            <textarea
              id="role-desc"
              className="textarea"
              value={description}
              maxLength={ROLE_DESC_MAX + 20}
              rows={4}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="这个角色负责什么、产出什么、验收标准是什么…（≤200 字）"
            />
            <div className={`role-field__meta${descTooLong ? " is-invalid" : ""}`}>
              <span className="role-field__hint">会作为 system 角色说明注入；留空则用名称兜底</span>
              <span className="mono">
                {description.length}/{ROLE_DESC_MAX}
              </span>
            </div>
          </div>

          <div className="role-field">
            <span className="role-field__label">产出类型</span>
            <div className="role-kind" role="radiogroup" aria-label="产出类型">
              <button
                type="button"
                role="radio"
                aria-checked={kind === "text"}
                className={`role-kind__item${kind === "text" ? " is-active" : ""}`}
                onClick={() => setKind("text")}
              >
                <span className="role-kind__title">文本角色</span>
                <span className="role-kind__hint">在 specialist 阶段并行产出文本 / 代码</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={kind === "image"}
                className={`role-kind__item${kind === "image" ? " is-active" : ""}`}
                onClick={() => setKind("image")}
              >
                <span className="role-kind__title">
                  <IconImage size={12} /> 生图角色
                </span>
                <span className="role-kind__hint">直接调用图像模型，产出图片产物</span>
              </button>
            </div>
          </div>

          <div className="role-field">
            <span className="role-field__label">
              模型多选 <span className="role-field__opt">未选 = 空槽 0 调用</span>
            </span>
            {selected.length > 0 ? (
              <div className="role-models">
                {selected.map((spec) => {
                  const key = specKey(spec);
                  return (
                    <div className="role-models__row" key={key}>
                      <span className="role-models__name" title={spec.model}>
                        {selectedModelLabel(spec, models)}
                        <em>{spec.provider}</em>
                      </span>
                      <EffortSelector
                        size="sm"
                        value={spec.effort}
                        onChange={(effort) => setEffort(key, effort)}
                        disabled={running}
                        ariaLabel={`${spec.model} 强度`}
                      />
                      <button
                        type="button"
                        className="role-models__remove"
                        onClick={() => toggleModel(spec)}
                        aria-label={`移除 ${spec.model}`}
                      >
                        <IconX size={10} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="role-field__hint">还没有选择模型；保存后该角色为空槽，显示「未配置 · 不会调用」。</p>
            )}
            <div className="role-models__pool">
              <ModelPool
                groups={groups}
                selected={new Set(selected.map(specKey))}
                onToggle={toggleModel}
                disabled={running}
                selectionLabel="点击模型多选；每个模型的强度档位会在运行中生效。"
              />
            </div>
          </div>

          {error ? (
            <div className="form-status is-error" role="alert">
              <IconAlert size={12} /> <span>{error}</span>
            </div>
          ) : null}
        </div>

        <footer className="role-drawer__foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!valid || running || saved}>
            {saved ? <IconCheck size={13} /> : null}
            {saved ? "已保存" : mode === "create" ? "创建角色" : "保存修改"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
