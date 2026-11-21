import crypto from "node:crypto";
import {
  PROVIDER_BY_ID,
  type AuthMode,
  type ConnectRequest,
  type ConnectionStatus,
  type Credential,
  type ProviderId,
} from "@super-work/core";
import { adapterForCall } from "@super-work/providers";
import type { AppSettings } from "@super-work/core";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";
import { localAccountCredential, discoverLocalAccounts } from "./local-reuse.js";
import { refreshOpenAIToken } from "./auth/openai.js";
import { refreshKimiToken } from "./auth/kimi.js";
import type { StoredCredential, Storage } from "./storage.js";

const SOURCE_PRIORITY: Record<string, number> = { user: 0, local: 1, env: 2 };

/**
 * 本机凭证去重身份：同 source=local + 同 mode + 同 accountLabel。
 *
 * 不能只比 accountLabel：订阅凭证（device-code）与 Moonshot API Key（api-key）
 * 的 accountLabel 都是 undefined，只比 label 会把两者当成同一条记录，
 * 导致「导入 Kimi 会员」把 API Key 行顶掉、或反过来。
 */
export function isSameLocalAccount(row: StoredCredential, credential: Credential): boolean {
  return (
    row.source === "local" &&
    row.mode === credential.mode &&
    (row.accountLabel ?? undefined) === (credential.accountLabel ?? undefined)
  );
}

export interface ResolvedCredential {
  row: StoredCredential;
  credential: Credential;
}

export class CredentialManager {
  constructor(
    private storage: Storage,
    private settings: AppSettings,
    private log: Logger,
  ) {}

  setSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  modelCountFor(row: StoredCredential): number {
    const models = PROVIDER_BY_ID[row.provider]?.models ?? [];
    const subscription = row.mode === "oauth-browser" || row.mode === "device-code";
    return models.filter((m) => !m.via || m.via === "any" || (m.via === "subscription" ? subscription : !subscription))
      .length;
  }

  statusFromRow(row: StoredCredential): ConnectionStatus {
    return {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      source: row.source,
      label: row.label,
      accountLabel: row.accountLabel,
      expiresAt: this.expiryOf(row),
      healthy: row.healthy,
      modelCount: this.modelCountFor(row),
      detail: row.detail,
    };
  }

  private expiryOf(row: StoredCredential): number | undefined {
    try {
      const cred = this.storage.decryptedCredential(this.storage.getCredentialRow(row.id)!);
      return cred.oauth?.expiresAt;
    } catch {
      return undefined;
    }
  }

  statuses(provider?: ProviderId): ConnectionStatus[] {
    return this.storage.listCredentialRows(provider).map((row) => this.statusFromRow(this.storage.toStored(row)));
  }

  localAccounts(provider?: ProviderId) {
    const accounts = discoverLocalAccounts(this.settings);
    return provider ? accounts.filter((a) => a.provider === provider) : accounts;
  }

  /** 保存一条凭证（OAuth 流程回调与手动录入都走这里）。 */
  saveCredential(credential: Credential, extra?: { healthy?: boolean; detail?: string }): ConnectionStatus {
    const id = `cred_${crypto.randomBytes(6).toString("hex")}`;
    const label = credential.label ?? PROVIDER_BY_ID[credential.provider]?.name ?? String(credential.provider);
    const row = this.storage.insertCredential({
      id,
      credential,
      source: credential.source ?? "user",
      label,
      accountLabel: credential.accountLabel ?? credential.oauth?.accountLabel,
      healthy: extra?.healthy,
      detail: extra?.detail,
    });
    this.log.info("已保存凭证", { provider: credential.provider, mode: credential.mode, id });
    return this.statusFromRow(row);
  }

