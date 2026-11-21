import {
  PROVIDERS,
  PROVIDER_BY_ID,
  type ChatCallOptions,
  type ChatChunk,
  type Credential,
  type ImageCallOptions,
  type ImageResult,
  type ModelInfo,
  type ModelOption,
  type ProviderId,
} from "@super-work/core";
import { adapterForCall } from "@super-work/providers";
import type { CredentialManager } from "./credentials.js";
import type { RelayStore } from "./relays.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";

export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly model: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export interface CallSpec {
  provider: ProviderId;
  model: string;
  relayId?: string;
  system?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  reasoning?: "low" | "medium" | "high";
  effort?: import("@super-work/core").EffortLevel;
  signal?: AbortSignal;
}

export class ModelRegistry {
  constructor(
    private creds: CredentialManager,
    private relays: RelayStore,
    private log: Logger,
  ) {}

  private customModels(): Partial<Record<ProviderId, ModelInfo[]>> {
    return this.creds.getSettings().customModels ?? {};
  }

  allCatalogModels(): ModelInfo[] {
    const custom = this.customModels();
    const base = PROVIDERS.flatMap((p) => {
      const extra = custom[p.id] ?? [];
      const seen = new Set(p.models.map((m) => m.id));
      return [...p.models, ...extra.filter((m) => !seen.has(m.id)).map((m) => ({ ...m, provider: p.id }))];
    });
    return [...base, ...this.relays.models(), ...this.relays.workbuddyModels()];
  }

  modelOptions(): ModelOption[] {
    const statuses = new Map<ProviderId, number>();
    for (const p of PROVIDERS) {
      statuses.set(p.id, this.creds.statuses(p.id).length);
    }
    const relayAccounts = this.relays.list().filter((r) => r.enabled && r.hasKey);
    statuses.set("relay", relayAccounts.filter((r) => r.kind !== "workbuddy").length);
    statuses.set("workbuddy", relayAccounts.filter((r) => r.kind === "workbuddy").length);

    return this.allCatalogModels().map((model) => {
      const provider = model.provider;
      const meta = PROVIDER_BY_ID[provider];
      const connections = statuses.get(provider) ?? 0;
      if (provider === "mock") return { ...model, available: true, connections: 0 };
      if (provider === "relay") {
        const relay = this.relays.resolveRelayModel(model.id);
        const available = Boolean(
          relay && relay.relay.enabled && relay.relay.models.some((m) => m.id === relay.remoteId && m.enabled),
        );
        return {
          ...model,
          available,
          connections,
          disabledReason: available ? undefined : "中转站未启用或模型未导入",
        };
      }
      if (provider === "workbuddy") {
        const account = this.relays.workbuddyAccount();
        return {
          ...model,
          available: Boolean(account),
          connections,
          disabledReason: account ? undefined : "还没有导入 WorkBuddy 账号",
        };
      }
      const resolved = this.creds.resolve(provider, model.via);
      let disabledReason: string | undefined;
      if (!resolved) {
        if (connections === 0) disabledReason = `未连接 ${meta?.name ?? provider}`;
        else if (model.via === "subscription") disabledReason = "需要订阅登录（当前只有 API Key）";
        else if (model.via === "api") disabledReason = "需要 API Key（当前只有订阅登录）";
        else disabledReason = "没有可用凭证";
      }
      return { ...model, available: Boolean(resolved), connections, disabledReason };
    });
  }

  findModel(provider: ProviderId, modelId: string): ModelInfo | undefined {
    return this.allCatalogModels().find((m) => m.provider === provider && m.id === modelId);
  }

  private resolveAdapter(
    provider: ProviderId,
    model: string,
  ): { adapter: ReturnType<typeof adapterForCall>; cred: Credential; remoteModel: string } {
    if (provider === "relay") {
      const hit = this.relays.resolveRelayModel(model);
      if (!hit) throw new ProviderCallError(`中转站模型不可用：${model}（可能未导入或站点已禁用）`, provider, model);
      const cred = this.relays.credentialFor(hit.relay);
      if (!cred) throw new ProviderCallError(`${hit.relay.name} 没有可用的 API Key`, provider, model);
      return { adapter: adapterForCall("relay", cred), cred, remoteModel: hit.remoteId };
    }
    if (provider === "workbuddy") {
      const account = this.relays.workbuddyAccount();
      if (!account) throw new ProviderCallError("还没有导入 WorkBuddy 账号，请到设置 → 中转站导入", provider, model);
      const cred = this.relays.credentialFor(account);
      if (!cred) throw new ProviderCallError("WorkBuddy 凭证不可用，请重新导入", provider, model);
      return { adapter: adapterForCall("workbuddy", cred), cred, remoteModel: model };
    }
    throw new ProviderCallError(`不是中转站平台：${provider}`, provider, model);
  }

