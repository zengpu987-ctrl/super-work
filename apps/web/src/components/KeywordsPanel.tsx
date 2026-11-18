/** 设置 → 关键词：规则表格、动作参数、测试文本与冲突提示。 */
import { useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  CustomRoleDef,
  EffortLevel,
  KeywordAction,
  KeywordMatch,
  KeywordRule,
  ParticipantSpec,
  RunMode,
} from "@super-work/core";
import { COORD_ROLES, EFFORT_LEVELS, RUN_MODE_META } from "@super-work/core";
import { sortedCustomRoles } from "../lib/v3";
import {
  KEYWORD_ACTION_LABEL,
  KEYWORD_MATCH_LABEL,
  defaultActionFor,
  defaultKeywordRule,
  keywordRuleSummary,
  testKeywordRules,
} from "../lib/v3";
import { specKey } from "../lib/types";
import {
  IconAlert,
  IconCheck,
  IconEdit,
  IconFilter,
  IconInfo,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "./Icons";

export interface KeywordsPanelProps {
  settings: AppSettings;
  customRoles: CustomRoleDef[];
  participants: ParticipantSpec[];
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}

const MATCH_OPTIONS: Array<{ value: KeywordMatch; label: string }> = [
  { value: "contains", label: "包含" },
  { value: "exact", label: "精确" },
  { value: "regex", label: "正则" },
];

const ACTION_OPTIONS: Array<{ value: KeywordAction["type"]; label: string }> = [
  { value: "mode", label: KEYWORD_ACTION_LABEL.mode },
  { value: "effort", label: KEYWORD_ACTION_LABEL.effort },
  { value: "memory", label: KEYWORD_ACTION_LABEL.memory },
  { value: "cheapMode", label: KEYWORD_ACTION_LABEL.cheapMode },
  { value: "role", label: KEYWORD_ACTION_LABEL.role },
  { value: "judge", label: KEYWORD_ACTION_LABEL.judge },
];

function participantLabel(spec: ParticipantSpec): string {
  return `${spec.provider} · ${spec.model}`;
}

function regexError(keyword: string, match: KeywordMatch): string | null {
  if (match !== "regex" || !keyword.trim()) return null;
  try {
    new RegExp(keyword, "iu");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "正则表达式无效";
  }
}

export function KeywordsPanel({ settings, customRoles, participants, onSave }: KeywordsPanelProps) {
  const [rules, setRules] = useState<KeywordRule[]>(settings.keywords ?? []);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testText, setTestText] = useState("");
  const [tested, setTested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setRules(settings.keywords ?? []);
  }, [settings.keywords]);

  const roles = useMemo(
    () => [
      ...COORD_ROLES.map((role) => ({ id: role.id as string, name: role.name })),
      ...sortedCustomRoles(customRoles).map((role) => ({ id: role.id, name: `${role.name}（自定义）` })),
    ],
    [customRoles],
  );

  const testResult = useMemo(
    () => (tested ? testKeywordRules(rules, testText, customRoles) : null),
    [customRoles, rules, testText, tested],
  );

  const duplicatePriorities = useMemo(() => {
    if (!testResult) return [] as number[];
    const counts = new Map<number, number>();
    for (const hit of testResult.matched) counts.set(hit.priority, (counts.get(hit.priority) ?? 0) + 1);
    return [...counts.entries()].filter(([, count]) => count > 1).map(([priority]) => priority);
  }, [testResult]);

  const update = (id: string, patch: Partial<KeywordRule>): void => {
    setRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
    setSavedAt(null);
  };

  const updateAction = (id: string, action: KeywordAction): void => {
    update(id, { action });
  };

  const add = (): void => {
    const rule = defaultKeywordRule();
    setRules((prev) => [...prev, rule]);
    setExpandedId(rule.id);
    setSavedAt(null);
  };

  const remove = (id: string): void => {
    setRules((prev) => prev.filter((rule) => rule.id !== id));
    if (expandedId === id) setExpandedId(null);
    setSavedAt(null);
  };

  const save = async (): Promise<void> => {
    const invalid = rules.find((rule) => !rule.keyword.trim() || regexError(rule.keyword, rule.match));
    if (invalid) {
      setExpandedId(invalid.id);
      return;
    }
    setSaving(true);
    try {
      await onSave({ keywords: rules });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-panel keywords-panel">
      <div className="settings-panel__head">
        <span className="settings-panel__icon">
          <IconFilter size={16} />
        </span>
        <div>
          <h3>关键词规则</h3>
          <p>
            命令命中后自动切换模式 / 强度 / 记忆 / 省钱模式，或指定角色与裁判。同优先级只执行优先级最高的一条，冲突时会提示。
          </p>
        </div>
      </div>

      <section className="keyword-test">
        <div className="keyword-test__head">
          <span>
            <IconSearch size={12} /> 测试文本
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setTested(true)}
            disabled={testText.trim().length === 0}
          >
            <IconCheck size={11} /> 测试规则
          </button>
        </div>
        <textarea
          className="textarea keyword-test__input"
          rows={2}
          value={testText}
          onChange={(event) => {
            setTestText(event.target.value);
            setTested(false);
          }}
          placeholder="粘贴一条命令，例如：帮我画一张产品海报，然后给出 3 个渠道方案"
        />
        {testResult ? (
          <div className="keyword-test__result">
            {testResult.matched.length === 0 ? (
              <span className="is-muted">没有命中任何规则。</span>
            ) : (
              <>
                <span className="is-accent">
                  <IconCheck size={11} /> 命中 {testResult.matched.length} 条规则
                </span>
                {testResult.effects.map((effect, index) => (
                  <span className="keyword-test__effect" key={index}>
                    {effect}
                  </span>
                ))}
                {duplicatePriorities.length > 0 ? (
                  <span className="is-warn">
                    <IconAlert size={11} /> 优先级 {duplicatePriorities.join(" / ")} 有多条命中：同优先级只执行最高优先级规则。
                  </span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </section>

      <div className="keywords-toolbar">
        <span className="keywords-toolbar__count">
          <b className="mono">{rules.length}</b> 条规则 · 启用{" "}
          <b className="mono">{rules.filter((rule) => rule.enabled).length}</b>
        </span>
        <button type="button" className="btn btn-sm" onClick={add}>
          <IconPlus size={11} /> 新增规则
        </button>
      </div>

      <div className="keywords-table-wrap">
        <table className="data-table keywords-table">
          <thead>
            <tr>
              <th aria-label="启用" />
              <th>关键词</th>
              <th>匹配方式</th>
              <th>动作与参数</th>
              <th>优先级</th>
              <th>测试</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="data-table__empty">
                  还没有关键词规则。点「新增规则」配置，例如「画图 → 生图角色」。
                </td>
              </tr>
            ) : (
              rules.map((rule) => {
                const expanded = expandedId === rule.id;
                const regexErr = regexError(rule.keyword, rule.match);
                const hit = testResult?.matched.find((item) => item.ruleId === rule.id);
                return (
                  <KeywordRow
                    key={rule.id}
                    rule={rule}
                    expanded={expanded}
                    roles={roles}
                    participants={participants}
                    customRoles={customRoles}
                    regexErr={regexErr}
                    hit={hit}
                    testRan={tested}
                    onToggle={() => update(rule.id, { enabled: !rule.enabled })}
                    onChange={(patch) => update(rule.id, patch)}
                    onAction={(action) => updateAction(rule.id, action)}
                    onExpand={() => setExpandedId(expanded ? null : rule.id)}
                    onRemove={() => remove(rule.id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="settings-panel__foot">
        <span className="settings-panel__note">
          <IconInfo size={11} /> 规则在服务端创建运行前应用；强度字段按 Low/Medium/Fast/Max/Ultra 解析。
        </span>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {savedAt ? <IconCheck size={13} /> : null}
          {saving ? "保存中…" : savedAt ? "已保存" : "保存关键词规则"}
        </button>
      </div>
    </div>
  );
}

interface KeywordRowProps {
  rule: KeywordRule;
  expanded: boolean;
  roles: Array<{ id: string; name: string }>;
  participants: ParticipantSpec[];
  customRoles: CustomRoleDef[];
  regexErr: string | null;
  hit: { priority: number } | undefined;
  testRan: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<KeywordRule>) => void;
  onAction: (action: KeywordAction) => void;
  onExpand: () => void;
  onRemove: () => void;
}

function KeywordRow({
  rule,
  expanded,
  roles,
  participants,
  customRoles,
  regexErr,
  hit,
  testRan,
  onToggle,
  onChange,
  onAction,
  onExpand,
  onRemove,
}: KeywordRowProps) {
  const action = rule.action ?? defaultActionFor("mode", participants[0]);
  const selectedKeys = new Set(
    action.type === "role" ? (action.participants ?? []).map((spec) => specKey(spec)) : [],
  );
  const judgeKey = action.type === "judge" && action.judge ? specKey(action.judge) : "";

  const toggleParticipant = (spec: ParticipantSpec, checked: boolean): void => {
    if (action.type !== "role") return;
    const list = action.participants ?? [];
    const next = checked
      ? list.some((item) => specKey(item) === specKey(spec))
        ? list
        : [...list, spec]
      : list.filter((item) => specKey(item) !== specKey(spec));
    onAction({ ...action, participants: next });
  };

  return (
    <>
      <tr className={`${expanded ? "is-expanded" : ""}${hit ? " is-hit" : ""}`}>
        <td>
          <button
            type="button"
            className={`switch switch--xs${rule.enabled ? " is-on" : ""}`}
            role="switch"
            aria-checked={rule.enabled}
            aria-label={`${rule.enabled ? "停用" : "启用"}规则 ${rule.keyword}`}
            onClick={onToggle}
          >
            <span />
          </button>
        </td>
        <td>
          <input
            className="input input--table"
            value={rule.keyword}
            onChange={(event) => onChange({ keyword: event.target.value })}
            placeholder="关键词"
            aria-label="关键词"
          />
          {rule.note ? <span className="keyword-note">{rule.note}</span> : null}
          {regexErr ? (
            <span className="keyword-error">
              <IconAlert size={9} /> {regexErr}
            </span>
          ) : null}
        </td>
        <td>
          <select
            className="select select--table"
            value={rule.match}
            onChange={(event) => onChange({ match: event.target.value as KeywordMatch })}
            aria-label="匹配方式"
          >
            {MATCH_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </td>
        <td>
          <button type="button" className="keyword-action" onClick={onExpand} title="编辑动作参数">
            <span>{keywordRuleSummary(rule, customRoles)}</span>
            <IconEdit size={11} />
          </button>
        </td>
        <td>
          <input
            className="input input--table input--num mono"
            type="number"
            value={rule.priority}
            onChange={(event) => onChange({ priority: Number(event.target.value) || 0 })}
            aria-label="优先级"
          />
        </td>
        <td>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onExpand} aria-expanded={expanded}>
            {expanded ? "收起" : "测试"}
          </button>
        </td>
        <td>
          <div className="row-actions">
            <button type="button" className="icon-btn" onClick={onExpand} aria-label="编辑规则">
              <IconEdit size={12} />
            </button>
            <button type="button" className="icon-btn is-danger" onClick={onRemove} aria-label="删除规则">
              <IconTrash size={12} />
            </button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="keyword-editor-row">
          <td colSpan={7}>
            <div className="keyword-editor">
              <div className="keyword-editor__grid">
                <label className="field">
                  <span className="field__label">动作类型</span>
                  <select
                    className="select"
                    value={action.type}
                    onChange={(event) => onAction(defaultActionFor(event.target.value as KeywordAction["type"], participants[0]))}
                  >
                    {ACTION_OPTIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                {action.type === "mode" ? (
                  <label className="field">
                    <span className="field__label">目标模式</span>
                    <select
                      className="select"
                      value={action.mode}
                      onChange={(event) => onAction({ type: "mode", mode: event.target.value as RunMode })}
                    >
                      {Object.entries(RUN_MODE_META).map(([mode, meta]) => (
                        <option key={mode} value={mode}>
                          {meta.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {action.type === "effort" ? (
                  <label className="field">
                    <span className="field__label">目标强度</span>
                    <select
                      className="select"
                      value={action.effort}
                      onChange={(event) => onAction({ type: "effort", effort: event.target.value as EffortLevel })}
                    >
                      {EFFORT_LEVELS.map((effort) => (
                        <option key={effort.id} value={effort.id}>
                          {effort.name} · {effort.description}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {action.type === "memory" || action.type === "cheapMode" ? (
                  <label className="field">
                    <span className="field__label">{action.type === "memory" ? "记忆" : "省钱模式"}</span>
                    <select
                      className="select"
                      value={action.enabled ? "on" : "off"}
                      onChange={(event) =>
                        onAction(
                          action.type === "memory"
                            ? { type: "memory", enabled: event.target.value === "on" }
                            : { type: "cheapMode", enabled: event.target.value === "on" },
                        )
                      }
                    >
                      <option value="on">开启</option>
                      <option value="off">关闭</option>
                    </select>
                  </label>
                ) : null}

                {action.type === "role" ? (
                  <label className="field">
                    <span className="field__label">目标角色</span>
                    <select
                      className="select"
                      value={action.role}
                      onChange={(event) => onAction({ ...action, role: event.target.value })}
                    >
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {action.type === "judge" ? (
                  <label className="field">
                    <span className="field__label">裁判模型</span>
                    <select
                      className="select"
                      value={judgeKey}
                      onChange={(event) => {
                        const spec = participants.find((item) => specKey(item) === event.target.value);
                        if (spec) onAction({ type: "judge", judge: { ...spec } });
                      }}
                    >
                      <option value="">选择裁判…</option>
                      {participants.map((spec) => (
                        <option key={specKey(spec)} value={specKey(spec)}>
                          {participantLabel(spec)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="field">
                  <span className="field__label">备注</span>
                  <input
                    className="input"
                    value={rule.note ?? ""}
                    maxLength={80}
                    onChange={(event) => onChange({ note: event.target.value })}
                    placeholder="可选，例如：命中后走配合模式"
                  />
                </label>
              </div>

              {action.type === "role" ? (
                <div className="keyword-editor__participants">
                  <span className="field__label">附加模型（可多选）</span>
                  {participants.length === 0 ? (
                    <p className="field__hint">还没有已选模型；先在编排里选模型，或让动作只切角色。</p>
                  ) : (
                    <div className="keyword-editor__checks">
                      {participants.map((spec) => {
                        const key = specKey(spec);
                        const checked = selectedKeys.has(key);
                        return (
                          <label className={`check-chip${checked ? " is-on" : ""}`} key={key}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => toggleParticipant(spec, event.target.checked)}
                            />
                            <span>{participantLabel(spec)}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="keyword-editor__foot">
                {testRan && !hit ? (
                  <span className="is-muted">
                    <IconX size={10} /> 当前测试文本未命中此规则
                  </span>
                ) : hit ? (
                  <span className="is-ok">
                    <IconCheck size={10} /> 命中 · 优先级 {hit.priority}
                  </span>
                ) : (
                  <span className="is-muted">修改后点上方「测试规则」验证命中。</span>
                )}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
