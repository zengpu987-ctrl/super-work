import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthStartResponse, ProviderStatus } from "@super-work/core";
import { api, errorMessage, type ConnectionResult } from "../lib/api";
import { IconAlert, IconCheck, IconCopy, IconInfo, IconKey, IconLink, IconLoader, IconShield } from "./Icons";

export type AuthPanelKind = "subscription" | "token";

export interface AuthPanelProps {
  kind: AuthPanelKind;
  provider: ProviderStatus;
  onConnected: () => void;
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
  onGoToTab: (tab: "key" | "subscription" | "local" | "token") => void;
}

type FlowStatus =
  | { kind: "idle" }
  | { kind: "pending"; note?: string }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "expired" };

async function copyPlain(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

const PROVIDER_LOGIN_LABEL: Record<string, string> = {
  openai: "用 ChatGPT 订阅登录",
  kimi: "用 Kimi 会员登录",
};

export function AuthPanel({ kind, provider, onConnected, pushToast, onGoToTab }: AuthPanelProps) {
  if (kind === "subscription") {
    return (
      <SubscriptionPanel
        provider={provider}
        onConnected={onConnected}
        pushToast={pushToast}
        onGoToTab={onGoToTab}
      />
    );
  }
  return <TokenPanel provider={provider} onConnected={onConnected} pushToast={pushToast} />;
}

/* ---------------------------------------------------------------- 订阅登录 */

function SubscriptionPanel({
  provider,
  onConnected,
  pushToast,
  onGoToTab,
}: Omit<AuthPanelProps, "kind">) {
  const [flow, setFlow] = useState<AuthStartResponse | null>(null);
  const [status, setStatus] = useState<FlowStatus>({ kind: "idle" });
  const [starting, setStarting] = useState<"oauth-browser" | "device-code" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const flowRef = useRef<AuthStartResponse | null>(null);

  const supportsOAuth = provider.authModes.includes("oauth-browser");
  const supportsDevice = provider.authModes.includes("device-code");
  const subscription = provider.subscription;

  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);

  // 切换 provider 时清空进行中的流程
  useEffect(() => {
    setFlow(null);
    setStatus({ kind: "idle" });
    setError(null);
    setStarting(null);
  }, [provider.id]);

  // 轮询授权结果
  useEffect(() => {
    if (!flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const interval = Math.max(1, flow.intervalSeconds ?? 2) * 1000;
    const deadline = flow.expiresInSeconds ? Date.now() + flow.expiresInSeconds * 1000 : null;

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const res = await api.pollAuthFlow(provider.id, flow.flowId);
        if (cancelled) return;
        if (res.status === "done") {
          setStatus({ kind: "done" });
          pushToast("success", `${provider.name} 登录成功`);
          onConnected();
          return;
        }
        if (res.status === "error") {
          setStatus({ kind: "error", message: res.message });
          return;
        }
        if (res.status === "expired") {
          setStatus({ kind: "expired" });
          return;
        }
        setStatus({ kind: "pending", note: res.note });
        if (deadline && Date.now() > deadline) {
          setStatus({ kind: "expired" });
          return;
        }
        timer = setTimeout(() => void poll(), interval);
      } catch (err) {
        if (cancelled) return;
        setStatus({ kind: "error", message: errorMessage(err) });
      }
    };

    timer = setTimeout(() => void poll(), interval);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [flow, onConnected, provider.id, provider.name, pushToast]);

  const start = useCallback(
    async (mode: "oauth-browser" | "device-code") => {
      setStarting(mode);
      setError(null);
      try {
        const res = await api.startAuthFlow(provider.id, { mode });
        setFlow(res);
        setStatus({ kind: "pending" });
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setStarting(null);
      }
    },
    [provider.id],
  );

  const cancel = useCallback(async () => {
    const current = flowRef.current;
    setFlow(null);
    setStatus({ kind: "idle" });
    if (!current) return;
    try {
      await api.cancelAuthFlow(provider.id, current.flowId);
    } catch {
      /* 取消失败不影响本地状态 */
    }
  }, [provider.id]);

  const copy = useCallback(
    async (text: string, key: string) => {
      const ok = await copyPlain(text);
      if (!ok) {
        pushToast("error", "复制失败，请手动选择文本");
        return;
      }
      setCopied(key);
      setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1600);
    },
    [pushToast],
  );

  const openExternal = (url?: string): void => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const loginLabel = PROVIDER_LOGIN_LABEL[provider.id] ?? "开始登录";

  return (
    <div className="settings-section">
      <div className="settings-section__title">
        <IconShield size={12} /> 订阅登录
        <span className="right">浏览器 / 设备码授权</span>
      </div>

      {subscription ? (
        <div className="form-status">
          <IconInfo size={12} />
          <span>
            <strong>{subscription.label}</strong>
            {subscription.note ? ` · ${subscription.note}` : ""}
          </span>
        </div>
      ) : null}

      {!supportsOAuth && !supportsDevice ? (
        provider.id === "mock" ? (
          <div className="empty-panel">
            <strong>演示模型不需要凭证</strong>
            <span>直接使用 mock 模型即可体验完整的联合工作流程。</span>
          </div>
        ) : (
          <div className="empty-panel">
            <strong>该 provider 没有官方订阅登录流程</strong>
            <span>
              {provider.name} 未开放第三方 OAuth / 设备码；可以粘贴已有 token，或改用 API Key。
            </span>
            <div className="form-actions" style={{ justifyContent: "center" }}>
              <button type="button" className="btn btn-sm" onClick={() => onGoToTab("token")}>
                去粘贴凭证
              </button>
              <button type="button" className="btn btn-sm" onClick={() => onGoToTab("key")}>
                用 API Key
              </button>
            </div>
          </div>
        )
      ) : null}

      {supportsOAuth ? (
        <div className="settings-section">
          <div className="field">
            <span className="field__label">
              浏览器授权（OAuth PKCE）{provider.id === "openai" ? <span className="tag tag-accent">ChatGPT 订阅</span> : null}
            </span>
            <span className="field__hint">
              点击后生成授权链接，在浏览器完成登录；本页会自动轮询登录结果，凭证只保存在本机。
            </span>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void start("oauth-browser")}
              disabled={starting !== null || flow !== null}
              aria-label="开始浏览器 OAuth 登录"
            >
              {starting === "oauth-browser" ? <IconLoader size={13} className="spin" /> : <IconLink size={13} />}
              {starting === "oauth-browser" ? "正在发起…" : loginLabel}
            </button>
            {flow ? (
              <button type="button" className="btn" onClick={() => void cancel()}>
                取消登录
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {supportsDevice ? (
        <div className="settings-section">
          <div className="field">
            <span className="field__label">设备码登录</span>
            <span className="field__hint">
              生成一次性设备码，在验证页面输入即可授权；设备码同时会打印在启动服务的终端里。
            </span>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void start("device-code")}
              disabled={starting !== null || flow !== null}
              aria-label="开始设备码登录"
            >
              {starting === "device-code" ? <IconLoader size={13} className="spin" /> : <IconKey size={13} />}
              {starting === "device-code" ? "正在生成…" : "生成设备码"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="form-status is-error" role="alert">
          <IconAlert size={12} />
          <span>{error}</span>
        </div>
      ) : null}

      {flow ? (
        <div className="auth-flow">
          <div className="auth-flow__head">
            <IconLoader size={12} className={status.kind === "pending" ? "spin" : undefined} />
            {status.kind === "done"
              ? "登录成功"
              : status.kind === "expired"
                ? "授权已过期"
                : status.kind === "error"
                  ? "授权失败"
                  : flow.kind === "device-code"
                    ? "等待设备码授权…"
                    : "等待浏览器授权…"}
          </div>

          {flow.userCode ? (
            <div className="auth-code">
              <span className="auth-code__value">{flow.userCode}</span>
              <span className="auth-code__hint">在验证页面输入此设备码（启动终端也会显示）</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(flow.userCode ?? "", "code")}
                aria-label="复制设备码"
              >
                {copied === "code" ? <IconCheck size={11} /> : <IconCopy size={11} />}
                {copied === "code" ? "已复制" : "复制设备码"}
              </button>
            </div>
          ) : null}

          {flow.verificationUri || flow.verificationUriComplete ? (
            <div className="auth-link" title={flow.verificationUriComplete ?? flow.verificationUri}>
              <span>{flow.verificationUriComplete ?? flow.verificationUri}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openExternal(flow.verificationUriComplete ?? flow.verificationUri)}
                aria-label="打开验证页面"
              >
                <IconLink size={11} /> 打开
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(flow.verificationUriComplete ?? flow.verificationUri ?? "", "uri")}
                aria-label="复制验证链接"
              >
                {copied === "uri" ? <IconCheck size={11} /> : <IconCopy size={11} />}
              </button>
            </div>
          ) : null}

          {flow.authorizeUrl ? (
            <div className="auth-link" title={flow.authorizeUrl}>
              <span>{flow.authorizeUrl}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => openExternal(flow.authorizeUrl)}
                aria-label="打开授权页面"
              >
                <IconLink size={11} /> 打开授权页
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void copy(flow.authorizeUrl ?? "", "auth")}
                aria-label="复制授权链接"
              >
                {copied === "auth" ? <IconCheck size={11} /> : <IconCopy size={11} />}
              </button>
            </div>
          ) : null}

          {status.kind === "pending" ? (
            <>
              <div className="auth-waiting-bar" aria-hidden="true" />
              <div className="auth-progress">
                <IconLoader size={11} className="spin" />
                正在等待授权完成，页面会自动刷新状态（无需手动点击）。
              </div>
            </>
          ) : null}

          {status.kind === "error" ? (
            <div className="form-status is-error" role="alert">
              <IconAlert size={12} /> <span>{status.message}</span>
            </div>
          ) : null}

          {status.kind === "done" ? (
            <div className="form-status is-ok" role="status">
              <IconCheck size={12} /> <span>{provider.name} 已连接，可以关闭设置并开始运行。</span>
            </div>
          ) : null}

          {status.kind === "expired" ? (
            <div className="form-status is-error" role="alert">
              <IconAlert size={12} /> <span>授权已过期，请重新发起登录。</span>
            </div>
          ) : null}

          {flow.note ? <p className="auth-note">{flow.note}</p> : null}

          {status.kind !== "done" ? (
            <div className="form-actions">
              <button type="button" className="btn btn-sm" onClick={() => void cancel()}>
                取消
              </button>
              {status.kind === "error" || status.kind === "expired" ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void start(flow.kind === "device-code" ? "device-code" : "oauth-browser")}
                >
                  重新发起
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 粘贴凭证 */

function TokenPanel({
  provider,
  onConnected,
  pushToast,
}: Pick<AuthPanelProps, "provider" | "onConnected" | "pushToast">) {
  const [kind, setKind] = useState<"bearer" | "cookie" | "session">("bearer");
  const [token, setToken] = useState("");
  const [cookieName, setCookieName] = useState("");
  const [extraHeaders, setExtraHeaders] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectionResult | null>(null);

  useEffect(() => {
    setToken("");
    setExtraHeaders("");
    setCookieName("");
    setLabel("");
    setError(null);
    setResult(null);
  }, [provider.id]);

  const submit = useCallback(async () => {
    setError(null);
    setResult(null);
    if (token.trim().length === 0) {
      setError("请粘贴凭证内容");
      return;
    }
    let headers: Record<string, string> | undefined;
    if (extraHeaders.trim()) {
      try {
        const parsed = JSON.parse(extraHeaders) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("必须是对象");
        }
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.some(([, value]) => typeof value !== "string")) {
          throw new Error("值必须是字符串");
        }
        headers = Object.fromEntries(entries) as Record<string, string>;
      } catch {
        setError("额外 Header 需要是 JSON 对象，例如 {\"x-account-id\":\"123\"}");
        return;
      }
    }
    setSubmitting(true);
    try {
      // 契约 ConnectRequest 尚无 extraHeaders 字段：作为附加字段发送，服务端忽略时不影响主流程。
      const body = {
        mode: "token" as const,
        token: token.trim(),
        cookieName: kind === "cookie" ? cookieName.trim() || undefined : undefined,
        baseUrl: baseUrl.trim() || undefined,
        label: label.trim() || undefined,
        ...(headers ? { extraHeaders: headers } : {}),
      };
      const connection = await api.connectProvider(provider.id, body);
      setResult(connection);
      if (connection.healthy) {
        pushToast("success", `${provider.name} 凭证已保存`, connection.warning);
      } else {
        pushToast(
          "warn",
          `${provider.name} 凭证已保存，但校验未通过`,
          connection.warning ?? connection.detail,
        );
      }
      setToken("");
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [baseUrl, cookieName, extraHeaders, kind, label, onConnected, provider.id, provider.name, pushToast, token]);

  const canToken = provider.authModes.includes("token") || provider.authModes.includes("local");

  return (
    <div className="settings-section">
      <div className="settings-section__title">
        <IconKey size={12} /> 粘贴凭证
        <span className="right">Bearer / Cookie / Session</span>
      </div>

      {!canToken ? (
        <div className="form-status">
          <IconInfo size={12} />
          <span>{provider.name} 的 catalog 未声明 token 模式，仍可尝试粘贴；若服务端拒绝请改用 API Key。</span>
        </div>
      ) : null}

      <div className="field">
        <span className="field__label">凭证类型</span>
        <div className="token-kind" role="group" aria-label="凭证类型">
          {(["bearer", "cookie", "session"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={kind === item ? "is-active" : ""}
              onClick={() => setKind(item)}
              aria-pressed={kind === item}
            >
              {item === "bearer" ? "Bearer Token" : item === "cookie" ? "Cookie" : "Session"}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="token-value">
          凭证内容 <span className="req">必填</span>
        </label>
        <textarea
          id="token-value"
          className="textarea"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={
            kind === "bearer"
              ? "粘贴 access token / Bearer 后面的那串字符"
              : kind === "cookie"
                ? "粘贴 cookie 头的值（或完整 Cookie 串）"
                : "粘贴 session 值"
          }
          rows={3}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="field__hint">凭证会加密保存在本机 ~/.super-work，不会上传到任何第三方服务。</span>
      </div>

      {kind === "cookie" ? (
        <div className="field">
          <label className="field__label" htmlFor="cookie-name">
            Cookie 名称 <span className="opt">可选</span>
          </label>
          <input
            id="cookie-name"
            className="input"
            value={cookieName}
            onChange={(event) => setCookieName(event.target.value)}
            placeholder="例如 __Secure-next-auth.session-token"
            spellCheck={false}
          />
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="extra-headers">
          额外 Header JSON <span className="opt">可选</span>
        </label>
        <textarea
          id="extra-headers"
          className="textarea"
          value={extraHeaders}
          onChange={(event) => setExtraHeaders(event.target.value)}
          placeholder={'{"x-account-id":"123"}'}
          rows={2}
          spellCheck={false}
        />
        <span className="field__hint">需要附加鉴权头或账号标识时填写；必须是字符串键值对象。</span>
      </div>

      <div className="field__row">
        <div className="field">
          <label className="field__label" htmlFor="token-label">
            标签 <span className="opt">可选</span>
          </label>
          <input
            id="token-label"
            className="input"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：工作账号"
            maxLength={60}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="token-base">
            自定义 baseUrl <span className="opt">可选</span>
          </label>
          <input
            id="token-base"
            className="input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="留空使用 provider 默认端点"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={submitting || token.trim().length === 0}
        >
          {submitting ? <IconLoader size={13} className="spin" /> : <IconCheck size={13} />}
          {submitting ? "保存并校验…" : "保存凭证"}
        </button>
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