  async *chat(spec: CallSpec): AsyncGenerator<ChatChunk> {
    const meta = PROVIDER_BY_ID[spec.provider];
    if (!meta) throw new ProviderCallError(`未知模型平台：${spec.provider}`, spec.provider, spec.model);

    if (spec.provider === "mock") {
      const adapter = adapterForCall("mock", null);
      yield* adapter.chat(this.toOptions(spec), null);
      return;
    }

    if (spec.provider === "relay" || spec.provider === "workbuddy") {
      const resolved = this.resolveAdapter(spec.provider, spec.model);
      try {
        yield* resolved.adapter.chat(this.toOptions({ ...spec, model: resolved.remoteModel }, resolved.cred.baseUrl), resolved.cred);
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        const message = safeErrorMessage(error);
        this.log.warn("中转站调用失败", { provider: spec.provider, model: spec.model, message });
        throw new ProviderCallError(message, spec.provider, spec.model, error);
      }
      return;
    }

    const modelInfo = this.findModel(spec.provider, spec.model);
    const resolved = this.creds.resolve(spec.provider, modelInfo?.via);
    if (!resolved) {
      throw new ProviderCallError(
        `${meta.name} / ${spec.model} 没有可用凭证：请先在设置里连接该平台`,
        spec.provider,
        spec.model,
      );
    }

    let credential: Credential;
    try {
      credential = await this.creds.fresh(resolved);
    } catch (error) {
      throw new ProviderCallError(safeErrorMessage(error), spec.provider, spec.model, error);
    }

    let adapter = adapterForCall(spec.provider, credential);
    let credentialNow = credential;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        yield* adapter.chat(this.toOptions(spec, credentialNow.baseUrl), credentialNow);
        return;
      } catch (error) {
        lastError = error;
        if ((error as Error)?.name === "AbortError") throw error;
        const message = safeErrorMessage(error);
        const looksExpired = /401|403|unauthor|invalid[_ ]?token|refresh token|expired/i.test(message);
        const status = Number((error as { status?: number }).status ?? 0);
        const transient = status === 429 || (status >= 500 && status < 600);
        if (looksExpired && attempt === 0) {
          const refreshed = await this.creds.forceRefresh(resolved);
          if (refreshed) {
            credentialNow = refreshed;
            adapter = adapterForCall(spec.provider, refreshed);
            this.log.info("凭证已刷新，重试模型调用", { provider: spec.provider, model: spec.model });
            continue;
          }
        }
        if (transient && attempt === 0) {
          this.log.warn("上游临时错误，1.2s 后重试一次", { provider: spec.provider, model: spec.model, status });
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }
        const hint =
          looksExpired && resolved.row.source !== "user"
            ? "（本机复用的登录可能已过期：先在 DSH 里用一次让它刷新，或在本应用里用订阅登录重新授权）"
            : "";
        this.log.warn("模型调用失败", { provider: spec.provider, model: spec.model, message });
        throw new ProviderCallError(message + hint, spec.provider, spec.model, error);
      }
    }
    throw new ProviderCallError(safeErrorMessage(lastError), spec.provider, spec.model, lastError);
  }

  async generateImage(spec: {
    provider: ProviderId;
    model: string;
    prompt: string;
    size?: string;
    signal?: AbortSignal;
  }): Promise<ImageResult> {
    if (spec.provider !== "workbuddy") {
      throw new ProviderCallError(
        "生图角色目前只支持 WorkBuddy 图像模型（在设置 → 中转站导入）",
        spec.provider,
        spec.model,
      );
    }
    const { adapter, cred, remoteModel } = this.resolveAdapter("workbuddy", spec.model);
    if (!adapter.generateImage) {
      throw new ProviderCallError("该模型不支持生图", spec.provider, spec.model);
    }
    const options: ImageCallOptions = {
      model: remoteModel,
      prompt: spec.prompt,
      size: spec.size,
      signal: spec.signal,
    };
    return adapter.generateImage(options, cred);
  }

  private toOptions(spec: CallSpec, baseUrl?: string): ChatCallOptions {
    const messages = spec.system
      ? [{ role: "system" as const, content: spec.system }, ...spec.messages.filter((m) => m.role !== "system")]
      : spec.messages;
    return {
      provider: spec.provider,
      model: spec.model,
      messages,
      system: spec.system,
      maxTokens: spec.maxTokens,
      temperature: spec.temperature,
      reasoning: spec.reasoning,
      effort: spec.effort,
      signal: spec.signal,
      baseUrl,
    };
  }

  /** 中转站/WorkBuddy 账号也映射成连接状态，供设置页与左栏展示。 */
  relayConnections(provider: "relay" | "workbuddy"): import("@super-work/core").ConnectionStatus[] {
    return this.relays
      .list()
      .filter((r) => r.enabled && (provider === "workbuddy" ? r.kind === "workbuddy" : r.kind !== "workbuddy"))
      .map((r) => ({
        id: r.id,
        provider,
        mode: r.kind === "workbuddy" ? ("local" as const) : ("api-key" as const),
        source: r.source === "local" ? ("local" as const) : ("user" as const),
        label: r.name,
        accountLabel: r.accountLabel,
        healthy: r.health !== "error",
        modelCount: r.models.filter((m) => m.enabled).length,
        detail: r.detail,
      }));
  }

  summary(): Array<{ provider: ProviderId; connections: number; models: number }> {
    return PROVIDERS.map((p) => ({
      provider: p.id,
      connections:
        p.id === "relay"
          ? this.relays.list().filter((r) => r.enabled && r.kind !== "workbuddy").length
          : p.id === "workbuddy"
            ? this.relays.list().filter((r) => r.enabled && r.kind === "workbuddy").length
            : this.creds.statuses(p.id).length,
      models:
        p.id === "relay"
          ? this.relays.models().length
          : p.id === "workbuddy"
            ? this.relays.workbuddyModels().length
            : p.models.length,
    }));
  }
}