  async connect(provider: ProviderId, req: ConnectRequest): Promise<{ status: ConnectionStatus; warning?: string }> {
    const meta = PROVIDER_BY_ID[provider];
    if (!meta) throw new Error(`未知的 provider：${provider}`);
    if (provider === "mock") throw new Error("演示模型无需连接");

    if (req.mode === "api-key") {
      const apiKey = req.apiKey?.trim();
      if (!apiKey) throw new Error("请填写 API Key");
      if (meta.authModes.includes("api-key") === false) throw new Error(`${meta.name} 不支持 API Key 方式`);
      if (provider === "thirdparty" && !req.baseUrl?.trim()) throw new Error("第三方端点必须填写 Base URL");
      const credential: Credential = {
        provider,
        mode: "api-key",
        source: "user",
        apiKey,
        baseUrl: req.baseUrl?.trim() || undefined,
        label: req.label?.trim() || `${meta.name} API Key`,
        createdAt: new Date().toISOString(),
      };
      const check = req.skipValidation
        ? { ok: true, detail: "已按请求跳过网络校验" }
        : await this.validate(credential, 12_000);
      if (!check.ok && check.fatal) {
        throw new Error(`API Key 校验失败：${check.detail ?? "未知错误"}`);
      }
      return {
        status: this.saveCredential(credential, {
          healthy: check.ok,
          detail: check.ok ? undefined : check.detail,
        }),
        warning: check.ok ? undefined : `已保存，但校验未通过：${check.detail ?? "未知原因"}`,
      };
    }

    if (req.mode === "token") {
      const token = req.token?.trim();
      if (!token) throw new Error("请粘贴凭证内容");
      const cookieName = req.cookieName?.trim() || undefined;
      const extraHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.extraHeaders ?? {})) {
        const k = key.trim();
        const v = String(value ?? "").trim();
        if (!k || !v) continue;
        if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
        extraHeaders[k] = v;
      }
      const credential: Credential = {
        provider,
        mode: "token",
        source: "user",
        pasted: {
          access: token,
          kind: cookieName ? "cookie" : "bearer",
          cookieName,
          extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        },
        baseUrl: req.baseUrl?.trim() || undefined,
        label: req.label?.trim() || `${meta.name} 粘贴凭证`,
      };
      const check = await this.validate(credential, 8_000);
      return {
        status: this.saveCredential(credential, {
          healthy: check.ok,
          detail: check.ok ? undefined : check.detail,
        }),
        warning: check.ok ? undefined : `凭证已保存；未能自动验证（${check.detail ?? "接口未返回可用模型"}），使用时若失败请更换凭证。`,
      };
    }

    throw new Error(`/connect 不支持 ${req.mode} 方式，请使用登录流程`);
  }

  async importLocal(provider: ProviderId, localAccountId: string): Promise<ConnectionStatus> {
    if (!this.settings.allowLocalReuse) throw new Error("设置里关闭了「复用本机登录」，请先打开");
    const credential = localAccountCredential(this.settings, localAccountId);
    if (!credential) throw new Error("未找到该本机凭证（可能文件已变动，请刷新）");
    if (credential.provider !== provider) throw new Error("凭证所属 provider 不匹配");

    const existing = this.storage
      .listCredentialRows(provider)
      .map((r) => this.storage.toStored(r))
      .find((r) => isSameLocalAccount(r, credential));

    const check = await this.validate(credential, 10_000);

    if (existing) {
      // 关键：DSH 刷新过令牌后，「重新导入」必须把新令牌写回本地库并更新健康状态，
      // 否则界面会一直停在旧的「已过期，请重新登录」，导入看起来像失败了。
      this.storage.updateCredentialPayload(existing.id, credential);
      this.storage.setCredentialHealth(existing.id, {
        healthy: check.ok,
        detail: check.ok ? undefined : check.detail,
      });
      this.log.info("已刷新本机凭证", {
        provider,
        mode: credential.mode,
        id: existing.id,
        healthy: check.ok,
      });
      return this.statusFromRow(this.storage.toStored(this.storage.getCredentialRow(existing.id)!));
    }

    return this.saveCredential(credential, {
      healthy: check.ok,
      detail: check.ok ? undefined : check.detail,
    });
  }

  async validate(credential: Credential, timeoutMs: number): Promise<{ ok: boolean; detail?: string; fatal?: boolean }> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);
    try {
      const adapter = adapterForCall(credential.provider, credential);
      const result = await Promise.race([
        adapter.validate(credential),
        new Promise<{ ok: false; detail: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, detail: `校验超时（${timeoutMs}ms）` }), timeoutMs),
        ),
      ]);
      return {
        ok: result.ok,
        detail: result.detail ?? (result.ok ? undefined : timedOut ? "校验超时" : "凭证不可用"),
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      const status =
        (error as { status?: number }).status ?? (error as { httpStatus?: number }).httpStatus;
      const fatal = status === 401 || status === 403;
      return { ok: false, detail: message, fatal };
    } finally {
      clearTimeout(timer);
    }
  }

  disconnect(id: string): boolean {
    const ok = this.storage.deleteCredential(id);
    if (ok) this.log.info("已删除凭证", { id });
    return ok;
  }

  /** 为某模型选择一条可用凭证；没有则返回 undefined。 */
  resolve(provider: ProviderId, modelVia?: "api" | "subscription" | "any"): ResolvedCredential | undefined {
    if (provider === "mock") return undefined;
    const rows = this.storage
      .listCredentialRows(provider)
      .map((r) => this.storage.toStored(r))
      .sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 3) - (SOURCE_PRIORITY[b.source] ?? 3) || b.updatedAt - a.updatedAt);

    const matches = (row: StoredCredential): boolean => {
      if (modelVia === "subscription") return row.mode === "oauth-browser" || row.mode === "device-code";
      if (modelVia === "api") return row.mode === "api-key" || row.mode === "token";
      return true;
    };
    // 优先健康凭证
    const ordered = [...rows.filter((r) => r.healthy), ...rows.filter((r) => !r.healthy)];
    for (const row of ordered) {
      if (!matches(row)) continue;
      try {
        const credential = this.storage.decryptedCredential(this.storage.getCredentialRow(row.id)!);
        return { row, credential };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * 使用前处理临期凭证。
   *
   * 关键约束：**只刷新本应用内登录（source=user）的 token**。
   * 本机复用（source=local）的 refresh token 与 DSH 共用，刷新会轮换令牌、
   * 反过来使 DSH 那边失效，所以这里绝不网络刷新，只从本机凭证文件重新读取最新值。
   */
  async fresh(resolved: ResolvedCredential): Promise<Credential> {
    const { row, credential } = resolved;
    const oauth = credential.oauth;

    if (row.source !== "user") {
      const reloaded = this.reloadLocal(row, credential);
      if (!reloaded.oauth?.expiresAt) return reloaded;
      // 不去预判过期：本机 token 的 clocks 与上游可能不同，真过期会让调用返回 401，
      // 那时给出可操作的提示（见 registry）。
      return reloaded;
    }

    if (!oauth?.expiresAt) return credential;
    if (oauth.expiresAt - Date.now() > 90_000) return credential;

    if (row.provider === "openai" && oauth.refresh) {
      const next = await refreshOpenAIToken(oauth.refresh);
      const merged: Credential = { ...credential, oauth: { ...oauth, ...next } };
      this.storage.updateCredentialPayload(row.id, merged, { healthy: true, detail: undefined });
      this.log.info("已刷新 ChatGPT 订阅令牌");
      return merged;
    }
    if (row.provider === "kimi" && oauth.refresh) {
      const next = await refreshKimiToken(oauth.refresh);
      const merged: Credential = { ...credential, oauth: { ...oauth, ...next } };
      this.storage.updateCredentialPayload(row.id, merged, { healthy: true, detail: undefined });
      this.log.info("已刷新 Kimi 会员令牌");
      return merged;
    }
    throw new Error("订阅凭证已过期，请在设置里重新登录");
  }

  /**
   * 调用收到 401/403 时强制刷新一次（仅 source=user，避免轮换 DSH 共用令牌）。
   * 本机复用凭证重新从 DSH 文件读取，若拿到更新的 token 则返回。
   */
  async forceRefresh(resolved: ResolvedCredential): Promise<Credential | undefined> {
    const { row, credential } = resolved;
    const oauth = credential.oauth;
    try {
      if (row.source === "user" && oauth?.refresh) {
        const next =
          row.provider === "openai"
            ? await refreshOpenAIToken(oauth.refresh)
            : row.provider === "kimi"
              ? await refreshKimiToken(oauth.refresh)
              : undefined;
        if (next) {
          const merged: Credential = { ...credential, oauth: { ...oauth, ...next } };
          this.storage.updateCredentialPayload(row.id, merged, { healthy: true, detail: undefined });
          this.log.info("凭证 401，已强制刷新订阅令牌", { provider: row.provider });
          return merged;
        }
      }
      if (row.source !== "user") {
        const reloaded = this.reloadLocal(row, credential);
        const before = oauth?.access ?? "";
        const after = reloaded.oauth?.access ?? "";
        if (after && after !== before) return reloaded;
      }
    } catch (error) {
      this.log.warn("强制刷新凭证失败", { provider: row.provider, message: (error as Error).message });
    }
    return undefined;
  }

  /** 本机复用的凭证：从源文件重新读一遍，取更新的 token（不刷新、不回写源文件）。 */
  private reloadLocal(row: StoredCredential, current: Credential): Credential {
    try {
      if (!this.settings.allowLocalReuse) return current;
      const accounts = discoverLocalAccounts(this.settings).filter((a) => a.provider === row.provider);
      for (const account of accounts) {
        const cred = localAccountCredential(this.settings, account.id);
        if (!cred) continue;
        if (cred.mode !== row.mode) continue;
        const currentExpiry = current.oauth?.expiresAt ?? 0;
        const nextExpiry = cred.oauth?.expiresAt ?? 0;
        const newer = nextExpiry > currentExpiry || (cred.apiKey && cred.apiKey !== current.apiKey);
        if (!newer) continue;
        const merged: Credential = { ...current, oauth: cred.oauth ?? current.oauth, apiKey: cred.apiKey ?? current.apiKey };
        this.storage.updateCredentialPayload(row.id, merged);
        this.log.info("已从本机凭证文件读取到更新的登录态", { provider: row.provider });
        return merged;
      }
    } catch {
      /* 读不到就沿用旧值 */
    }
    return current;
  }

}
