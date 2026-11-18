import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { AppSettings, Credential, LocalAccount, ProviderId } from "@super-work/core";

interface DshCredentialFile {
  version?: number;
  records?: Record<string, { kind?: string; payload?: Record<string, unknown> }>;
  refs?: Record<string, unknown>;
}

interface CacheEntry {
  mtimeMs: number;
  parsed: DshCredentialFile;
}

const cache = new Map<string, CacheEntry>();

function readDshCredentials(file: string): DshCredentialFile | null {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.parsed;
    const parsed = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as DshCredentialFile;
    cache.set(file, { mtimeMs: stat.mtimeMs, parsed });
    return parsed;
  } catch {
    return null;
  }
}

function credentialPath(settings: AppSettings): string {
  return settings.localCredentialPath?.trim() || path.join(os.homedir(), ".dsh/.credentials.yaml");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

const ENV_KEYS: Array<{ env: string; provider: ProviderId; baseUrl?: string; label: string }> = [
  { env: "DEEPSEEK_API_KEY", provider: "deepseek", label: "DeepSeek API Key（环境变量）" },
  { env: "MOONSHOT_API_KEY", provider: "kimi", label: "Moonshot API Key（环境变量）" },
  { env: "MOONSHOTAI_CN_API_KEY", provider: "kimi", label: "Moonshot Key（DSH 引用）" },
  { env: "OPENAI_API_KEY", provider: "openai", label: "OpenAI API Key（环境变量）" },
  { env: "ANTHROPIC_API_KEY", provider: "anthropic", label: "Anthropic API Key（环境变量）" },
  { env: "DASHSCOPE_API_KEY", provider: "qwen", label: "DashScope Key（环境变量）" },
  { env: "ZHIPU_API_KEY", provider: "zhipu", label: "智谱 API Key（环境变量）" },
  { env: "GLM_API_KEY", provider: "zhipu", label: "GLM API Key（环境变量）" },
  { env: "ARK_API_KEY", provider: "volcengine", label: "火山方舟 Key（环境变量）" },
  { env: "MINIMAX_API_KEY", provider: "minimax", label: "MiniMax Key（环境变量）" },
  { env: "GEMINI_API_KEY", provider: "gemini", label: "Gemini Key（环境变量）" },
  { env: "GOOGLE_API_KEY", provider: "gemini", label: "Google API Key（环境变量）" },
  { env: "XAI_API_KEY", provider: "xai", label: "xAI Key（环境变量）" },
  {
    env: "OPENROUTER_API_KEY",
    provider: "thirdparty",
    baseUrl: "https://openrouter.ai/api/v1",
    label: "OpenRouter Key（环境变量）",
  },
];

interface Materialized {
  account: LocalAccount;
  credential?: Credential;
}

function materialize(settings: AppSettings): Materialized[] {
  const out: Materialized[] = [];
  const file = credentialPath(settings);
  const dsh = settings.allowLocalReuse ? readDshCredentials(file) : null;

  if (dsh) {
    const codex = dsh.records?.["llm-pi-ai/openai-codex"]?.payload;
    const access = str(codex?.access);
    const refresh = str(codex?.refresh);
    const expiresAt = num(codex?.expires);
    const accountId = str(codex?.accountId);
    if (access) {
      const expired = expiresAt !== undefined && expiresAt < Date.now();
      out.push({
        account: {
          id: "dsh:openai-codex",
          provider: "openai",
          mode: "oauth-browser",
          label: "ChatGPT 订阅（复用 DSH 登录）",
          accountLabel: accountId ? `账号 …${accountId.slice(-6)}` : undefined,
          source: "dsh-credentials",
          expiresAt,
          usable: !expired || Boolean(refresh),
          detail: expired
            ? "access 已过期；先在 DSH 里用一条消息让它刷新，再回来重新导入"
            : "共用 DSH 登录态（不会自动刷新，过期需在 DSH 刷新后重新导入）",
        },
        credential: {
          provider: "openai",
          mode: "oauth-browser",
          source: "local",
          oauth: { access, refresh, expiresAt, accountId },
          label: "ChatGPT 订阅（DSH）",
          accountLabel: accountId ? `…${accountId.slice(-6)}` : undefined,
        },
      });
    }

    const kimiRaw = dsh.refs?.["KIMI_SUBSCRIPTION_TOKEN"];
    const kimiStr = str(kimiRaw);
    if (kimiStr) {
      try {
        const parsed = JSON.parse(kimiStr) as { access?: string; refresh?: string; expires?: number };
        const kAccess = str(parsed.access);
        if (kAccess) {
          const kExpires = num(parsed.expires);
          const expired = kExpires !== undefined && kExpires < Date.now();
          out.push({
            account: {
              id: "dsh:kimi-subscription",
              provider: "kimi",
              mode: "device-code",
              label: "Kimi 会员订阅（复用 DSH 登录）",
              source: "dsh-credentials",
              expiresAt: kExpires,
              usable: !expired || Boolean(str(parsed.refresh)),
              detail: expired
                ? "会员 token 已过期；先在 DSH 里用一条消息让它刷新，再回来重新导入"
                : "共用 DSH 登录态（不会自动刷新，过期需在 DSH 刷新后重新导入）",
            },
            credential: {
              provider: "kimi",
              mode: "device-code",
              source: "local",
              oauth: { access: kAccess, refresh: str(parsed.refresh), expiresAt: kExpires },
              label: "Kimi 会员（DSH）",
            },
          });
        }
      } catch {
        /* 忽略损坏的引用 */
      }
    }

    const deepseekKey = str(dsh.refs?.["DEEPSEEK_API_KEY"]);
    if (deepseekKey) {
      out.push({
        account: {
          id: "dsh:key:DEEPSEEK_API_KEY",
          provider: "deepseek",
          mode: "api-key",
          label: "DeepSeek API Key（DSH 引用）",
          source: "dsh-credentials",
          usable: true,
          detail: "来自 DSH 凭证引用表",
        },
        credential: {
          provider: "deepseek",
          mode: "api-key",
          source: "local",
          apiKey: deepseekKey,
          label: "DeepSeek（DSH）",
        },
      });
    }

    const moonshotKey = str(dsh.refs?.["MOONSHOTAI_CN_API_KEY"]);
    if (moonshotKey) {
      out.push({
        account: {
          id: "dsh:key:MOONSHOTAI_CN_API_KEY",
          provider: "kimi",
          mode: "api-key",
          label: "Moonshot API Key（DSH 引用）",
          source: "dsh-credentials",
          usable: true,
          detail: "来自 DSH 凭证引用表",
        },
        credential: {
          provider: "kimi",
          mode: "api-key",
          source: "local",
          apiKey: moonshotKey,
          label: "Moonshot（DSH）",
        },
      });
    }
  }

  for (const spec of ENV_KEYS) {
    const value = process.env[spec.env];
    if (!value || value.trim() === "") continue;
    const alreadyFromDsh = out.some(
      (x) => x.account.provider === spec.provider && x.credential?.mode === "api-key" && x.account.source === "dsh-credentials",
    );
    if (alreadyFromDsh) continue;
    out.push({
      account: {
        id: `env:${spec.env}`,
        provider: spec.provider,
        mode: "api-key",
        label: spec.label,
        source: "env",
        usable: true,
        detail: "来自当前进程环境变量",
      },
      credential: {
        provider: spec.provider,
        mode: "api-key",
        source: "env",
        apiKey: value.trim(),
        baseUrl: spec.baseUrl,
        label: spec.label,
      },
    });
  }

  return out;
}

export function discoverLocalAccounts(settings: AppSettings): LocalAccount[] {
  if (!settings.allowLocalReuse) return [];
  return materialize(settings).map((x) => x.account);
}

export function localAccountCredential(settings: AppSettings, localAccountId: string): Credential | undefined {
  if (!settings.allowLocalReuse) return undefined;
  const hit = materialize(settings).find((x) => x.account.id === localAccountId);
  return hit?.credential;
}

export function dshCredentialFileExists(settings: AppSettings): boolean {
  try {
    return fs.statSync(credentialPath(settings)).isFile();
  } catch {
    return false;
  }
}
