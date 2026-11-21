import { useCallback, useEffect, useMemo, useState } from "react";
import type { RelayAccount, RelayModel, RelayPreset } from "@super-work/core";
import { RELAY_PRESETS } from "@super-work/core";
import {
  api,
  errorMessage,
  isApiError,
  type WorkbuddyLocalDetect,
} from "../lib/api";
import { formatExpiry, formatRelative } from "../lib/format";
import {
  IconAlert,
  IconCheck,
  IconEdit,
  IconExternal,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface RelaySettingsProps {
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
  onChanged?: () => void;
}

type FormMode = "create" | "models";

interface RelayForm {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

const EMPTY_FORM: RelayForm = { presetId: "jarvis", name: "贾维斯官网", baseUrl: "", apiKey: "" };

export function RelaySettings({ pushToast, onChanged }: RelaySettingsProps) {
  const [presets, setPresets] = useState<RelayPreset[]>(RELAY_PRESETS);
  const [relays, setRelays] = useState<RelayAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiMissing, setApiMissing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<RelayForm | null>(null);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [busy, setBusy] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<{ relay: RelayAccount; models: RelayModel[] } | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [wb, setWb] = useState<WorkbuddyLocalDetect | null>(null);
  const [wbLoading, setWbLoading] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [connectFailure, setConnectFailure] = useState<{ relay?: RelayAccount; message: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const list = await api.listRelays();
        setRelays(list);
        setApiMissing(false);
        setListError(null);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          setApiMissing(true);
        } else {
          setListError(errorMessage(err));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listRelayPresets();
        if (!cancelled && list.length > 0) setPresets(list);
      } catch {
        /* 用 core 里的 RELAY_PRESETS 兜底 */
      }
    })();
    void load();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const detectWorkbuddy = useCallback(async () => {
    setWbLoading(true);
    try {
      const found = await api.detectLocalWorkbuddy();
      setWb(found);
      if (!found.found) {
        pushToast("warn", "没有检测到本机 WorkBuddy 登录态", "请先在本机登录 WorkBuddy 客户端，再回到这里检测。");
      }
    } catch (err) {
      setWb({ found: false, detail: errorMessage(err) });
      if (isApiError(err) && err.status === 404) {
        pushToast("info", "WorkBuddy 检测接口未就绪", "服务端实现 /api/relays/local/workbuddy 后可一键导入。");
      } else {
        pushToast("error", "WorkBuddy 检测失败", errorMessage(err));
      }
    } finally {
      setWbLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void detectWorkbuddy();
    // 只在首次挂载时检测
  }, [detectWorkbuddy]);

  const openPreset = (preset: RelayPreset): void => {
    if (preset.kind === "workbuddy") {
      void detectWorkbuddy();
      return;
    }
    setDiscovered(null);
    setFormMode("create");
    setForm({
      presetId: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl ?? "",
      apiKey: "",
    });
  };

  const submitDiscover = async (): Promise<void> => {
    if (!form) return;
    if (!form.baseUrl.trim()) {
      pushToast("warn", "请填写 Base URL", "通常以 /v1 结尾，例如 https://api.example.com/v1");
      return;
    }
    setBusy("discover");
    setConnectFailure(null);
    try {
      const { relay, discovered: result } = await api.createRelayAndDiscover({
        name: form.name.trim() || "中转站",
        kind: "openai-compat",
        presetId: form.presetId,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
      });
      const models = result.models ?? [];
      setDiscovered({ relay, models });
      setSelectedModelIds(new Set(models.filter((model) => model.enabled !== false).map((model) => model.id)));
      setFormMode("models");
      pushToast("success", `已连接 ${relay.name}`, `发现 ${models.length} 个模型，勾选后导入。`);
      await load(true);
    } catch (err) {
      const message = errorMessage(err);
      pushToast("error", "测试并拉取模型失败", `${message}；账号通常会保留，可重试或手动添加模型`);
      // 服务端创建失败时仍可能保留账号：重新拉一次列表，找到刚创建的站点继续操作。
      try {
        const list = await api.listRelays();
        setRelays(list);
        const baseUrl = form.baseUrl.trim();
        const name = form.name.trim() || "中转站";
        const created =
          list.find((item) => item.baseUrl === baseUrl && item.name === name) ??
          list.find((item) => item.baseUrl === baseUrl);
        setConnectFailure({ relay: created, message });
      } catch {
        setConnectFailure({ message });
      }
      await load(true);
    } finally {
      setBusy(null);
    }
  };

  const parseManualModels = (text: string): string[] => {
    const ids = text
      .split(/[\n,，;；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    return [...new Set(ids)].slice(0, 200);
  };

  const retryConnectFailure = async (): Promise<void> => {
    if (!connectFailure?.relay) return;
    setManualOpen(false);
    await refreshRelayModels(connectFailure.relay);
    setConnectFailure(null);
  };

  const saveManualModels = async (): Promise<void> => {
    if (!connectFailure?.relay) return;
    const ids = parseManualModels(manualText);
    if (ids.length === 0) {
      pushToast("warn", "至少填写一个模型 ID");
      return;
    }
    setManualBusy(true);
    try {
      await api.addRelayModels(
        connectFailure.relay.id,
        ids.map((id) => ({ id, name: id, enabled: true })),
      );
      pushToast("success", `已手动添加 ${ids.length} 个模型`, "可在模型池 / 角色编排中选择。");
      setConnectFailure(null);
      setManualOpen(false);
      setManualText("");
      setForm(null);
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "手动添加模型失败", errorMessage(err));
    } finally {
      setManualBusy(false);
    }
  };

  const importModels = async (): Promise<void> => {
    if (!discovered) return;
    const ids = [...selectedModelIds];
    if (ids.length === 0) {
      pushToast("warn", "至少勾选一个模型");
      return;
    }
    setBusy("import");
    try {
      await api.importRelayModels(discovered.relay.id, ids, discovered.models);
      pushToast("success", `已导入 ${ids.length} 个模型`, "可在参与模型池 / 角色编排中选择。");
      setDiscovered(null);
      setForm(null);
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "导入模型失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const importWorkbuddy = async (): Promise<void> => {
    setBusy("workbuddy");
    try {
      const relay = await api.importLocalWorkbuddy({ uid: wb?.uid, region: wb?.regionCode });
      pushToast("success", "已导入 WorkBuddy", `${relay.models?.length ?? 0} 个模型可用。`);
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "一键导入 WorkBuddy 失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const refreshRelayModels = async (relay: RelayAccount): Promise<void> => {
    setBusy(`refresh:${relay.id}`);
    try {
      const result = await api.discoverRelay(relay.id);
      pushToast("success", `${relay.name} 模型已刷新`, `发现 ${result.models?.length ?? 0} 个模型。`);
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "刷新模型失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const testRelayAccount = async (relay: RelayAccount): Promise<void> => {
    setBusy(`test:${relay.id}`);
    try {
      const result = await api.testRelay(relay.id);
      pushToast(result.ok ? "success" : "warn", result.ok ? "连接正常" : "连接异常", result.detail);
      await load(true);
    } catch (err) {
      pushToast("error", "测试连接失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (relay: RelayAccount): Promise<void> => {
    setBusy(`toggle:${relay.id}`);
    try {
      await api.updateRelay(relay.id, { enabled: !relay.enabled });
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "切换启停失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveRename = async (relay: RelayAccount): Promise<void> => {
    const name = renameValue.trim();
    setRenameId(null);
    if (!name || name === relay.name) return;
    try {
      await api.updateRelay(relay.id, { name });
      pushToast("success", "已改名", name);
      await load(true);
    } catch (err) {
      pushToast("error", "改名失败", errorMessage(err));
    }
  };

  const removeRelay = async (relay: RelayAccount): Promise<void> => {
    if (confirmId !== relay.id) {
      setConfirmId(relay.id);
      setTimeout(() => setConfirmId((prev) => (prev === relay.id ? null : prev)), 4000);
      return;
    }
    setConfirmId(null);
    try {
      await api.deleteRelay(relay.id);
      pushToast("success", "已删除中转站", relay.name);
      await load(true);
      onChanged?.();
    } catch (err) {
      pushToast("error", "删除失败", errorMessage(err));
    }
  };

  const presetCards = useMemo(
    () =>
      presets.map((preset) => {
        const accounts = relays.filter((relay) => relay.presetId === preset.id);
        return { preset, accounts };
      }),
    [presets, relays],
  );

  return (
    <div className="relay-settings">
      <div className="relay-head">
        <div>
          <h3>中转站与平台导入</h3>
          <p>
            贾维斯官网 / Devin / WorkBuddy 与自定义 OpenAI 兼容端点。凭证只保存在本机；导入后模型会出现在参与模型池。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void load()}
          disabled={loading}
          title="刷新中转站列表"
        >
          {loading ? <IconLoader size={12} className="spin" /> : <IconRefresh size={12} />} 刷新
        </button>
      </div>

      {apiMissing ? (
        <div className="relay-banner" role="status">
          <IconAlert size={13} />
          <span>
            中转站接口未就绪（404）。预设卡仍可查看；服务端实现 <code>/api/relays</code> 后即可导入。
          </span>
        </div>
      ) : listError ? (
        <div className="relay-banner relay-banner--error" role="alert">
          <IconAlert size={13} />
          <span>读取中转站失败：{listError}</span>
        </div>
      ) : null}

      <div className="preset-grid">
        {presetCards.map(({ preset, accounts }) => {
          const isWorkbuddy = preset.kind === "workbuddy";
          return (
            <article className={`preset-card${isWorkbuddy ? " is-workbuddy" : ""}`} key={preset.id}>
              <header className="preset-card__head">
                <h4>{preset.name}</h4>
                {accounts.length > 0 ? <span className="tag tag-ok">{accounts.length} 个已导入</span> : null}
                {preset.localDetect ? <span className="tag">本机检测</span> : null}
              </header>
              <p className="preset-card__note">{preset.note}</p>

              {isWorkbuddy ? (
                <div className="workbuddy-box">
                  {wbLoading ? (
                    <div className="workbuddy-box__row">
                      <IconLoader size={12} className="spin" /> 正在检测本机 WorkBuddy…
                    </div>
                  ) : wb?.found ? (
                    <>
                      <div className="workbuddy-box__row">
                        <span className="dot dot-ok" aria-hidden="true" />
                        <b>{wb.accountLabel ?? "WorkBuddy 账号"}</b>
                        {wb.region ? <span className="tag">{wb.region}</span> : null}
                      </div>
                      <div className="workbuddy-box__meta">
                        {wb.expiresAt ? `有效期：${formatExpiry(wb.expiresAt)}` : "有效期：未回传"}
                        {wb.models?.length ? ` · ${wb.models.length} 个模型` : ""}
                      </div>
                      {wb.detail ? <p className="workbuddy-box__detail">{wb.detail}</p> : null}
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void importWorkbuddy()}
                        disabled={busy === "workbuddy"}
                      >
                        {busy === "workbuddy" ? <IconLoader size={12} className="spin" /> : <IconCheck size={12} />}
                        一键导入
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="workbuddy-box__row">
                        <span className="dot dot-off" aria-hidden="true" />
                        <b>未检测到本机登录态</b>
                      </div>
                      <p className="workbuddy-box__detail">
                        {wb?.detail ?? "请先在本机登录 WorkBuddy 客户端，再点「重新检测」。"}
                      </p>
                      <div className="workbuddy-box__actions">
                        <button type="button" className="btn btn-sm" onClick={() => void detectWorkbuddy()} disabled={wbLoading}>
                          <IconRefresh size={12} /> 重新检测
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void importWorkbuddy()}
                          disabled={busy === "workbuddy"}
                        >
                          尝试一键导入
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button type="button" className="btn btn-sm preset-card__add" onClick={() => openPreset(preset)}>
                  <IconPlus size={12} /> 添加 / 拉取模型
                </button>
              )}
            </article>
          );
        })}
      </div>

      {connectFailure ? (
        <section className="relay-failure" role="alert" aria-label="中转站连接失败处理">
          <div className="relay-failure__head">
            <span className="relay-failure__icon" aria-hidden="true">
              <IconAlert size={14} />
            </span>
            <div className="relay-failure__body">
              <strong>拉取模型失败{connectFailure.relay ? ` · ${connectFailure.relay.name}` : ""}</strong>
              <span>{connectFailure.message}</span>
              <em>
                {connectFailure.relay
                  ? "账号已保留，可重试拉取，或手动填模型 ID 继续使用。"
                  : "未找到已创建的账号；请返回检查 Base URL / API Key 后重试。"}
              </em>
            </div>
            <button type="button" className="icon-btn" onClick={() => setConnectFailure(null)} aria-label="关闭失败提示">
              <IconX size={12} />
            </button>
          </div>
          {connectFailure.relay ? (
            <>
              <div className="relay-failure__actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void retryConnectFailure()}
                  disabled={busy === `refresh:${connectFailure.relay.id}`}
                >
                  {busy === `refresh:${connectFailure.relay.id}` ? (
                    <IconLoader size={11} className="spin" />
                  ) : (
                    <IconRefresh size={11} />
                  )}
                  重试拉取
                </button>
                <button
                  type="button"
                  className={`btn btn-sm${manualOpen ? " btn-primary" : ""}`}
                  onClick={() => setManualOpen((prev) => !prev)}
                >
                  <IconPlus size={11} /> 手动添加模型
                </button>
              </div>
              {manualOpen ? (
                <div className="relay-manual">
                  <label className="field">
                    <span className="field__label">模型 ID（每行一个，也可用逗号分隔）</span>
                    <textarea
                      className="textarea"
                      rows={4}
                      value={manualText}
                      onChange={(event) => setManualText(event.target.value)}
                      placeholder={"gpt-4.1-mini\nclaude-sonnet-5.5\ndeepseek-v4"}
                      spellCheck={false}
                    />
                  </label>
                  <div className="relay-manual__actions">
                    <span className="field__hint">
                      将写入 {connectFailure.relay.name} 的模型列表；名称默认与 ID 相同，可稍后在模型池使用。
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void saveManualModels()}
                      disabled={manualBusy || parseManualModels(manualText).length === 0}
                    >
                      {manualBusy ? <IconLoader size={11} className="spin" /> : <IconCheck size={11} />}
                      保存 {parseManualModels(manualText).length} 个模型
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {form ? (
        <section className="relay-form" aria-label="添加中转站">
          <header className="relay-form__head">
            <h4>{formMode === "create" ? `添加 ${form.name || "中转站"}` : `${discovered?.relay.name ?? ""} · 勾选导入模型`}</h4>
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                setForm(null);
                setDiscovered(null);
              }}
              aria-label="关闭添加表单"
            >
              <IconX size={13} />
            </button>
          </header>

          {formMode === "create" ? (
            <>
              <label className="field-row">
                <span>站点名称</span>
                <input
                  className="input"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="例如 贾维斯官网"
                />
              </label>
              <label className="field-row">
                <span>Base URL</span>
                <input
                  className="input"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </label>
              <label className="field-row">
                <span>API Key</span>
                <input
                  className="input"
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  placeholder="sk-…（只保存在本机）"
                  spellCheck={false}
                />
              </label>
              <div className="relay-form__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void submitDiscover()}
                  disabled={busy === "discover"}
                >
                  {busy === "discover" ? <IconLoader size={12} className="spin" /> : <IconRefresh size={12} />}
                  测试并拉取模型
                </button>
                <span className="relay-form__hint">会请求 {"{Base URL}"}/models；401 / 403 会在上方提示。</span>
              </div>
            </>
          ) : (
            <>
              {discovered && discovered.models.length === 0 ? (
                <div className="relay-banner" role="status">
                  <IconAlert size={13} /> 端点没有返回模型列表。可以检查 Base URL 是否以 /v1 结尾。
                </div>
              ) : (
                <div className="relay-model-list">
                  <div className="relay-model-list__head">
                    <span>
                      发现 <b className="mono">{discovered?.models.length ?? 0}</b> 个模型
                    </span>
                    <div>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() =>
                          setSelectedModelIds(new Set(discovered?.models.map((model) => model.id) ?? []))
                        }
                      >
                        全选
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelectedModelIds(new Set())}>
                        清空
                      </button>
                    </div>
                  </div>
                  <div className="relay-model-list__scroll">
                    {discovered?.models.map((model) => {
                      const checked = selectedModelIds.has(model.id);
                      return (
                        <button
                          type="button"
                          key={model.id}
                          className={`relay-model${checked ? " is-selected" : ""}`}
                          onClick={() =>
                            setSelectedModelIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(model.id)) next.delete(model.id);
                              else next.add(model.id);
                              return next;
                            })
                          }
                          aria-pressed={checked}
                        >
                          <span className={`pool-model__check${checked ? " is-on" : ""}`} aria-hidden="true">
                            {checked ? "✓" : ""}
                          </span>
                          <span className="relay-model__name">{model.name}</span>
                          {model.contextWindow ? (
                            <span className="mono relay-model__ctx">{Math.round(model.contextWindow / 1000)}k</span>
                          ) : null}
                          {model.imageGen ? <span className="tag tag-warn">生图</span> : null}
                          {model.supportsReasoning ? <span className="tag">推理</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="relay-form__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void importModels()}
                  disabled={busy === "import" || selectedModelIds.size === 0}
                >
                  {busy === "import" ? <IconLoader size={12} className="spin" /> : <IconCheck size={12} />}
                  导入选中的 {selectedModelIds.size} 个模型
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setFormMode("create")}>
                  返回修改连接
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      <section className="relay-list" aria-label="已导入中转站">
        <div className="relay-list__head">
          <h4>已导入站点</h4>
          <span className="mono">{relays.length}</span>
        </div>
        {relays.length === 0 ? (
          <div className="relay-empty">还没有导入任何中转站。选择上方预设卡开始。</div>
        ) : (
          relays.map((relay) => (
            <div className={`relay-account${relay.enabled ? "" : " is-off"}`} key={relay.id}>
              <div className="relay-account__main">
                <div className="relay-account__title">
                  {renameId === relay.id ? (
                    <input
                      className="input relay-account__rename"
                      value={renameValue}
                      autoFocus
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveRename(relay);
                        if (event.key === "Escape") setRenameId(null);
                      }}
                      onBlur={() => void saveRename(relay)}
                      aria-label="站点名称"
                    />
                  ) : (
                    <b>{relay.name}</b>
                  )}
                  <span className="tag">{relay.kind === "workbuddy" ? "WorkBuddy" : "OpenAI 兼容"}</span>
                  <span className={`dot ${relay.health === "ok" ? "dot-ok" : relay.health === "error" ? "dot-err" : "dot-off"}`} />
                  {relay.accountLabel ? <span className="relay-account__account">{relay.accountLabel}</span> : null}
                  {!relay.enabled ? <span className="tag tag-warn">已停用</span> : null}
                </div>
                <div className="relay-account__meta">
                  <span className="mono">{relay.baseUrl || "本机导入"}</span>
                  <span>·</span>
                  <span>{relay.hasKey ? "已配置 Key" : "无 Key"}</span>
                  <span>·</span>
                  <span>{relay.models?.length ?? 0} 个模型</span>
                  {relay.credits?.balance != null ? (
                    <>
                      <span>·</span>
                      <span>余额 {relay.credits.balance}</span>
                    </>
                  ) : null}
                  {relay.discoveredAt ? (
                    <>
                      <span>·</span>
                      <span>{formatRelative(relay.discoveredAt)}刷新</span>
                    </>
                  ) : null}
                  {relay.detail ? <span className="relay-account__detail">{relay.detail}</span> : null}
                </div>
              </div>
              <div className="relay-account__actions">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => {
                    setRenameId(relay.id);
                    setRenameValue(relay.name);
                  }}
                  title="改名"
                  aria-label={`改名 ${relay.name}`}
                >
                  <IconEdit size={13} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void refreshRelayModels(relay)}
                  disabled={busy === `refresh:${relay.id}`}
                  title="刷新模型"
                  aria-label={`刷新 ${relay.name} 模型`}
                >
                  {busy === `refresh:${relay.id}` ? (
                    <IconLoader size={13} className="spin" />
                  ) : (
                    <IconRefresh size={13} />
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void testRelayAccount(relay)}
                  disabled={busy === `test:${relay.id}`}
                >
                  {busy === `test:${relay.id}` ? <IconLoader size={11} className="spin" /> : <IconExternal size={11} />}
                  测试
                </button>
                <PaddleSwitch
                  checked={relay.enabled}
                  onChange={() => void toggleEnabled(relay)}
                  disabled={busy === `toggle:${relay.id}`}
                  ariaLabel={`${relay.name}${relay.enabled ? "停用" : "启用"}`}
                  title={relay.enabled ? "停用（模型从池中移除可用性）" : "启用"}
                />
                <button
                  type="button"
                  className={`icon-btn${confirmId === relay.id ? " is-danger" : ""}`}
                  onClick={() => void removeRelay(relay)}
                  title={confirmId === relay.id ? "再点一次确认删除" : "删除"}
                  aria-label={`删除 ${relay.name}`}
                >
                  {confirmId === relay.id ? <IconTrash size={13} /> : <IconX size={13} />}
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
