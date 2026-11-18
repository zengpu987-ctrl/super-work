import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { AppSettings, ProxyDetectResponse } from "@super-work/core";

const execFileAsync = promisify(execFile);

export interface Paths {
  home: string;
  configFile: string;
  dbFile: string;
  keyFile: string;
  memoryDb: string;
  webDist: string;
  repoRoot: string;
}

export function resolvePaths(): Paths {
  const home = process.env.SUPER_WORK_HOME?.trim() || path.join(os.homedir(), ".super-work");
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  return {
    home,
    configFile: path.join(home, "config.json"),
    dbFile: path.join(home, "super-work.db"),
    keyFile: path.join(home, "secret.key"),
    memoryDb: path.join(home, "memory.db"),
    webDist: path.join(repoRoot, "apps/web/dist"),
    repoRoot,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: "zh",
  allowLocalReuse: true,
  defaultMode: "council",
  timeoutMs: 180_000,
  localCredentialPath: path.join(os.homedir(), ".dsh/.credentials.yaml"),
};

export function loadSettings(paths: Paths): AppSettings {
  try {
    const raw = fs.readFileSync(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function normalizeSettings(s: AppSettings): AppSettings {
  const language = s.language === "en" ? "en" : "zh";
  const timeoutMs =
    typeof s.timeoutMs === "number" && s.timeoutMs >= 5_000 && s.timeoutMs <= 900_000 ? s.timeoutMs : 180_000;
  return {
    ...s,
    language,
    timeoutMs,
    allowLocalReuse: s.allowLocalReuse !== false,
    proxy: typeof s.proxy === "string" && s.proxy.trim() !== "" ? s.proxy.trim() : undefined,
  };
}

export function saveSettings(paths: Paths, settings: AppSettings): AppSettings {
  const next = normalizeSettings(settings);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const tmp = `${paths.configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.configFile);
  return next;
}

export function ensureHome(paths: Paths): void {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
}

/**
 * 让 Node 的 fetch 走代理。本机直连 OpenAI 会被地域拦截，必须走系统代理。
 * 注意：NODE_USE_ENV_PROXY 只在进程启动时读取，运行期改无效，
 * 所以这里用 undici 的 ProxyAgent 直接接管 globalThis.fetch，设置一改立即生效。
 */
let currentProxy: string | undefined;
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);
let proxyDispatcher: ProxyAgent | null = null;

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function installFetch(proxy: string | undefined): void {
  if (!proxy) {
    globalThis.fetch = nativeFetch;
    return;
  }
  proxyDispatcher = new ProxyAgent(proxy);
  const dispatcher = proxyDispatcher;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" || input instanceof URL) {
      const href = typeof input === "string" ? input : input.toString();
      if (isLoopback(href)) return nativeFetch(input as string, init);
      const requestInit = { ...(init ?? {}), dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
      return undiciFetch(href, requestInit) as unknown as Promise<Response>;
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
}

export function applyProxy(proxy: string | undefined): void {
  const p = proxy?.trim() || undefined;
  if (p === currentProxy) return;
  currentProxy = p;

  if (!p) {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NODE_USE_ENV_PROXY;
    proxyDispatcher = null;
    globalThis.fetch = nativeFetch;
    return;
  }

  process.env.HTTP_PROXY = p;
  process.env.HTTPS_PROXY = p;
  process.env.ALL_PROXY = p;
  process.env.NODE_USE_ENV_PROXY = "1";
  if (!process.env.NO_PROXY) process.env.NO_PROXY = "127.0.0.1,localhost";
  installFetch(p);
}

export function activeProxy(): string | undefined {
  return currentProxy;
}

/** 直连（不走代理）的 fetch：本地服务与图片 CDN 下载用，避免代理把国内 CDN 拦掉。 */
export function directFetch(input: string, init?: RequestInit): Promise<Response> {
  return nativeFetch(input, init) as Promise<Response>;
}

export async function detectSystemProxy(): Promise<ProxyDetectResponse> {
  const envProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (envProxy) {
    return { source: "env", httpsProxy: envProxy, suggestion: envProxy, detail: "继承自环境变量" };
  }
  if (process.platform !== "darwin") {
    return { source: "none", detail: "非 macOS，请手动填写代理地址" };
  }
  try {
    const { stdout } = await execFileAsync("scutil", ["--proxy"], { timeout: 3000 });
    const num = (key: string) => {
      const m = stdout.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
      return m ? Number(m[1]) : undefined;
    };
    const enabled = /HTTPSEnable\s*:\s*1/.test(stdout) || /HTTPEnable\s*:\s*1/.test(stdout);
    const httpsPort = num("HTTPSPort");
    const httpsHostRaw = stdout.match(/HTTPSProxy\s*:\s*(\S+)/);
    const httpPort = num("HTTPPort");
    const httpHostRaw = stdout.match(/HTTPProxy\s*:\s*(\S+)/);
    const httpsHost = httpsHostRaw?.[1];
    const httpHost = httpHostRaw?.[1];
    const suggestion = enabled
      ? `http://${httpsHost ?? httpHost ?? "127.0.0.1"}:${httpsPort ?? httpPort ?? 7890}`
      : undefined;
    if (!enabled) {
      return { source: "none", detail: "系统未配置 HTTP 代理" };
    }
    return {
      source: "system",
      httpsProxy: suggestion,
      httpProxy: httpHost && httpPort ? `http://${httpHost}:${httpPort}` : undefined,
      suggestion,
      detail: "来自 macOS 系统代理（scutil --proxy）",
    };
  } catch (error) {
    return { source: "none", detail: `读取系统代理失败：${(error as Error).message}` };
  }
}
