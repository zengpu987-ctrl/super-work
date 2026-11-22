import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  RELAY_PRESETS,
  PROVIDER_BY_ID,
  type Credential,
  type ModelInfo,
  type RelayAccount,
  type RelayCreateRequest,
  type RelayDiscoverResponse,
  type RelayKind,
  type RelayModel,
  type RelayUpdateRequest,
} from "@super-work/core";
import { adapterForCall, discoverRelayModels } from "@super-work/providers";
import type { Storage } from "./storage.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";

const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_SITE_BASE = "https://www.codebuddy.cn";

interface RelayRow {
  id: string;
  name: string;
  kind: RelayKind;
  preset_id: string | null;
  base_url: string;
  api_key: string | null;
  extra_headers: string | null;
  source: string;
  enabled: number;
  models_json: string | null;
  account_label: string | null;
  credits_json: string | null;
  discovered_at: number | null;
  health: string;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkBuddyLocalAccount {
  region: "cn" | "global";
  accountLabel: string;
  uid: string;
  domain: string;
  expiresAt?: number;
  vaultFile: string;
  usable: boolean;
  detail?: string;
}

interface WorkbuddyVaultFile {
  version?: number;
  accountId?: string;
  refreshedAtMs?: number;
  auth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshExpiresAt?: number;
    domain?: string;
  };
  account?: { uid?: string; nickname?: string; uin?: string };
}

function vaultDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, ".dsh/workbuddy-vault"), path.join(home, ".workbuddy/vault")];
}

