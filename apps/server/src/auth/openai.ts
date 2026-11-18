import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthToken } from "@super-work/core";

/** 与 Codex CLI 一致的公开 PKCE 客户端（ChatGPT 订阅登录）。 */
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_BASE = "https://auth.openai.com";
export const OPENAI_CALLBACK_PORT = 1455;
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "super_work";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwt(token?: string): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function claimsOf(token?: string): Record<string, unknown> | undefined {
  const payload = decodeJwt(token);
  if (!payload) return undefined;
  const nested = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return { ...nested, ...payload };
}

function accountFromTokens(idToken?: string, access?: string): { accountId?: string; email?: string } {
  const claims = claimsOf(idToken) ?? claimsOf(access) ?? {};
  const accountId =
    (claims["chatgpt_account_id"] as string | undefined) ??
    ((claims["organizations"] as Array<{ id?: string }> | undefined)?.[0]?.id as string | undefined);
  const email = (claims["email"] as string | undefined) ?? undefined;
  return { accountId, email };
}

export function buildAuthorizeUrl(state: string, challenge: string, port = OPENAI_CALLBACK_PORT): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: `http://localhost:${port}/auth/callback`,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  });
  return `${OPENAI_AUTH_BASE}/oauth/authorize?${params.toString()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ChatGptLogin {
  authorizeUrl: string;
  /** PKCE verifier，换令牌时要用 */
  verifier: string;
  /** 等到浏览器回调后 resolve 出授权码 */
  waitForCode: Promise<string>;
  close: () => void;
}

export function startChatGptLogin(port = OPENAI_CALLBACK_PORT): ChatGptLogin {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl(state, challenge, port);

  let server: Server | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    server?.close();
  };

  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCode(err);
  };

  const done = (code: string) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveCode(code);
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>登录失败</h1><p>${escapeHtml(error)}</p>`);
      fail(new Error(`ChatGPT 授权失败：${error}`));
      return;
    }
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>缺少授权码</h1>");
      return;
    }
    if (gotState !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>state 不匹配</h1>");
      fail(new Error("OAuth state 不匹配，可能被伪造，已中止"));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>登录成功</title>
       <div style="font-family:system-ui;background:#0a0b10;color:#e6e8ef;height:100vh;display:grid;place-items:center">
         <div style="text-align:center"><h1>登录成功 ✅</h1><p>可以关闭此页面，回到 Super Work 继续。</p></div>
       </div>`,
    );
    done(code);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      fail(
        new Error(
          `本地回调端口 ${port} 被占用（可能 codex CLI 正在登录，或上一次授权没关）。关掉后重试。`,
        ),
      );
    } else {
      fail(new Error(`启动本地回调服务失败：${err.message}`));
    }
  });

  server.listen(port, "127.0.0.1");
  timer = setTimeout(() => fail(new Error("ChatGPT 授权超时（10 分钟未完成）")), 10 * 60 * 1000);

  void waitForCode.finally(() => {
    /* 保证 server 关闭 */
    if (settled) cleanup();
  });

  return {
    authorizeUrl,
    verifier,
    waitForCode,
    close: () => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectCode(new Error("登录已取消"));
      }
    },
  };
}

export async function exchangeOpenAICode(code: string, verifier: string, port = OPENAI_CALLBACK_PORT): Promise<OAuthToken> {
  const res = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `http://localhost:${port}/auth/callback`,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ChatGPT 换取令牌失败（HTTP ${res.status}）：${text.slice(0, 240)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new Error("ChatGPT 令牌响应缺少 access_token");
  const { accountId, email } = accountFromTokens(json.id_token, json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 600) * 1000,
    accountId,
    accountLabel: email,
    tokenType: "Bearer",
    scope: json.scope,
  };
}

export async function refreshOpenAIToken(refresh: string): Promise<OAuthToken> {
  const res = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ChatGPT 刷新令牌失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error("刷新响应缺少 access_token");
  const { accountId, email } = accountFromTokens(json.id_token, json.access_token);
  return {
    access: json.access_token,
    refresh: json.refresh_token ?? refresh,
    expiresAt: Date.now() + (json.expires_in ?? 600) * 1000,
    accountId,
    accountLabel: email,
    tokenType: "Bearer",
  };
}
