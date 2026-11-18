import os from "node:os";
import { randomUUID } from "node:crypto";
import type { OAuthToken } from "@super-work/core";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_AUTH_BASE = "https://auth.kimi.com";
const DEVICE_AUTH_URL = `${KIMI_AUTH_BASE}/api/oauth/device_authorization`;
const TOKEN_URL = `${KIMI_AUTH_BASE}/api/oauth/token`;

let deviceId: string | undefined;

/** Kimi 会员接口要求的 CLI 归属头。 */
export function kimiHeaders(): Record<string, string> {
  if (!deviceId) deviceId = randomUUID().replace(/-/g, "");
  return {
    "User-Agent": "KimiCLI/1.0",
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": "1.0",
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": `${os.platform()} ${os.release()} ${os.arch()}`,
    "X-Msh-Os-Version": os.release(),
    "X-Msh-Device-Id": deviceId,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...kimiHeaders(),
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json, text };
}

export interface KimiDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export async function startKimiDeviceAuth(): Promise<KimiDeviceAuth> {
  const { status, json, text } = await postForm(DEVICE_AUTH_URL, { client_id: KIMI_CLIENT_ID });
  if (status >= 400 || typeof json.device_code !== "string") {
    throw new Error(`Kimi 设备授权申请失败（HTTP ${status}）：${text.slice(0, 240)}`);
  }
  return {
    deviceCode: String(json.device_code),
    userCode: String(json.user_code ?? ""),
    verificationUri: String(json.verification_uri ?? ""),
    verificationUriComplete: String(json.verification_uri_complete ?? json.verification_uri ?? ""),
    expiresInSeconds: typeof json.expires_in === "number" ? json.expires_in : 600,
    intervalSeconds: typeof json.interval === "number" ? json.interval : 5,
  };
}

function toToken(json: Record<string, unknown>, fallbackRefresh?: string): OAuthToken {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (!access) throw new Error("Kimi 令牌响应缺少 access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  return {
    access,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: typeof json.token_type === "string" ? json.token_type : "Bearer",
    scope: typeof json.scope === "string" ? json.scope : undefined,
    accountLabel: "Kimi 会员",
  };
}

export type KimiPollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "complete"; token: OAuthToken }
  | { status: "failed"; message: string };

export async function pollKimiDeviceToken(deviceCode: string): Promise<KimiPollResult> {
  const { status, json, text } = await postForm(TOKEN_URL, {
    client_id: KIMI_CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (typeof json.access_token === "string") return { status: "complete", token: toToken(json) };
  const err = typeof json.error === "string" ? json.error : "";
  if (err === "authorization_pending") return { status: "pending" };
  if (err === "slow_down") return { status: "slow_down" };
  if (err === "expired_token" || err === "access_denied") {
    return { status: "failed", message: `设备授权失败：${err}` };
  }
  if (status >= 500) return { status: "pending" };
  if (status >= 400) return { status: "failed", message: `令牌轮询失败（HTTP ${status}）：${text.slice(0, 200)}` };
  return { status: "pending" };
}

export async function refreshKimiToken(refresh: string): Promise<OAuthToken> {
  const { status, json, text } = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: KIMI_CLIENT_ID,
  });
  if (typeof json.access_token !== "string") {
    throw new Error(`Kimi 刷新令牌失败（HTTP ${status}）：${text.slice(0, 200)}`);
  }
  return toToken(json, refresh);
}
