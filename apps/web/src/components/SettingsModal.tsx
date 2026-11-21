import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AppSettings,
  ConnectionStatus,
  CustomRoleDef,
  ParticipantSpec,
  ProviderId,
  ProviderStatus,
} from "@super-work/core";
import type { BudgetUsageView, ConnectionResult } from "../lib/api";
import { api, errorMessage, isApiError } from "../lib/api";
import { formatExpiry, formatRelative } from "../lib/format";
import { brandStyle } from "../lib/brand";
import type { SettingsSection } from "../lib/types";
import { AuthPanel } from "./AuthPanel";
import { BudgetPanel } from "./BudgetPanel";
import { BrandIcon } from "./BrandIcon";
import { KeywordsPanel } from "./KeywordsPanel";
import { PerformancePanel } from "./PerformancePanel";
import { PluginsPanel } from "./PluginsPanel";
import { RelaySettings } from "./RelaySettings";
import { ProviderRow } from "./ProviderRow";
import {
  IconAlert,
  IconCheck,
  IconInfo,
  IconExternal,
  IconKey,
  IconWallet,
  IconLoader,
  IconPlug,
  IconRefresh,
  IconShield,
  IconSpark,
  IconTerminal,
  IconTrash,
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

export type SettingsTab = "key" | "subscription" | "local" | "token";

export interface SettingsModalProps {
  providers: ProviderStatus[];
  initialProviderId: ProviderId | null;
  initialSection?: SettingsSection;
  settings: AppSettings;
  offline: boolean;
  budgetUsage: BudgetUsageView | null;
  budgetLoading: boolean;
  participants: ParticipantSpec[];
  customRoles: CustomRoleDef[];
  onClose: () => void;
  onRefreshProviders: () => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onRefreshBudget: () => Promise<void>;
  onSaved: (next: AppSettings) => Promise<void>;
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

const SECTION_LABEL: Record<SettingsSection, string> = {
  providers: "模型连接",
  relay: "中转站",
  budget: "预算",
  plugins: "插件",
  performance: "性能",
  keywords: "关键词",
};

const SECTION_ORDER: SettingsSection[] = [
  "providers",
  "relay",
  "budget",
  "plugins",
  "performance",
  "keywords",
];

const TAB_LABEL: Record<SettingsTab, string> = {
  key: "API Key",
  subscription: "订阅登录",
  local: "本机复用",
  token: "粘贴凭证",
};

const MODE_LABEL: Record<string, string> = {
  "api-key": "API Key",
  "oauth-browser": "OAuth 登录",
  "device-code": "设备码",
  token: "粘贴凭证",
  local: "本机复用",
};

const SOURCE_LABEL: Record<string, string> = {
  user: "本站录入",
  local: "本机复用",
  env: "环境变量",
};

export function SettingsModal({
  providers,
  initialProviderId,
  initialSection = "providers",
  settings,
  offline,
  budgetUsage,
  budgetLoading,
  participants,
  customRoles,
  onClose,
  onRefreshProviders,
  onRefreshModels,
  onRefreshBudget,
  onSaved,
  pushToast,
}: SettingsModalProps) {
  const initialProvider = (() => {
    if (initialProviderId) {
      const found = providers.find((provider) => provider.id === initialProviderId);
      if (found) return found;
    }
    const connected = providers.find((provider) => provider.connected);
    return connected ?? providers.find((provider) => provider.id !== "mock") ?? providers[0];
  })();

  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [activeId, setActiveId] = useState<ProviderId>(initialProvider?.id ?? "deepseek");
  const [pendingLink, setPendingLink] = useState<{ url: string; host: string } | null>(null);
  const [tab, setTab] = useState<SettingsTab>("key");
  const [proxyValue, setProxyValue] = useState(settings.proxy ?? "");
  const [language, setLanguage] = useState<"zh" | "en">(settings.language);
  const [allowLocalReuse, setAllowLocalReuse] = useState(settings.allowLocalReuse);
  const [detect, setDetect] = useState<{ kind: "idle" | "loading" | "ok" | "error"; message?: string }>({
    kind: "idle",
  });
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const active = providers.find((provider) => provider.id === activeId) ?? initialProvider ?? providers[0];

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const persistPatch = useCallback(
    async (patch: Partial<AppSettings>) => {
      await onSaved({ ...settings, ...patch });
    },
    [onSaved, settings],
  );

  useEffect(() => {
    // 聚焦对话框容器本身，避免一打开就出现醒目的按钮 focus ring。
    dialogRef.current?.focus();
    void onRefreshProviders();
    void onRefreshModels();
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [onRefreshModels, onRefreshProviders]);

  // Esc 关闭 + Tab 焦点圈定
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handle, true);
    return () => document.removeEventListener("keydown", handle, true);
  }, [onClose]);

  const refresh = useCallback(async () => {
    await onRefreshProviders();
    setRefreshKey((prev) => prev + 1);
  }, [onRefreshProviders]);

  const handleDetectProxy = useCallback(async () => {
    setDetect({ kind: "loading" });
    try {
      const res = await api.detectProxy();
      const found = res.proxy ?? res.candidates?.[0];
      if (found) {
        setProxyValue(found);
        setDetect({ kind: "ok", message: `检测到系统代理：${found}` });
      } else {
        setDetect({
          kind: "error",
          message: "未检测到系统代理。若本机使用 Hiddify / Clash 等，请手动填写，例如 127.0.0.1:12334。",
        });
      }
    } catch (err) {
      if (isApiError(err) && (err.status === 404 || err.code === "http_404")) {
        setDetect({
          kind: "error",
          message: "当前服务端未提供代理检测接口，请手动填写代理地址（例如 127.0.0.1:12334），再点保存。",
        });
      } else {
        setDetect({ kind: "error", message: `检测失败：${errorMessage(err)}` });
      }
    }
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSaved({
        ...settings,
        proxy: proxyValue.trim() || undefined,
        language,
        allowLocalReuse,
      });
    } finally {
      setSaving(false);
    }
  }, [allowLocalReuse, language, onSaved, proxyValue, settings]);

  const requestDelete = useCallback(
    async (connection: ConnectionStatus) => {
      if (confirmId !== connection.id) {
        setConfirmId(connection.id);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmId(null), 4000);
        return;
      }
      setConfirmId(null);
      try {
        await api.deleteConnection(connection.provider, connection.id);
        pushToast("success", `已删除连接 ${connection.label}`);
        await refresh();
      } catch (err) {
        pushToast("error", "删除连接失败", errorMessage(err));
      }
    },
    [confirmId, pushToast, refresh],
  );

  if (!active && section === "providers") return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={(node) => {
          containerRef.current = node;
          dialogRef.current = node;
        }}
        tabIndex={-1}
      >
        <header className="modal__head">
          <div className="modal__title-group">
            <h2 className="modal__title" id="settings-title">
              <IconShield size={16} /> 模型连接与设置
            </h2>
            <p className="modal__subtitle">
              11 家 provider + 演示模型 · 凭证仅保存在本机（~/.super-work，AES-256-GCM 加密）
              {offline ? " · 当前服务离线，配置会在恢复后生效" : ""}
            </p>
          </div>
          <div className="modal__head-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => void refresh()}
              aria-label="刷新 provider 状态"
              title="刷新 provider 状态"
            >
              <IconRefresh size={15} />
            </button>
            <button
              ref={closeRef}
              type="button"
              className="icon-btn"
              onClick={onClose}
              aria-label="关闭设置"
            >
              <IconX size={16} />
            </button>
          </div>
        </header>

        <div className="settings-section-tabs" role="tablist" aria-label="设置分区">
          {SECTION_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`settings-section-${item}`}
              aria-selected={section === item}
              className={`settings-section-tab${section === item ? " is-active" : ""}`}
              onClick={() => setSection(item)}
            >
              {SECTION_LABEL[item]}
            </button>
          ))}
        </div>

        <div className={`modal__body${section === "providers" ? "" : " is-wide"}`}>
          {section === "providers" ? (
            <nav className="provider-list" aria-label="Provider 列表">
              <div className="provider-list__head">Providers</div>
              <div className="provider-list__scroll">
                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    id={provider.id}
                    name={provider.name}
                    short={provider.short}
                    color={provider.color}
                    connected={provider.connected}
                    connectionCount={provider.connections.length}
                    selected={provider.id === activeId}
                    onClick={() => {
                      setActiveId(provider.id);
                      setTab("key");
                    }}
                    ariaLabel={`${provider.name}，${provider.connected ? "已连接" : "未连接"}`}
                  />
                ))}
              </div>
              <div className="provider-list__foot">
                {providers.filter((provider) => provider.connected).length} / {providers.length} 已连接
                {" · "}
                演示模型无需凭证
              </div>
            </nav>
          ) : null}

          {section === "providers" ? (
          <section className="settings-pane" aria-label={`${active.name} 设置`}>
            <div className="settings-pane__head" style={brandStyle(active.color) as unknown as CSSProperties}>
              <BrandIcon provider={active.id} size={32} title={`${active.name} 官方商标`} />
              <div className="settings-pane__titles">
                <h3 className="settings-pane__name">
                  {active.name}
                  {active.connected ? <span className="tag tag-ok">已连接</span> : null}
                  <span className="tag">{active.kind}</span>
                </h3>
                <p className="settings-pane__meta">
                  auth: {active.authModes.length > 0 ? active.authModes.join(" / ") : "none"}
                  {active.note ? ` · ${active.note}` : ""}
                </p>
              </div>
              <span className="settings-pane__status">
                <span className={`dot ${active.connected ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
                {active.connected ? `${active.connections.length} 个连接` : "未连接"}
              </span>
            </div>

            <div className="settings-tabs" role="tablist" aria-label="凭证方式">
              {(Object.keys(TAB_LABEL) as SettingsTab[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item}`}
                  aria-selected={tab === item}
                  aria-controls="settings-tabpanel"
                  className={`settings-tab${tab === item ? " is-active" : ""}`}
                  onClick={() => setTab(item)}
                >
                  {TAB_LABEL[item]}
                  {item === "local" && (active.localAccounts?.length ?? 0) > 0 ? (
                    <span className="settings-tab__badge">{active.localAccounts?.length}</span>
                  ) : null}
                </button>
              ))}
            </div>

            <div
              className="settings-pane__scroll"
              id="settings-tabpanel"
              role="tabpanel"
              aria-labelledby={`settings-tab-${tab}`}
              key={`${active.id}-${tab}-${refreshKey}`}
            >
              {active.connections.length > 0 ? (
                <div className="settings-section">
                  <div className="settings-section__title">
                    <IconPlug size={12} /> 已有连接
                    <span className="right">{active.connections.length} 条</span>
                  </div>
                  <div className="conn-list">
                    {active.connections.map((connection) => (
                      <div className="conn-item" key={connection.id}>
                        <span
                          className={`conn-item__dot ${connection.healthy ? "is-ok" : "is-warn"}`}
                          aria-hidden="true"
                        />
                        <div className="conn-item__main">
                          <span className="conn-item__label">{connection.label}</span>
                          <span className="conn-item__meta">
                            {MODE_LABEL[connection.mode] ?? connection.mode}
                            <span className="sep">·</span>
                            {SOURCE_LABEL[connection.source] ?? connection.source}
                            {connection.expiresAt ? (
                              <>
                                <span className="sep">·</span>
                                {formatExpiry(connection.expiresAt)}
                              </>
                            ) : null}
                            {connection.modelCount != null ? (
                              <>
                                <span className="sep">·</span>
                                {connection.modelCount} 个模型
                              </>
                            ) : null}
                            {!connection.healthy && connection.detail ? (
                              <>
                                <span className="sep">·</span>
                                {connection.detail}
                              </>
                            ) : null}
                          </span>
                        </div>
                        <div className="conn-item__actions">
                          {confirmId === connection.id ? (
                            <span className="conn-confirm">
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => void requestDelete(connection)}
                              >
                                确认删除
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => void requestDelete(connection)}
                              aria-label={`删除连接 ${connection.label}`}
                              title="删除连接"
                            >
                              <IconTrash size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {tab === "key" ? (
                <ApiKeyForm
                  provider={active}
                  pushToast={pushToast}
                  onConnected={refresh}
                />
              ) : null}
              {tab === "subscription" ? (
                <AuthPanel
                  kind="subscription"
                  provider={active}
                  onConnected={() => void refresh()}
                  pushToast={pushToast}
                  onGoToTab={setTab}
                />
              ) : null}
              {tab === "local" ? (
                <LocalReusePanel
                  provider={active}
                  allowLocalReuse={allowLocalReuse}
                  onToggleLocalReuse={setAllowLocalReuse}
                  pushToast={pushToast}
                  onImported={refresh}
                  onSaved={handleSave}
                  saving={saving}
                />
              ) : null}
              {tab === "token" ? (
                <AuthPanel
                  kind="token"
                  provider={active}
                  onConnected={() => void refresh()}
                  pushToast={pushToast}
                  onGoToTab={setTab}
                />
              ) : null}
            </div>
            {active.purchase ? (
              <div className="purchase-card" aria-label="官方购买与充值入口">
                <div className="purchase-card__head">
                  <IconWallet size={12} />
                  官方购买 / 充值
                  <span className="purchase-card__note">费用均由对应服务方收取，Super Work 不代收任何款项</span>
                </div>
                <div className="purchase-card__groups">
                  {active.purchase.apiKeyUrl ? (
                    <div className="purchase-group">
                      <span className="purchase-group__label">
                        API <em>按量计费</em>
                      </span>
                      <div className="purchase-group__actions">
                        <button
                          type="button"
                          className="purchase-btn"
                          onClick={() => {
                            const url = active.purchase?.apiKeyUrl;
                            if (url) setPendingLink({ url, host: safeHost(url) });
                          }}
                        >
                          <IconKey size={11} /> 获取 API Key <IconExternal size={10} />
                        </button>
                        {active.purchase.billingUrl ? (
                          <button
                            type="button"
                            className="purchase-btn"
                            onClick={() => {
                              const url = active.purchase?.billingUrl;
                              if (url) setPendingLink({ url, host: safeHost(url) });
                            }}
                          >
                            <IconWallet size={11} /> 充值
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {active.purchase.subscriptionUrl ? (
                    <div className="purchase-group">
                      <span className="purchase-group__label">
                        订阅 <em>周期与额度以官方为准</em>
                      </span>
                      <div className="purchase-group__actions">
                        <button
                          type="button"
                          className="purchase-btn"
                          onClick={() => {
                            const url = active.purchase?.subscriptionUrl;
                            if (url) setPendingLink({ url, host: safeHost(url) });
                          }}
                        >
                          <IconSpark size={11} /> 购买订阅 <IconExternal size={10} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                {active.purchase.subscriptionNote ? (
                  <p className="purchase-card__tip">{active.purchase.subscriptionNote}</p>
                ) : null}
                {pendingLink ? (
                  <div className="purchase-confirm" role="status">
                    <span>
                      即将前往第三方网站 <b>{pendingLink.host}</b>
                    </span>
                    <button
                      type="button"
                      className="purchase-btn"
                      onClick={() => {
                        window.open(pendingLink.url, "_blank", "noopener,noreferrer");
                        setPendingLink(null);
                      }}
                    >
                      继续前往
                    </button>
                    <button type="button" className="purchase-btn is-ghost" onClick={() => setPendingLink(null)}>
                      取消
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

          </section>
          ) : section === "relay" ? (
            <section className="settings-pane settings-pane--relay" aria-label="中转站设置">
              <div className="settings-pane__scroll">
                <RelaySettings pushToast={pushToast} onChanged={() => void refresh()} />
              </div>
            </section>
          ) : section === "budget" ? (
            <section className="settings-pane settings-pane--wide" aria-label="预算设置">
              <div className="settings-pane__scroll">
                <BudgetPanel
                  settings={settings}
                  usage={budgetUsage}
                  loading={budgetLoading}
                  onSave={async (patch) => {
                    await persistPatch(patch);
                    await onRefreshBudget();
                  }}
                />
              </div>
            </section>
          ) : section === "plugins" ? (
            <section className="settings-pane settings-pane--wide" aria-label="插件中心">
              <div className="settings-pane__scroll">
                <PluginsPanel pushToast={pushToast} />
              </div>
            </section>
          ) : section === "performance" ? (
            <section className="settings-pane settings-pane--wide" aria-label="性能设置">
              <div className="settings-pane__scroll">
                <PerformancePanel settings={settings} onSave={persistPatch} />
              </div>
            </section>
          ) : (
            <section className="settings-pane settings-pane--wide" aria-label="关键词规则">
              <div className="settings-pane__scroll">
                <KeywordsPanel
                  settings={settings}
                  customRoles={customRoles}
                  participants={participants}
                  onSave={persistPatch}
                />
              </div>
            </section>
          )}
        </div>

        <footer className="modal__foot">
          {section === "providers" ? (
            <>
            <div className="proxy-group">
              <span className="proxy-group__label">系统代理</span>
              <input
                className="input"
                value={proxyValue}
                onChange={(event) => setProxyValue(event.target.value)}
                placeholder="留空 = 直连；例如 127.0.0.1:12334"
                spellCheck={false}
                aria-label="系统代理地址"
              />
              <button
                type="button"
                className="btn"
                onClick={() => void handleDetectProxy()}
                disabled={detect.kind === "loading"}
              >
                {detect.kind === "loading" ? (
                  <IconLoader size={12} className="spin" />
                ) : (
                  <IconRefresh size={12} />
                )}
                检测系统代理
              </button>
            </div>

            <div className="lang-switch" role="group" aria-label="输出语言">
              <button
                type="button"
                className={language === "zh" ? "is-active" : ""}
                onClick={() => setLanguage("zh")}
                aria-pressed={language === "zh"}
                title="模型以中文作答"
              >
                中文
              </button>
              <button
                type="button"
                className={language === "en" ? "is-active" : ""}
                onClick={() => setLanguage("en")}
                aria-pressed={language === "en"}
                title="模型以英文作答"
              >
                English
              </button>
            </div>

          <div className="modal__foot-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              完成
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <IconLoader size={13} className="spin" /> : <IconCheck size={13} />}
              {saving ? "保存中…" : "保存设置"}
            </button>
          </div>

            {detect.kind !== "idle" && detect.message ? (
              <div
                className="proxy-hint"
                style={{ flexBasis: "100%", color: detect.kind === "ok" ? "#9ff0c8" : undefined }}
                role="status"
              >
                {detect.kind === "ok" ? <IconCheck size={11} /> : <IconInfo size={11} />} {detect.message}
              </div>
            ) : null}


            </>
          ) : (
            <>
              <span className="modal__foot-note">
                {section === "relay"
                  ? "中转站凭证只保存在本机；请在该面板内保存。"
                  : "该面板的修改会立即写入本机设置；「完成」即可关闭。"}
              </span>
              <div className="modal__foot-actions">
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  <IconCheck size={13} /> 完成
                </button>
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- API Key */

interface ApiKeyFormProps {
  provider: ProviderStatus;
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
  onConnected: () => Promise<void> | void;
}

function ApiKeyForm({ provider, pushToast, onConnected }: ApiKeyFormProps) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [skipValidation, setSkipValidation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectionResult | null>(null);

  useEffect(() => {
    setApiKey("");
    setBaseUrl("");
    setLabel("");
    setError(null);
    setResult(null);
    setShowKey(false);
    setSkipValidation(false);
  }, [provider.id]);

  const baseUrlRequired = provider.id === "thirdparty";
  const isVolcengine = provider.id === "volcengine";

  const submit = async (): Promise<void> => {
    setError(null);
    setResult(null);
    if (apiKey.trim().length === 0) {
      setError("请填写 API Key");
      return;
    }
    if (baseUrlRequired && baseUrl.trim().length === 0) {
      setError("第三方 / 自建端点必须填写 baseUrl");
      return;
    }
    setSubmitting(true);
    try {
      const connection = await api.connectProvider(provider.id, {
        mode: "api-key",
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        label: label.trim() || undefined,
        ...(skipValidation ? { skipValidation: true } : {}),
      });
      setResult(connection);
      if (connection.healthy) {
        pushToast("success", `${provider.name} 已连接`, connection.warning);
      } else {
        pushToast(
          "warn",
          `${provider.name} 凭证已保存，但校验未通过`,
          connection.warning ?? connection.detail,
        );
      }
      setApiKey("");
      await onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (provider.id === "mock") {
    return (
      <div className="empty-panel">
        <strong>演示模型无需 API Key</strong>
        <span>mock 模型完全本地运行，用来验证界面与联合工作流程。</span>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="settings-section__title">
        <IconKey size={12} /> API Key
        <span className="right">官方 API 凭证</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="api-key-input">
          API Key <span className="req">必填</span>
        </label>
        <div className="field-with-action">
          <input
            id="api-key-input"
            className="input"
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={isVolcengine ? "方舟 API Key（模型名可填 ep-xxx 接入点 ID）" : "粘贴 provider 控制台生成的 API Key"}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn"
            onClick={() => setShowKey((prev) => !prev)}
            aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
          >
            {showKey ? "隐藏" : "显示"}
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="api-key-base">
          自定义 baseUrl {baseUrlRequired ? <span className="req">必填</span> : <span className="opt">可选</span>}
        </label>
        <input
          id="api-key-base"
          className="input"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="留空使用 provider 默认端点；自建网关请填写完整地址"
          spellCheck={false}
        />
        <span className="field__hint">
          {isVolcengine ? (
            <>
              火山方舟：baseUrl 一般无需修改，<strong>模型名</strong>可填推理接入点 ID（ep-xxx），在右侧“手动添加模型 ID”里添加。
            </>
          ) : baseUrlRequired ? (
            <>第三方 / 自建端点（OpenRouter、硅基流动、Ollama、one-api 网关等）必须填写 baseUrl。</>
          ) : (
            <>仅当使用代理、镜像或自建网关时填写；走官方端点请留空。</>
          )}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="api-key-label">
          标签 <span className="opt">可选</span>
        </label>
        <input
          id="api-key-label"
          className="input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="例如：工作账号 / 个人账号"
          maxLength={60}
        />
      </div>

      <div
        className={`check-row${skipValidation ? " is-on" : ""}`}
        onClick={() => setSkipValidation((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSkipValidation((prev) => !prev);
          }
        }}
      >
        <PaddleSwitch checked={skipValidation} onChange={(next) => setSkipValidation(next)} ariaLabel="跳过网络校验" />
        <span>
          <strong>跳过网络校验，直接保存凭证</strong>
          <em>上游未提供 /models 或网络受限时使用；保存后不再自动探测模型，可在模型池手动添加。</em>
        </span>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={submitting || apiKey.trim().length === 0}
        >
          {submitting ? <IconLoader size={13} className="spin" /> : <IconCheck size={13} />}
          {submitting
            ? skipValidation
              ? "正在保存…"
              : "连接并校验…"
            : skipValidation
              ? "直接保存"
              : "连接并校验"}
        </button>
        <span className="field__hint">
          {skipValidation
            ? "只保存凭证，不请求上游；导入校验失败的问题可通过此选项绕过。"
            : "保存后会立即调用 provider 接口校验凭证并探测可用模型。"}
        </span>
      </div>

      {error ? (
        <div className="form-status is-error" role="alert">
          <IconAlert size={12} /> <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <div className={`form-status ${result.healthy ? "is-ok" : "is-error"}`} role="status">
          {result.healthy ? <IconCheck size={12} /> : <IconAlert size={12} />}
          <span>
            连接 {result.healthy ? "可用" : "未通过校验"}
            {result.label ? ` · ${result.label}` : ""}
            {result.modelCount != null ? ` · ${result.modelCount} 个模型` : ""}
            {result.detail ? ` · ${result.detail}` : ""}
            {result.accountLabel ? ` · ${result.accountLabel}` : ""}
          </span>
        </div>
      ) : null}

      {result?.warning ? (
        <div className="form-status" role="status">
          <IconInfo size={12} /> <span>{result.warning}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 本机复用 */

interface LocalReusePanelProps {
  provider: ProviderStatus;
  allowLocalReuse: boolean;
  onToggleLocalReuse: (value: boolean) => void;
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
  onImported: () => Promise<void>;
  onSaved: () => Promise<void>;
  saving: boolean;
}

function LocalReusePanel({
  provider,
  allowLocalReuse,
  onToggleLocalReuse,
  pushToast,
  onImported,
  onSaved,
  saving,
}: LocalReusePanelProps) {
  const [importingId, setImportingId] = useState<string | null>(null);
  const accounts = provider.localAccounts ?? [];

  const importAccount = async (id: string): Promise<void> => {
    setImportingId(id);
    try {
      const connection = await api.importLocalAccount(provider.id, { localAccountId: id });
      pushToast(
        connection.healthy ? "success" : "warn",
        connection.healthy ? `已导入 ${connection.label || id}` : `已导入 ${connection.label || id}，但校验未通过`,
        connection.warning ?? connection.detail,
      );
      await onImported();
    } catch (err) {
      pushToast("error", "导入本机凭证失败", errorMessage(err));
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="settings-section">
      <div className="settings-section__title">
        <IconTerminal size={12} /> 本机复用
        <span className="right">只读，不修改原文件</span>
      </div>

      <div className="switch-row">
        <PaddleSwitch
          checked={allowLocalReuse}
          onChange={(next) => onToggleLocalReuse(next)}
          ariaLabel="允许读取本机 DSH 凭证"
        />
        <div className="switch-row__main">
          <div className="switch-row__title">允许读取本机 DSH 凭证</div>
          <div className="switch-row__hint">
            读取 ~/.dsh/.credentials.yaml 中的登录记录与环境变量引用，发现项不会自动导入。
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => void onSaved()}
          disabled={saving}
          title="保存后服务端会按新开关重新扫描"
        >
          保存开关
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="empty-panel">
          <strong>未发现可复用的本机凭证</strong>
          <span>
            请确认 <span className="mono">~/.dsh/.credentials.yaml</span> 存在且上方开关已允许，然后刷新。
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void onImported()}>
            <IconRefresh size={11} /> 重新扫描
          </button>
        </div>
      ) : (
        <div className="conn-list">
          {accounts.map((account) => {
            const isPathHint = account.id === "dsh-redirect" && provider.id === "thirdparty";
            if (isPathHint) {
              return (
                <div className="local-account is-info" key={account.id}>
                  <span className="toast__icon" aria-hidden="true">
                    <IconInfo size={14} />
                  </span>
                  <div className="local-account__main">
                    <span className="local-account__label">
                      {account.label || "DSH 凭证文件位置提示"}
                      <span className="tag tag-warn">说明</span>
                    </span>
                    <span className="local-account__detail">
                      {account.detail ||
                        `本机已登录的 DSH 凭证会被自动发现并使用；这里仅提示凭证文件位置（~/.dsh/.credentials.yaml），无需手动导入。`}
                    </span>
                  </div>
                </div>
              );
            }
            return (
              <div className="local-account" key={account.id}>
                <span className={`dot ${account.usable ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
                <div className="local-account__main">
                  <span className="local-account__label">
                    {account.label}
                    <span className="tag">{account.source === "env" ? "环境变量" : "DSH 凭证文件"}</span>
                    {!account.usable ? <span className="tag tag-warn">不可用</span> : null}
                  </span>
                  <span className="local-account__meta">
                    {MODE_LABEL[account.mode] ?? account.mode}
                    {account.accountLabel ? (
                      <>
                        <span className="sep">·</span>
                        {account.accountLabel}
                      </>
                    ) : null}
                    <span className="sep">·</span>
                    {account.expiresAt ? formatExpiry(account.expiresAt) : "长期有效"}
                  </span>
                  {account.detail ? <span className="local-account__detail">{account.detail}</span> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void importAccount(account.id)}
                  disabled={!account.usable || importingId !== null}
                  title={account.usable ? "导入到 Super Work" : "该凭证当前不可用"}
                  aria-label={`导入 ${account.label}`}
                >
                  {importingId === account.id ? <IconLoader size={11} className="spin" /> : <IconPlug size={11} />}
                  导入
                </button>
              </div>
            );
          })}
        </div>
      )}

      <p className="field__hint">
        <IconInfo size={11} /> 导入后的连接标记为 <span className="mono">source: local</span>，可以随时在“已有连接”里删除；
        原凭证文件始终只读。刷新时间：{formatRelative(Date.now())}。
      </p>
    </div>
  );
}