export function detectWorkBuddyLocalAccounts(): WorkBuddyLocalAccount[] {
  const out: WorkBuddyLocalAccount[] = [];
  for (const dir of vaultDirs()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const region of entries) {
      const regionDir = path.join(dir, region);
      let files: string[] = [];
      try {
        files = fs.readdirSync(regionDir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(regionDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(full, "utf8")) as WorkbuddyVaultFile;
          const access = raw.auth?.accessToken;
          if (!access) continue;
          const domain = raw.auth?.domain ?? (region === "cn" ? "www.codebuddy.cn" : "www.workbuddy.ai");
          const isCn = /\.cn$/i.test(domain) || region === "cn";
          const expiresAt = raw.auth?.expiresAt ? raw.auth.expiresAt * 1000 : undefined;
          out.push({
            region: isCn ? "cn" : "global",
            accountLabel: raw.account?.nickname ?? (raw.account?.uid ? `…${raw.account.uid.slice(-6)}` : "WorkBuddy 账号"),
            uid: raw.account?.uid ?? "",
            domain,
            expiresAt,
            vaultFile: full,
            usable: expiresAt ? expiresAt > Date.now() : true,
            detail: expiresAt && expiresAt <= Date.now() ? "登录已过期，请在 WorkBuddy 客户端重新登录" : undefined,
          });
        } catch {
          /* skip broken vault file */
        }
      }
    }
  }
  // 同一账号可能重复出现
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = `${a.region}:${a.uid}:${a.domain}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chatBaseFor(domain: string): string {
  if (/\.cn$/i.test(domain) || /codebuddy\.cn/i.test(domain)) return CN_CHAT_BASE;
  if (/workbuddy\.ai/i.test(domain)) return "https://www.workbuddy.ai";
  if (/codebuddy\.ai/i.test(domain)) return "https://www.codebuddy.ai";
  return CN_CHAT_BASE;
}

const WORKBUDDY_GLOBAL_AUTH_BASE = "https://www.workbuddy.ai";
const WORKBUDDY_CN_AUTH_BASE = "https://www.codebuddy.cn";
const WORKBUDDY_PLUGIN_PREFIX = "/v2/plugin";

interface WorkBuddyOAuthSession {
  loginId: string;
  region: "cn" | "global";
  base: string;
  state: string;
  createdAt: number;
}

function oauthEnvelopeData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = (payload as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function oauthString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function oauthExpirySeconds(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    const num = typeof value === "string" ? Number(value) : value;
    if (typeof num === "number" && Number.isFinite(num) && num > 0) {
      return num > 10_000_000_000 ? Math.floor(num / 1000) : Math.floor(num);
    }
  }
  return 0;
}

export class RelayStore {
  constructor(
    private storage: Storage,
    private log: Logger,
  ) {
    this.storage.db.exec(`
      CREATE TABLE IF NOT EXISTS relays (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        preset_id TEXT,
        base_url TEXT NOT NULL,
        api_key TEXT,
        extra_headers TEXT,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        models_json TEXT,
        account_label TEXT,
        credits_json TEXT,
        discovered_at INTEGER,
        health TEXT NOT NULL DEFAULT 'unknown',
        detail TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private rowToAccount(row: RelayRow): RelayAccount {
    let models: RelayModel[] = [];
    try {
      models = row.models_json ? (JSON.parse(row.models_json) as RelayModel[]) : [];
    } catch {
      models = [];
    }
    let credits: RelayAccount["credits"];
    try {
      credits = row.credits_json ? (JSON.parse(row.credits_json) as RelayAccount["credits"]) : undefined;
    } catch {
      credits = undefined;
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      presetId: row.preset_id ?? undefined,
      baseUrl: row.base_url,
      hasKey: Boolean(row.api_key),
      accountLabel: row.account_label ?? undefined,
      source: row.source as RelayAccount["source"],
      enabled: row.enabled === 1,
      models,
      discoveredAt: row.discovered_at ?? undefined,
      credits,
      health: row.health as RelayAccount["health"],
      detail: row.detail ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): RelayAccount[] {
    const rows = this.storage.db.prepare("SELECT * FROM relays ORDER BY created_at ASC").all() as unknown as RelayRow[];
    return rows.map((r) => this.rowToAccount(r));
  }

  get(id: string): RelayAccount | undefined {
    const row = this.storage.db.prepare("SELECT * FROM relays WHERE id = ?").get(id) as unknown as RelayRow | undefined;
    return row ? this.rowToAccount(row) : undefined;
  }

  private rawRow(id: string): RelayRow | undefined {
    return this.storage.db.prepare("SELECT * FROM relays WHERE id = ?").get(id) as unknown as RelayRow | undefined;
  }

  private decryptKey(row: RelayRow): string | undefined {
    if (!row.api_key) return undefined;
    try {
      return this.storage.decryptSecret(row.api_key);
    } catch {
      return undefined;
    }
  }

  create(req: RelayCreateRequest): RelayAccount {
    const preset = RELAY_PRESETS.find((p) => p.id === req.presetId);
    const id = `relay_${crypto.randomBytes(5).toString("hex")}`;
    const now = Date.now();
    const kind: RelayKind = req.kind ?? preset?.kind ?? "openai-compat";
    const baseUrl =
      req.baseUrl?.trim() ||
      preset?.baseUrl ||
      (kind === "workbuddy" ? CN_CHAT_BASE : "");
    const apiKey = req.apiKey?.trim();
    this.storage.db
      .prepare(
        `INSERT INTO relays (id, name, kind, preset_id, base_url, api_key, extra_headers, source, enabled,
           models_json, account_label, credits_json, discovered_at, health, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, 'unknown', NULL, ?, ?)`,
      )
      .run(
        id,
        req.name?.trim() || preset?.name || "中转站",
        kind,
        req.presetId ?? null,
        baseUrl,
        apiKey ? this.storage.encryptSecret(apiKey) : null,
        req.extraHeaders ? JSON.stringify(req.extraHeaders) : null,
        req.presetId === "workbuddy" ? "local" : preset ? "preset" : "manual",
        now,
        now,
      );
    this.log.info("已创建中转站", { id, name: req.name, kind });
    return this.get(id)!;
  }

  update(id: string, req: RelayUpdateRequest): RelayAccount | undefined {
    const row = this.rawRow(id);
    if (!row) return undefined;
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [Date.now()];
    if (req.name !== undefined) {
      sets.push("name = ?");
      values.push(req.name);
    }
    if (req.baseUrl !== undefined) {
      sets.push("base_url = ?");
      values.push(req.baseUrl);
    }
    if (req.apiKey !== undefined && req.apiKey.trim() !== "") {
      sets.push("api_key = ?");
      values.push(this.storage.encryptSecret(req.apiKey.trim()));
    }
    if (req.extraHeaders !== undefined) {
      sets.push("extra_headers = ?");
      values.push(JSON.stringify(req.extraHeaders));
    }
    if (req.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(req.enabled ? 1 : 0);
    }
    if (req.modelIds !== undefined) {
      let models: RelayModel[] = [];
      try {
        models = row.models_json ? (JSON.parse(row.models_json) as RelayModel[]) : [];
      } catch {
        models = [];
      }
      const allowed = new Set(req.modelIds);
      models = models.map((m) => ({ ...m, enabled: allowed.has(m.id) }));
      sets.push("models_json = ?");
      values.push(JSON.stringify(models));
    }
    values.push(id);
    this.storage.db.prepare(`UPDATE relays SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  remove(id: string): boolean {
    const res = this.storage.db.prepare("DELETE FROM relays WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  /** 供调用层使用的凭证（密钥明文只在内存里存在）。 */
  credentialFor(relay: RelayAccount): Credential | undefined {
    const row = this.rawRow(relay.id);
    if (!row) return undefined;
    const apiKey = this.decryptKey(row);
    const extra: Record<string, string> = row.extra_headers
      ? (JSON.parse(row.extra_headers) as Record<string, string>)
      : {};
    if (relay.kind === "workbuddy") {
      if (!apiKey) return undefined;
      return {
        provider: "workbuddy",
        mode: "token",
        source: "local",
        baseUrl: relay.baseUrl || CN_CHAT_BASE,
        pasted: {
          access: apiKey,
          kind: "bearer",
          extraHeaders: extra,
        },
        label: relay.name,
        accountLabel: relay.accountLabel,
      };
    }
    return {
      provider: "relay",
      mode: "api-key",
      source: "user",
      apiKey,
      baseUrl: relay.baseUrl,
      pasted: Object.keys(extra).length > 0 ? { access: "", kind: "bearer", extraHeaders: extra } : undefined,
      label: relay.name,
    };
  }

  /** 解析 relay 模型 id：`relay_x::gpt-4o` */
  resolveRelayModel(modelId: string): { relay: RelayAccount; remoteId: string } | undefined {
    const sep = modelId.indexOf("::");
    if (sep <= 0) return undefined;
    const relayId = modelId.slice(0, sep);
    const remoteId = modelId.slice(sep + 2);
    const relay = this.get(relayId);
    if (!relay || !relay.enabled) return undefined;
    return { relay, remoteId };
  }

  models(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const relay of this.list()) {
      if (!relay.enabled || relay.kind === "workbuddy") continue;
      for (const model of relay.models) {
        if (!model.enabled) continue;
        out.push({
          id: `${relay.id}::${model.id}`,
          name: model.name || model.id,
          provider: "relay",
          providerLabel: relay.name,
          relayId: relay.id,
          remoteId: model.id,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          vision: model.supportsImages,
          reasoning: model.supportsReasoning,
          imageGen: model.imageGen,
          creditMultiplier: model.creditMultiplier,
        });
      }
    }
    return out;
  }

  workbuddyModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const relay of this.list()) {
      if (!relay.enabled || relay.kind !== "workbuddy") continue;
      for (const model of relay.models) {
        if (!model.enabled) continue;
        out.push({
          id: model.id,
          name: model.name || model.id,
          provider: "workbuddy",
          relayId: relay.id,
          providedBy: relay.name,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          vision: model.supportsImages,
          reasoning: model.supportsReasoning,
          imageGen: model.imageGen,
          creditMultiplier: model.creditMultiplier,
        });
      }
    }
    return out;
  }

  /** 拉取上游模型目录（不落库）。 */
  async discover(id: string): Promise<RelayDiscoverResponse> {
    const relay = this.get(id);
    if (!relay) throw new Error("中转站不存在");
    const cred = this.credentialFor(relay);
    if (!cred) throw new Error("该中转站还没有配置 API Key");
    try {
      if (relay.kind === "workbuddy") {
        const adapter = adapterForCall("workbuddy", cred);
        const models = await adapter.listModels(cred);
        return {
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            supportsImages: m.vision,
            supportsReasoning: m.reasoning,
            imageGen: m.imageGen,
            enabled: true,
          })),
          accountLabel: relay.accountLabel,
          detail: `上游返回 ${models.length} 个模型`,
        };
      }
      const apiKey = cred.apiKey ?? "";
      const extra = cred.pasted?.extraHeaders;
      const models = await discoverRelayModels(relay.baseUrl, apiKey, extra);
      return { models: models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, enabled: true })) };
    } catch (error) {
      const message = safeErrorMessage(error);
      this.storage.db
        .prepare("UPDATE relays SET health = 'error', detail = ?, updated_at = ? WHERE id = ?")
        .run(message, Date.now(), id);
      throw new Error(message);
    }
  }

  importModels(id: string, models: RelayModel[]): RelayAccount | undefined {
    const row = this.rawRow(id);
    if (!row) return undefined;
    let existing: RelayModel[] = [];
    try {
      existing = row.models_json ? (JSON.parse(row.models_json) as RelayModel[]) : [];
    } catch {
      existing = [];
    }
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of models) byId.set(m.id, { ...byId.get(m.id), ...m, enabled: m.enabled !== false });
    this.storage.db
      .prepare(
        "UPDATE relays SET models_json = ?, discovered_at = ?, health = 'ok', detail = NULL, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify([...byId.values()]), Date.now(), Date.now(), id);
    return this.get(id);
  }

  /* ------------------------ WorkBuddy 网页登录 ------------------------ */

  private wbOAuthSessions = new Map<string, WorkBuddyOAuthSession>();

  /**
   * 启动 WorkBuddy 网页登录（国际版默认 workbuddy.ai）。
   * 返回给前端的只有登录 id 与授权地址，不会返回任何 token。
   */
  async startWorkBuddyOAuth(region: "cn" | "global" = "global"): Promise<{
    loginId: string;
    verificationUri: string;
    expiresIn: number;
  }> {
    const base = region === "cn" ? WORKBUDDY_CN_AUTH_BASE : WORKBUDDY_GLOBAL_AUTH_BASE;
    const res = await fetch(`${base}${WORKBUDDY_PLUGIN_PREFIX}/auth/state?platform=workbuddy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await res.json().catch(() => ({}))) as unknown;
    const data = oauthEnvelopeData(payload);
    const state = oauthString(data, ["state", "State"]);
    if (!state) throw new Error(`WorkBuddy 登录服务未返回 state（HTTP ${res.status}）`);
    const authUrl =
      oauthString(data, ["authUrl", "auth_url", "url", "Url"]) ||
      `${base}/login?platform=workbuddy&state=${encodeURIComponent(state)}`;
    const loginId = `wbo_${crypto.randomUUID().replace(/-/g, "")}`;
    this.wbOAuthSessions.set(loginId, {
      loginId,
      region,
      base,
      state,
      createdAt: Date.now(),
    });
    // 过期会话在每次启动时顺手清理。
    for (const [id, session] of this.wbOAuthSessions) {
      if (Date.now() - session.createdAt > 10 * 60_000) this.wbOAuthSessions.delete(id);
    }
    return { loginId, verificationUri: authUrl, expiresIn: 600 };
  }

  /** 轮询网页登录；成功后写入 WorkBuddy vault 并自动导入模型。 */
  async pollWorkBuddyOAuth(loginId: string): Promise<{
    done: boolean;
    account?: RelayAccount;
    error?: string;
  }> {
    const session = this.wbOAuthSessions.get(loginId);
    if (!session) return { done: true, error: "登录会话不存在，请重新发起" };
    if (Date.now() - session.createdAt > 10 * 60_000) {
      this.wbOAuthSessions.delete(loginId);
      return { done: true, error: "登录已超时，请重新发起" };
    }
    const tokenRes = await fetch(
      `${session.base}${WORKBUDDY_PLUGIN_PREFIX}/auth/token?state=${encodeURIComponent(session.state)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
    );
    const tokenPayload = (await tokenRes.json().catch(() => ({}))) as unknown;
    const tokenCode = Number((tokenPayload as Record<string, unknown> | null)?.code);
    if (Number.isFinite(tokenCode) && tokenCode !== 0 && tokenCode !== 200) return { done: false };
    const tokenData = oauthEnvelopeData(tokenPayload);
    const accessToken = oauthString(tokenData, ["accessToken", "access_token", "AccessToken"]);
    if (!accessToken) return { done: false };

    const domain = oauthString(tokenData, ["domain", "Domain"]) || new URL(session.base).hostname;
    let profile: Record<string, unknown> = {};
    try {
      const profileRes = await fetch(`${session.base}${WORKBUDDY_PLUGIN_PREFIX}/login/account`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "X-Domain": domain },
        signal: AbortSignal.timeout(30_000),
      });
      profile = oauthEnvelopeData((await profileRes.json().catch(() => ({}))) as unknown);
    } catch {
      /* 账号资料失败不阻塞登录；vault 仍可保存 */
    }
    const uid = oauthString(profile, ["uid", "Uid", "userId", "UserID"]);
    const nickname = oauthString(profile, ["nickname", "NickName", "ScreenName"]) || "WorkBuddy 国际版";
    const uin = oauthString(profile, ["uin", "Uin"]);
    const accountId = uid || crypto.randomUUID();
    const expiresAt = oauthExpirySeconds(tokenData, ["expiresAt", "expires_at", "expires"]);
    const refreshExpiresAt = oauthExpirySeconds(tokenData, ["refreshExpiresAt", "refresh_expires_at"]);
    const vaultDir = path.join(os.homedir(), ".dsh", "workbuddy-vault", session.region);
    fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    const vaultFile = path.join(vaultDir, `${accountId}.json`);
    const now = Date.now();
    fs.writeFileSync(
      vaultFile,
      JSON.stringify(
        {
          version: 1,
          accountId,
          refreshedAtMs: now,
          auth: {
            accessToken,
            refreshToken: oauthString(tokenData, ["refreshToken", "refresh_token", "RefreshToken"]),
            expiresAt,
            refreshExpiresAt,
            lastRefreshTime: now,
            domain,
          },
          account: { uid, nickname, uin },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    this.wbOAuthSessions.delete(loginId);
    try {
      const account = await this.importWorkBuddy({ region: session.region, uid: uid || undefined });
      return { done: true, account };
    } catch (error) {
      return { done: true, error: `账号已登录，但导入模型失败：${safeErrorMessage(error)}` };
    }
  }

  /* ----------------------------- WorkBuddy ----------------------------- */

  async importWorkBuddy(args: { region?: "cn" | "global"; uid?: string } = {}): Promise<RelayAccount> {
    const accounts = detectWorkBuddyLocalAccounts().filter((a) => a.usable);
    const target = args.uid
      ? accounts.find((a) => a.uid === args.uid)
      : args.region
        ? accounts.find((a) => a.region === args.region)
        : accounts[0];
    if (!target) throw new Error("没有找到可用的 WorkBuddy 本机登录（请先在 WorkBuddy 客户端登录）");
    const raw = JSON.parse(fs.readFileSync(target.vaultFile, "utf8")) as WorkbuddyVaultFile;
    const accessToken = raw.auth?.accessToken;
    if (!accessToken) throw new Error("WorkBuddy 凭证缺少 accessToken");

    const baseUrl = chatBaseFor(target.domain);
    const existing = this.list().find(
      (r) =>
        r.kind === "workbuddy" &&
        r.accountLabel === target.accountLabel &&
        r.presetId === "workbuddy" &&
        r.baseUrl === baseUrl,
    );
    const extra = { "X-User-Id": target.uid, "X-Domain": target.domain };
    let relayId: string;
    if (existing) {
      relayId = existing.id;
      this.update(existing.id, { enabled: true, apiKey: accessToken, extraHeaders: extra, baseUrl });
    } else {
      const accountName =
        target.region === "global" && target.accountLabel === "WorkBuddy 国际版"
          ? "WorkBuddy 国际版"
          : target.region === "global"
            ? `WorkBuddy 国际版 · ${target.accountLabel}`
            : `WorkBuddy · ${target.accountLabel}`;
      const created = this.create({
        name: accountName,
        kind: "workbuddy",
        presetId: "workbuddy",
        baseUrl,
        apiKey: accessToken,
        extraHeaders: extra,
      });
      relayId = created.id;
    }
    // 写入账号名（create 里没有 accountLabel 字段）
    this.storage.db
      .prepare("UPDATE relays SET account_label = ?, source = 'local', updated_at = ? WHERE id = ?")
      .run(target.accountLabel, Date.now(), relayId);

    // 校验失败也不能让导入彻底失败：账号先落库，模型可重试或手动添加。
    try {
      const discovered = await this.discover(relayId);
      const models: RelayModel[] = discovered.models.map((m) => ({
        ...m,
        enabled: true,
        imageGen: m.imageGen ?? /image/i.test(m.id),
        supportsReasoning: m.supportsReasoning ?? /think|reason/i.test(m.id),
      }));
      this.importModels(relayId, models);
      this.log.info("已导入 WorkBuddy", { relayId, account: target.accountLabel, models: models.length });
    } catch (error) {
      const message = safeErrorMessage(error);
      this.storage.db
        .prepare("UPDATE relays SET health = 'error', detail = ?, updated_at = ? WHERE id = ?")
        .run(`账号已保存，但模型目录拉取失败：${message}（可稍后点「刷新模型」或手动添加模型）`, Date.now(), relayId);
      this.log.warn("WorkBuddy 账号已保存但模型拉取失败", { relayId, message });
    }
    return this.get(relayId)!;
  }

  /** 给 server 的注册表用：按 provider 找到可用账号。 */
  workbuddyAccount(): RelayAccount | undefined {
    return this.list().find((r) => r.kind === "workbuddy" && r.enabled && r.hasKey);
  }
}
