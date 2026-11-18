import crypto from "node:crypto";
import type {
  AuthFlowPollResponse,
  AuthFlowStart,
  AuthMode,
  AuthStartResponse,
  ConnectionStatus,
  Credential,
  ProviderId,
} from "@super-work/core";
import { exchangeOpenAICode, startChatGptLogin } from "./openai.js";
import { pollKimiDeviceToken, refreshKimiToken, startKimiDeviceAuth } from "./kimi.js";
import type { Logger } from "../log.js";
import { safeErrorMessage } from "../log.js";

interface FlowDeps {
  saveCredential: (cred: Credential) => ConnectionStatus;
  log: Logger;
}

type FlowStatus =
  | { status: "pending"; note?: string }
  | { status: "done"; connection: ConnectionStatus }
  | { status: "error"; message: string }
  | { status: "expired" };

interface FlowState {
  id: string;
  provider: ProviderId;
  mode: AuthMode;
  kind: AuthFlowStart["kind"];
  createdAt: number;
  expiresAt: number;
  status: FlowStatus;
  authorizeUrl?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
  note?: string;
  cancel?: () => void;
}

const FLOW_TTL_MS = 15 * 60 * 1000;

export class AuthFlowManager {
  private flows = new Map<string, FlowState>();

  constructor(private deps: FlowDeps) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      if (now - flow.createdAt > FLOW_TTL_MS) {
        if (flow.status.status === "pending") flow.status = { status: "expired" };
        flow.cancel?.();
        if (now - flow.createdAt > FLOW_TTL_MS * 2) this.flows.delete(id);
      }
    }
  }

  peek(flowId: string): FlowState | undefined {
    return this.flows.get(flowId);
  }

  async start(provider: ProviderId, mode: AuthMode): Promise<AuthStartResponse> {
    if (provider === "openai" && mode === "oauth-browser") return this.startOpenAI();
    if (provider === "kimi" && mode === "device-code") return this.startKimi();
    throw new Error(
      provider === "openai" || provider === "kimi"
        ? `不支持的登录方式：${mode}`
        : "该平台暂未开放官方订阅登录，请在「本机复用」或「粘贴凭证」里接入。",
    );
  }

  private startOpenAI(): AuthStartResponse {
    const id = `flow_${crypto.randomBytes(8).toString("hex")}`;
    const login = startChatGptLogin();
    const flow: FlowState = {
      id,
      provider: "openai",
      mode: "oauth-browser",
      kind: "oauth-browser",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
      status: { status: "pending", note: "等待浏览器完成 ChatGPT 授权…" },
      authorizeUrl: login.authorizeUrl,
      note: "已弹出浏览器授权页；完成后此窗口会自动变为已连接。",
      cancel: login.close,
    };
    this.flows.set(id, flow);

    void (async () => {
      try {
        const code = await login.waitForCode;
        flow.status = { status: "pending", note: "授权码已收到，正在换取令牌…" };
        const token = await exchangeOpenAICode(code, login.verifier);
        const credential: Credential = {
          provider: "openai",
          mode: "oauth-browser",
          source: "user",
          oauth: token,
          label: "ChatGPT 订阅",
          accountLabel: token.accountLabel ?? (token.accountId ? `…${token.accountId.slice(-6)}` : undefined),
        };
        const connection = this.deps.saveCredential(credential);
        flow.status = { status: "done", connection };
        this.deps.log.info("ChatGPT 订阅登录成功", { account: credential.accountLabel });
      } catch (error) {
        flow.status = { status: "error", message: safeErrorMessage(error) };
        this.deps.log.warn("ChatGPT 登录失败", { message: safeErrorMessage(error) });
      } finally {
        flow.cancel = undefined;
      }
    })();

    return this.toStart(flow);
  }

  /**
   * 把设备码同时打印到启动服务的终端：
   * 有些人是从终端启动、或 UI 在另一块屏幕上，需要直接在终端看到码。
   */
  private printKimiDeviceCode(device: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresInSeconds: number;
  }): void {
    const url = device.verificationUriComplete || device.verificationUri;
    const minutes = Math.max(1, Math.round(device.expiresInSeconds / 60));
    console.log(
      [
        "",
        "==============================================",
        " Kimi 设备码登录",
        ` 设备码：${device.userCode || "(未返回)"}`,
        ` 验证地址：${url || "(未返回)"}`,
        ` 有效期：约 ${minutes} 分钟；在浏览器输入设备码并确认即可`,
        " （这段同时显示在应用「设置 → KIMI → 订阅登录」里）",
        "==============================================",
        "",
      ].join("\n"),
    );
  }

  private async startKimi(): Promise<AuthStartResponse> {
    const device = await startKimiDeviceAuth();
    const id = `flow_${crypto.randomBytes(8).toString("hex")}`;
    const flow: FlowState = {
      id,
      provider: "kimi",
      mode: "device-code",
      kind: "device-code",
      createdAt: Date.now(),
      expiresAt: Date.now() + device.expiresInSeconds * 1000,
      status: { status: "pending", note: "等待你在 Kimi 页面确认登录…" },
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresInSeconds: device.expiresInSeconds,
      intervalSeconds: device.intervalSeconds,
      note: "在浏览器打开验证链接，输入下方设备码完成登录。",
    };
    this.flows.set(id, flow);
    this.printKimiDeviceCode(device);
    this.deps.log.info("Kimi 设备码已生成", {
      userCode: device.userCode,
      verificationUri: device.verificationUriComplete || device.verificationUri,
    });

    let cancelled = false;
    flow.cancel = () => {
      cancelled = true;
    };

    void (async () => {
      let intervalMs = Math.max(1000, device.intervalSeconds * 1000);
      try {
        while (!cancelled && Date.now() < flow.expiresAt) {
          const result = await pollKimiDeviceToken(device.deviceCode);
          if (cancelled) return;
          if (result.status === "complete") {
            const credential: Credential = {
              provider: "kimi",
              mode: "device-code",
              source: "user",
              oauth: result.token,
              label: "Kimi 会员订阅",
              accountLabel: result.token.accountLabel,
            };
            const connection = this.deps.saveCredential(credential);
            flow.status = { status: "done", connection };
            this.deps.log.info("Kimi 会员登录成功");
            return;
          }
          if (result.status === "failed") {
            flow.status = { status: "error", message: result.message };
            this.deps.log.warn("Kimi 设备码授权失败", { message: result.message });
            return;
          }
          if (result.status === "slow_down") intervalMs += 5000;
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        if (flow.status.status === "pending") flow.status = { status: "expired" };
      } catch (error) {
        flow.status = { status: "error", message: safeErrorMessage(error) };
      }
    })();

    return this.toStart(flow);
  }

  private toStart(flow: FlowState): AuthStartResponse {
    return {
      flowId: flow.id,
      kind: flow.kind,
      provider: flow.provider,
      authorizeUrl: flow.authorizeUrl,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      verificationUriComplete: flow.verificationUriComplete,
      expiresInSeconds: flow.expiresInSeconds,
      intervalSeconds: flow.intervalSeconds,
      note: flow.note,
    };
  }

  poll(provider: ProviderId, flowId: string): AuthFlowPollResponse {
    const flow = this.flows.get(flowId);
    if (!flow || flow.provider !== provider) {
      return { flowId, provider, status: "error", message: "登录流程不存在或已过期" };
    }
    if (flow.status.status === "pending" && Date.now() > flow.expiresAt) {
      flow.status = { status: "expired" };
    }
    return { flowId, provider, ...flow.status } as AuthFlowPollResponse;
  }

  cancel(provider: ProviderId, flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.provider !== provider) return;
    flow.cancel?.();
    if (flow.status.status === "pending") flow.status = { status: "error", message: "已取消登录" };
    this.flows.delete(flowId);
  }
}

export { refreshKimiToken };
