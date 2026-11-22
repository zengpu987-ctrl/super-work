/**
 * Super Work Web — 类型化 HTTP / SSE 客户端。
 *
 * 所有请求都打到同源 `/api`（开发时由 Vite 代理到 http://127.0.0.1:7788）。
 * 错误统一抛 ApiError（含 message），便于 UI 统一展示。
 * SSE 一律使用 fetch + ReadableStream 手工解析 `data:` 行：
 * EventSource 不能带自定义头、会静默重连、无法感知服务端关闭，不适合工作台。
 */
import type {
  AppSettings,
  AttachmentInput,
  AttachmentKind,
  AttachmentMeta,
  AuthStartRequest,
  AuthStartResponse,
  AuthFlowPollResponse,
  BillingSummary,
  BudgetSettings,
  BudgetUsage,
  ConnectRequest,
  ConnectionStatus,
  ContextRunSummary,
  CreateRunRequest,
  DiagnosticsResponse,
  DshMemorySeed,
  EffortLevel,
  LocalImportRequest,
  MemoryCreateRequest,
  MemoryEntry,
  MemoryHit,
  MemorySpace,
  MemoryStats,
  MemoryUpdateRequest,
  ModelPrice,
  ModelsResponse,
  PluginInfo,
  PluginTestResult,
  ProviderStatus,
  RelayAccount,
  RelayCreateRequest,
  RelayDiscoverResponse,
  RelayModel,
  RelayPreset,
  RelayUpdateRequest,
  RunDetail,
  RunEvent,
  RunListItem,
  RunStreamEvent,
  ThreadDetail,
  ThreadSummary,
  UploadResponse,
  WorkflowCreateRequest,
  WorkflowDef,
  WorkflowRun,
  WorkflowRunRequest,
} from "@super-work/core";

/** 统一错误：message 已是可直接展示给用户的中文文案。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, init: { code?: string; status?: number; detail?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = init.code ?? "unknown";
    this.status = init.status ?? 0;
    this.detail = init.detail;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function errorMessage(value: unknown): string {
  if (value instanceof ApiError) return value.message;
  if (value instanceof Error) return value.message;
  return String(value ?? "未知错误");
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SERVICE_HINT = "本机服务（127.0.0.1:7788）";

type RequestInitWithTimeout = RequestInit & { timeoutMs?: number };

async function readErrorBody(res: Response): Promise<{ code?: string; message?: string; detail?: string }> {
  try {
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; detail?: string } };
    if (parsed?.error) {
      return { code: parsed.error.code, message: parsed.error.message, detail: parsed.error.detail };
    }
    return { message: text.slice(0, 300) };
  } catch {
    return {};
  }
}

async function toHttpError(res: Response): Promise<ApiError> {
  const body = await readErrorBody(res);
  const fallback =
    res.status === 404
      ? "接口不存在（可能是服务端版本较旧）"
      : res.status === 409
        ? "操作冲突，请刷新后重试"
        : res.status >= 500
          ? "服务端内部错误"
          : "请求被拒绝";
  return new ApiError(body.message ?? `${fallback}（HTTP ${res.status}）`, {
    code: body.code ?? `http_${res.status}`,
    status: res.status,
    detail: body.detail,
  });
}

async function request<T>(path: string, init: RequestInitWithTimeout = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, headers, ...rest } = init;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const forwardAbort = () => ctrl.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const res = await fetch(path, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...(headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw await toHttpError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (timedOut) {
      throw new ApiError(`请求超时，请确认${SERVICE_HINT}是否在运行`, { code: "timeout" });
    }
    throw new ApiError(`无法连接${SERVICE_HINT}`, {
      code: "network",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function jsonBody(body: unknown): string {
  return JSON.stringify(body ?? {});
}

/* ---------------------------------------------------------------- health / settings */

export function getHealth(
  signal?: AbortSignal,
): Promise<{ ok: boolean; version: string; webBuild?: number }> {
  return request<{ ok: boolean; version: string; webBuild?: number }>("/api/health", {
    signal,
    timeoutMs: 5_000,
  });
}

export function getDiagnostics(signal?: AbortSignal): Promise<DiagnosticsResponse> {
  return request<DiagnosticsResponse>("/api/diagnostics", { signal, timeoutMs: 8_000 });
}

export function getSettings(signal?: AbortSignal): Promise<AppSettings> {
  return request<AppSettings>("/api/settings", { signal });
}

/** PUT /api/settings —— 服务端可能返回最新 AppSettings，也可能只返回 {ok}。 */
export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const res = await request<AppSettings | { ok?: boolean }>("/api/settings", {
    method: "PUT",
    body: jsonBody(settings),
  });
  return res && typeof res === "object" && "language" in res ? (res as AppSettings) : settings;
}

/* ---------------------------------------------------------------- providers */

export function listProviders(signal?: AbortSignal): Promise<ProviderStatus[]> {
  return request<ProviderStatus[]>("/api/providers", { signal });
}

/** 服务端可能返回裸 ConnectionStatus，也可能包成 { status, warning }（v0.0.1 实现在后者）。 */
export type ConnectionResult = ConnectionStatus & { warning?: string };

export function normalizeConnection(raw: unknown): ConnectionResult {
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const nested = rec.status;
    if (nested && typeof nested === "object" && "provider" in (nested as object)) {
      return {
        ...(nested as ConnectionStatus),
        warning: typeof rec.warning === "string" ? rec.warning : undefined,
      };
    }
    if ("provider" in rec && "id" in rec) {
      return rec as unknown as ConnectionResult;
    }
  }
  throw new ApiError("服务端返回的连接状态格式无法识别", { code: "bad_response" });
}

export async function connectProvider(
  providerId: string,
  body: ConnectRequest & { skipValidation?: boolean },
): Promise<ConnectionResult> {
  const raw = await request<unknown>(`/api/providers/${encodeURIComponent(providerId)}/connect`, {
    method: "POST",
    body: jsonBody(body),
    timeoutMs: 60_000,
  });
  return normalizeConnection(raw);
}

export function deleteConnection(providerId: string, connectionId: string): Promise<void> {
  return request<void>(
    `/api/providers/${encodeURIComponent(providerId)}/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
}

export async function importLocalAccount(
  providerId: string,
  body: LocalImportRequest,
): Promise<ConnectionResult> {
  const raw = await request<unknown>(`/api/providers/${encodeURIComponent(providerId)}/import-local`, {
    method: "POST",
    body: jsonBody(body),
    timeoutMs: 30_000,
  });
  return normalizeConnection(raw);
}

export function startAuthFlow(providerId: string, body: AuthStartRequest): Promise<AuthStartResponse> {
  return request<AuthStartResponse>(`/api/providers/${encodeURIComponent(providerId)}/auth/start`, {
    method: "POST",
    body: jsonBody(body),
    timeoutMs: 30_000,
  });
}

export function pollAuthFlow(providerId: string, flowId: string): Promise<AuthFlowPollResponse> {
  return request<AuthFlowPollResponse>(
    `/api/providers/${encodeURIComponent(providerId)}/auth/${encodeURIComponent(flowId)}`,
    { timeoutMs: 10_000 },
  );
}

export function cancelAuthFlow(providerId: string, flowId: string): Promise<void> {
  return request<void>(
    `/api/providers/${encodeURIComponent(providerId)}/auth/${encodeURIComponent(flowId)}/cancel`,
    { method: "POST" },
  );
}

/** GET /api/proxy/detect —— v0.0.1 服务端可能未实现，404 时调用方退回手动填写。 */
export interface ProxyDetectResponse {
  proxy?: string | null;
  detail?: string;
  candidates?: string[];
}

export function detectProxy(): Promise<ProxyDetectResponse> {
  return request<ProxyDetectResponse>("/api/proxy/detect", { timeoutMs: 10_000 });
}

/* ---------------------------------------------------------------- models */

export function listModels(signal?: AbortSignal): Promise<ModelsResponse> {
  return request<ModelsResponse>("/api/models", { signal, timeoutMs: 20_000 });
}

/* ---------------------------------------------------------------- runs */

export function createRun(body: CreateRunRequest): Promise<{ id: string; run?: RunDetail }> {
  return request<{ id: string; run?: RunDetail }>("/api/runs", {
    method: "POST",
    body: jsonBody(body),
    timeoutMs: 30_000,
  });
}

export function listRuns(limit = 30, signal?: AbortSignal): Promise<RunListItem[]> {
  return request<RunListItem[]>(`/api/runs?limit=${encodeURIComponent(String(limit))}`, { signal });
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`, { signal });
}

/** 多轮对话：一个工作（线程）的列表。archived=true 时包含归档。 */
export function listThreads(limit = 30, archived = false, signal?: AbortSignal): Promise<ThreadSummary[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (archived) q.set("archived", "1");
  return request<ThreadSummary[]>(`/api/threads?${q.toString()}`, { signal });
}

/** 多轮对话：一个工作的全部轮次。 */
export function getThread(threadId: string, signal?: AbortSignal): Promise<ThreadDetail> {
  return request<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`, { signal });
}

export function archiveThread(threadId: string, archived = true): Promise<{ thread: ThreadSummary }> {
  return request<{ thread: ThreadSummary }>(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
    method: "POST",
    body: jsonBody({ archived }),
  });
}

export function deleteThread(threadId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
}

export function saveThreadMemory(threadId: string, memory: string): Promise<{ thread: ThreadSummary }> {
  return request<{ thread: ThreadSummary }>(`/api/threads/${encodeURIComponent(threadId)}/memory`, {
    method: "PUT",
    body: jsonBody({ memory }),
  });
}

export function branchThread(threadId: string, fromRunId?: string): Promise<ThreadDetail> {
  return request<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/branch`, {
    method: "POST",
    body: jsonBody({ fromRunId }),
  });
}

export function cancelRun(runId: string): Promise<void> {
  return request<void>(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/* ---------------------------------------------------------------- SSE */

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface RunStreamHandlers {
  onSnapshot?: (run: RunDetail) => void;
  onEvent?: (event: RunEvent) => void;
  onStatus?: (status: StreamStatus, detail?: string) => void;
  onError?: (error: ApiError) => void;
  /** reason=done：收到 run.done；eof：服务端提前关闭；failed：连接彻底失败 */
  onClose?: (reason: "done" | "eof" | "failed" | "aborted") => void;
}

export interface RunStreamHandle {
  close(): void;
}

const RUN_EVENT_TYPES = new Set<RunEvent["type"]>([
  "run.start",
  "stage",
  "model.start",
  "model.delta",
  "model.done",
  "model.error",
  "final.delta",
  "final",
  "notice",
  "run.done",
  "run.error",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunEvent(value: unknown): value is RunEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    RUN_EVENT_TYPES.has((value as { type: RunEvent["type"] }).type)
  );
}

/**
 * 解析一个 SSE data 载荷，返回是否已收到 run.done。
 * 兼容三种封装：`{type:'snapshot'|'event'}`、裸 RunEvent、`{event:RunEvent}`。
 */
interface StreamCursor {
  lastSeq?: number;
  /** 已收到 run.done / run.error —— 流属于正常终结，不应重连。 */
  terminal?: boolean;
}

function noteSeq(cursor: StreamCursor | undefined, value: unknown): void {
  if (cursor && typeof value === "number" && Number.isFinite(value)) {
    cursor.lastSeq = Math.max(cursor.lastSeq ?? -1, Math.trunc(value));
  }
}

function dispatchPayload(
  data: string,
  eventName: string,
  handlers: RunStreamHandlers,
  cursor?: StreamCursor,
): boolean {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return trimmed === "[DONE]";

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;

  const rec = parsed as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";
  // 事件可能包着 seq（服务端用于断线重连 after=），三种封装都试着取。
  noteSeq(cursor, rec.seq);
  if (rec.event && typeof rec.event === "object") {
    noteSeq(cursor, (rec.event as Record<string, unknown>).seq);
  }

  if (type === "snapshot") {
    const run = (rec.run ?? parsed) as RunDetail;
    handlers.onSnapshot?.(run);
    return false;
  }
  if (type === "event") {
    const event = rec.event;
    if (isRunEvent(event)) {
      if (event.type === "run.done" || event.type === "run.error") {
        if (cursor) cursor.terminal = true;
      }
      handlers.onEvent?.(event);
      return event.type === "run.done";
    }
    return false;
  }
  if (isRunEvent(parsed)) {
    if (parsed.type === "run.done" || parsed.type === "run.error") {
      if (cursor) cursor.terminal = true;
    }
    handlers.onEvent?.(parsed);
    return parsed.type === "run.done";
  }
  if (eventName === "snapshot" && rec.run) {
    handlers.onSnapshot?.(rec.run as RunDetail);
    return false;
  }
  if (rec.event && isRunEvent(rec.event)) {
    if (rec.event.type === "run.done" || rec.event.type === "run.error") {
      if (cursor) cursor.terminal = true;
    }
    handlers.onEvent?.(rec.event);
    return rec.event.type === "run.done";
  }
  // 有些实现会发 {type:'run', snapshot:...} / {kind:'snapshot', ...}
  if (rec.snapshot && typeof rec.snapshot === "object") {
    const snap = (rec.snapshot as { run?: RunDetail }).run ?? (rec.snapshot as RunDetail);
    if (snap && typeof (snap as RunDetail).id === "string") handlers.onSnapshot?.(snap);
  }
  return false;
}

/** 连接一次 SSE，读到服务端关闭为止；返回是否已正常收到 run.done。 */
async function readRunStream(
  runId: string,
  handlers: RunStreamHandlers,
  signal: AbortSignal,
  cursor: StreamCursor,
): Promise<boolean> {
  const after = cursor.lastSeq;
  const query = typeof after === "number" ? `?after=${encodeURIComponent(String(after))}` : "";
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stream${query}`, {
    method: "GET",
    headers: { accept: "text/event-stream" },
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw await toHttpError(res);
  if (!res.body) throw new ApiError("服务端没有返回流式数据", { code: "stream_empty" });

  handlers.onStatus?.("open");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let currentEvent = "";
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) {
      currentEvent = "";
      return;
    }
    const data = dataLines.join("\n");
    const done = dispatchPayload(data, currentEvent, handlers, cursor);
    sawDone = sawDone || done;
    dataLines = [];
    currentEvent = "";
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 只保留 \n 作为分隔，SSE 的 \r\n 归一化（JSON 内的 \r 一定是转义形式）。
      buffer = buffer.replace(/\r/g, "");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          const line = rawLine;
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value2 = colon === -1 ? "" : line.slice(colon + 1);
          if (value2.startsWith(" ")) value2 = value2.slice(1);
          if (field === "event") currentEvent = value2;
          else if (field === "data") dataLines.push(value2);
          else if (field === "id" && cursor.lastSeq === undefined && /^\d+$/.test(value2)) {
            noteSeq(cursor, Number(value2));
          }
        }
        flush();
        sep = buffer.indexOf("\n\n");
      }
    }
    // 流结束时若还有半帧，尝试解析。
    if (dataLines.length > 0) flush();
    return sawDone;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 打开运行事件流，自动重连一次。
 * 调用方拿到的 handle.close() 会终止内部 AbortController。
 */
export function openRunStream(
  runId: string,
  handlers: RunStreamHandlers,
  options: { signal?: AbortSignal } = {},
): RunStreamHandle {
  const inner = new AbortController();
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    inner.abort();
    options.signal?.removeEventListener("abort", stop);
  };
  const onOuterAbort = (): void => stop();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  void (async () => {
    let attempt = 0;
    const cursor: StreamCursor = {};
    for (;;) {
      if (stopped) return;
      handlers.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const sawDone = await readRunStream(runId, handlers, inner.signal, cursor);
        if (stopped) return;
        if (sawDone || cursor.terminal) {
          handlers.onStatus?.("closed");
          handlers.onClose?.("done");
          return;
        }
      } catch (err) {
        if (stopped || inner.signal.aborted) return;
        const apiErr = err instanceof ApiError ? err : new ApiError(errorMessage(err), { code: "stream" });
        if (attempt === 0) {
          handlers.onError?.(apiErr);
        } else {
          handlers.onStatus?.("failed");
          handlers.onClose?.("failed");
          return;
        }
      }
      // 一次自动重连
      if (attempt === 0) {
        attempt = 1;
        await sleep(700);
        if (stopped) return;
        continue;
      }
      handlers.onStatus?.("closed");
      handlers.onClose?.("eof");
      return;
    }
  })();

  return { close: stop };
}

/* ---------------------------------------------------------------- aggregate */

export const api = {
  getHealth,
  getDiagnostics,
  getSettings,
  saveSettings,
  listProviders,
  connectProvider,
  deleteConnection,
  importLocalAccount,
  startAuthFlow,
  pollAuthFlow,
  cancelAuthFlow,
  detectProxy,
  listModels,
  createRun,
  listRuns,
  getRun,
  listThreads,
  getThread,
  archiveThread,
  deleteThread,
  saveThreadMemory,
  branchThread,
  cancelRun,
  openRunStream,
  /* v0.0.2 */
  listRelayPresets,
  listRelays,
  createRelay,
  updateRelay,
  deleteRelay,
  discoverRelay,
  testRelay,
  detectLocalWorkbuddy,
  importLocalWorkbuddy,
  startWorkBuddyOAuth,
  pollWorkBuddyOAuth,
  createRelayAndDiscover,
  importRelayModels,
  addRelayModels,
  getBillingSummary,
  getBillingPrices,
  saveBillingPrices,
  importDshBilling,
  getRunContext,
  getMemoryStats,
  listMemorySpaces,
  createMemorySpace,
  updateMemorySpace,
  deleteMemorySpace,
  listMemoryEntries,
  createMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  searchMemory,
  importDshMemory,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  runWorkflow,
  listWorkflowRuns,
  getWorkflowRun,
  openWorkflowRunStream,
  setRunEffort,
  stopRunParticipant,
  artifactUrl,
  /* v0.0.3 */
  uploadFile,
  listPlugins,
  updatePlugin,
  testPlugin,
  runPluginAction,
  getBudgetUsage,
};


/* ================================================================
   v0.0.2 接口：中转站 / 计费 / 上下文 / 记忆 / 工作流 / 产物
   所有新接口在服务端未就绪时都可能 404 —— 调用方必须优雅降级。
   ================================================================ */

function asArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested as T[];
  }
  return [];
}

/* ---------------------------------------------------------------- relay */

export interface WorkbuddyLocalDetect {
  found: boolean;
  accountLabel?: string;
  region?: string;
  expiresAt?: number;
  detail?: string;
  models?: RelayModel[];
  uid?: string;
  regionCode?: "cn" | "global";
  accounts?: Array<Record<string, unknown>>;
  /** 原始响应，便于在字段变化时兜底展示 */
  raw?: unknown;
}

function normalizeWorkbuddyDetect(raw: unknown): WorkbuddyLocalDetect {
  if (!raw || typeof raw !== "object") return { found: false };
  const rec = raw as Record<string, unknown>;
  // 服务端返回 { accounts: WorkBuddyLocalAccount[] }
  const accounts = Array.isArray(rec.accounts) ? (rec.accounts as Array<Record<string, unknown>>) : [];
  if (accounts.length > 0) {
    const usable = accounts.find((item) => item.usable !== false) ?? accounts[0]!;
    return {
      found: accounts.some((item) => item.usable !== false),
      accountLabel:
        typeof usable.accountLabel === "string"
          ? usable.accountLabel
          : typeof usable.uid === "string"
            ? `…${usable.uid.slice(-6)}`
            : "WorkBuddy 账号",
      region:
        usable.region === "cn"
          ? "国内版"
          : usable.region === "global"
            ? "国际版"
            : typeof usable.domain === "string"
              ? usable.domain
              : undefined,
      expiresAt: typeof usable.expiresAt === "number" ? usable.expiresAt : undefined,
      detail:
        typeof usable.detail === "string"
          ? usable.detail
          : accounts.length > 1
            ? `检测到 ${accounts.length} 个本机账号，默认导入第一个。`
            : undefined,
      uid: typeof usable.uid === "string" ? usable.uid : undefined,
      regionCode: usable.region === "global" ? "global" : "cn",
      accounts,
      raw,
    };
  }
  const found = rec.found === true || rec.detected === true || rec.loggedIn === true || rec.ok === true;
  return {
    found,
    accountLabel:
      typeof rec.accountLabel === "string"
        ? rec.accountLabel
        : typeof rec.account === "string"
          ? rec.account
          : typeof rec.label === "string"
            ? rec.label
            : typeof rec.email === "string"
              ? rec.email
              : undefined,
    region: typeof rec.region === "string" ? rec.region : typeof rec.domain === "string" ? rec.domain : undefined,
    expiresAt:
      typeof rec.expiresAt === "number"
        ? rec.expiresAt
        : typeof rec.expiresAt === "string" && !Number.isNaN(Date.parse(rec.expiresAt))
          ? Date.parse(rec.expiresAt)
          : undefined,
    detail: typeof rec.detail === "string" ? rec.detail : typeof rec.note === "string" ? rec.note : undefined,
    models: Array.isArray(rec.models) ? (rec.models as RelayModel[]) : undefined,
    raw,
  };
}

export async function listRelayPresets(): Promise<RelayPreset[]> {
  const raw = await request<unknown>("/api/relays/presets", { timeoutMs: 10_000 });
  return asArray<RelayPreset>(raw, "presets");
}

export async function listRelays(signal?: AbortSignal): Promise<RelayAccount[]> {
  const raw = await request<unknown>("/api/relays", { signal, timeoutMs: 15_000 });
  return asArray<RelayAccount>(raw, "relays");
}

export async function createRelay(
  body: RelayCreateRequest,
): Promise<{ account: RelayAccount; models: RelayModel[] }> {
  const raw = await request<{ account?: RelayAccount; discovered?: RelayModel[] } | RelayAccount>(
    "/api/relays",
    {
      method: "POST",
      body: jsonBody(body),
      timeoutMs: 90_000,
    },
  );
  const rec = raw as { account?: RelayAccount; discovered?: RelayModel[] };
  const account = rec.account ?? (raw as RelayAccount);
  const models = Array.isArray(rec.discovered) ? rec.discovered : [];
  return { account, models };
}

export async function updateRelay(id: string, body: RelayUpdateRequest): Promise<RelayAccount> {
  const raw = await request<{ account?: RelayAccount } | RelayAccount>(`/api/relays/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: jsonBody(body),
    timeoutMs: 60_000,
  });
  return (raw as { account?: RelayAccount }).account ?? (raw as RelayAccount);
}

/** 勾选发现到的模型并导入（服务端 /import-models）。 */
export async function importRelayModels(
  id: string,
  modelIds: string[],
  models?: RelayModel[],
): Promise<RelayAccount> {
  const raw = await request<{ account?: RelayAccount } | RelayAccount>(
    `/api/relays/${encodeURIComponent(id)}/import-models`,
    {
      method: "POST",
      body: jsonBody(models && models.length > 0 ? { modelIds, models } : { modelIds }),
      timeoutMs: 90_000,
    },
  );
  return (raw as { account?: RelayAccount }).account ?? (raw as RelayAccount);
}

/** POST /api/relays/:id/models —— 手动添加模型（discover 失败时的出口）。 */
export async function addRelayModels(
  id: string,
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    reasoning?: boolean;
    imageGen?: boolean;
    enabled?: boolean;
  }>,
): Promise<RelayAccount> {
  const raw = await request<{ account?: RelayAccount } | RelayAccount>(
    `/api/relays/${encodeURIComponent(id)}/models`,
    {
      method: "POST",
      body: jsonBody({ models }),
      timeoutMs: 60_000,
    },
  );
  return (raw as { account?: RelayAccount }).account ?? (raw as RelayAccount);
}

export function deleteRelay(id: string): Promise<void> {
  return request<void>(`/api/relays/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function discoverRelay(id: string): Promise<RelayDiscoverResponse> {
  return request<RelayDiscoverResponse>(`/api/relays/${encodeURIComponent(id)}/discover`, {
    method: "POST",
    timeoutMs: 60_000,
  });
}

export function testRelay(id: string): Promise<{ ok: boolean; detail?: string }> {
  return request<{ ok: boolean; detail?: string }>(`/api/relays/${encodeURIComponent(id)}/test`, {
    method: "POST",
    timeoutMs: 30_000,
  });
}

export interface WorkBuddyOAuthStart {
  loginId: string;
  verificationUri: string;
  expiresIn: number;
}

export interface WorkBuddyOAuthPoll {
  done: boolean;
  account?: RelayAccount;
  error?: string;
}

export function startWorkBuddyOAuth(region: "cn" | "global" = "global"): Promise<WorkBuddyOAuthStart> {
  return request<WorkBuddyOAuthStart>("/api/relays/local/workbuddy/oauth/start", {
    method: "POST",
    body: jsonBody({ region }),
    timeoutMs: 40_000,
  });
}

export function pollWorkBuddyOAuth(loginId: string): Promise<WorkBuddyOAuthPoll> {
  return request<WorkBuddyOAuthPoll>("/api/relays/local/workbuddy/oauth/poll", {
    method: "POST",
    body: jsonBody({ loginId }),
    timeoutMs: 40_000,
  });
}

export async function detectLocalWorkbuddy(): Promise<WorkbuddyLocalDetect> {
  const raw = await request<unknown>("/api/relays/local/workbuddy", { timeoutMs: 20_000 });
  return normalizeWorkbuddyDetect(raw);
}

export async function importLocalWorkbuddy(body: { uid?: string; region?: "cn" | "global" } = {}): Promise<RelayAccount> {
  const raw = await request<{ account?: RelayAccount } | RelayAccount>(
    "/api/relays/local/workbuddy/import",
    {
      method: "POST",
      body: jsonBody(body),
      timeoutMs: 120_000,
    },
  );
  return (raw as { account?: RelayAccount }).account ?? (raw as RelayAccount);
}

/** 创建中转站并拿到模型列表（服务端创建时通常已顺手 discover）。 */
export async function createRelayAndDiscover(
  body: RelayCreateRequest,
): Promise<{ relay: RelayAccount; discovered: RelayDiscoverResponse }> {
  const created = await createRelay(body);
  if (created.models.length > 0) {
    return { relay: created.account, discovered: { models: created.models } };
  }
  const discovered = await discoverRelay(created.account.id);
  return { relay: created.account, discovered };
}

/* ---------------------------------------------------------------- billing */

export function getBillingSummary(signal?: AbortSignal): Promise<BillingSummary> {
  return request<BillingSummary>("/api/billing/summary", { signal, timeoutMs: 20_000 });
}

export async function getBillingPrices(signal?: AbortSignal): Promise<ModelPrice[]> {
  const raw = await request<unknown>("/api/billing/prices", { signal, timeoutMs: 15_000 });
  return asArray<ModelPrice>(raw, "prices");
}

export async function saveBillingPrices(prices: ModelPrice[]): Promise<ModelPrice[]> {
  const raw = await request<unknown>("/api/billing/prices", {
    method: "PUT",
    body: jsonBody(prices),
    timeoutMs: 30_000,
  });
  const list = asArray<ModelPrice>(raw, "prices");
  return list.length > 0 ? list : prices;
}

export function importDshBilling(): Promise<{ imported?: number; ledgerRows?: number; detail?: string }> {
  return request<{ imported?: number; ledgerRows?: number; detail?: string }>("/api/billing/import-dsh", {
    method: "POST",
    timeoutMs: 60_000,
  });
}

export const BILLING_CSV_URL = "/api/billing/export.csv";

/* ---------------------------------------------------------------- context */

export function getRunContext(runId: string, signal?: AbortSignal): Promise<ContextRunSummary> {
  return request<ContextRunSummary>(`/api/runs/${encodeURIComponent(runId)}/context`, {
    signal,
    timeoutMs: 20_000,
  });
}

/* ---------------------------------------------------------------- memory */

export function getMemoryStats(signal?: AbortSignal): Promise<MemoryStats> {
  return request<MemoryStats>("/api/memory/stats", { signal, timeoutMs: 15_000 });
}

export async function listMemorySpaces(signal?: AbortSignal): Promise<MemorySpace[]> {
  const raw = await request<unknown>("/api/memory/spaces", { signal, timeoutMs: 15_000 });
  return asArray<MemorySpace>(raw, "spaces");
}

export function createMemorySpace(body: { name: string; description?: string }): Promise<MemorySpace> {
  return request<MemorySpace>("/api/memory/spaces", { method: "POST", body: jsonBody(body) });
}

export function updateMemorySpace(
  id: string,
  body: { name?: string; description?: string },
): Promise<MemorySpace> {
  return request<MemorySpace>(`/api/memory/spaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: jsonBody(body),
  });
}

export function deleteMemorySpace(id: string): Promise<void> {
  return request<void>(`/api/memory/spaces/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listMemoryEntries(
  opts: { spaceId?: string; kind?: string; enabled?: boolean; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  const params = new URLSearchParams();
  if (opts.spaceId) params.set("spaceId", opts.spaceId);
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.enabled != null) params.set("enabled", String(opts.enabled));
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.offset != null) params.set("offset", String(opts.offset));
  const query = params.toString();
  const raw = await request<unknown>(`/api/memory/entries${query ? `?${query}` : ""}`, { signal });
  return asArray<MemoryEntry>(raw, "entries");
}

export function createMemoryEntry(body: MemoryCreateRequest): Promise<MemoryEntry> {
  return request<MemoryEntry>("/api/memory/entries", { method: "POST", body: jsonBody(body) });
}

export function updateMemoryEntry(id: string, body: MemoryUpdateRequest): Promise<MemoryEntry> {
  return request<MemoryEntry>(`/api/memory/entries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: jsonBody(body),
  });
}

export function deleteMemoryEntry(id: string): Promise<void> {
  return request<void>(`/api/memory/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function searchMemory(query: string, limit = 30): Promise<MemoryHit[]> {
  const raw = await request<unknown>("/api/memory/search", {
    method: "POST",
    body: jsonBody({ query, limit }),
    timeoutMs: 30_000,
  });
  const list = asArray<Record<string, unknown>>(raw, "hits");
  // 服务端返回的是 {...memory, score}，也兼容 { memory, score }。
  return list
    .map((item) => {
      if (item.memory && typeof item.memory === "object") {
        return { memory: item.memory as MemoryEntry, score: Number(item.score ?? 0) };
      }
      return { memory: item as unknown as MemoryEntry, score: Number(item.score ?? 0) };
    })
    .filter((hit) => typeof hit.memory?.id === "string");
}

export function importDshMemory(seed?: DshMemorySeed): Promise<{ imported?: number; total?: number; detail?: string }> {
  return request<{ imported?: number; total?: number; detail?: string }>("/api/memory/import-dsh", {
    method: "POST",
    body: jsonBody(seed ?? {}),
    timeoutMs: 60_000,
  });
}

/* ---------------------------------------------------------------- workflow */

export async function listWorkflows(signal?: AbortSignal): Promise<WorkflowDef[]> {
  const raw = await request<unknown>("/api/workflows", { signal, timeoutMs: 15_000 });
  return asArray<WorkflowDef>(raw, "workflows");
}

export function createWorkflow(body: WorkflowCreateRequest): Promise<WorkflowDef> {
  return request<WorkflowDef>("/api/workflows", { method: "POST", body: jsonBody(body) });
}

export function updateWorkflow(id: string, body: WorkflowCreateRequest): Promise<WorkflowDef> {
  return request<WorkflowDef>(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: jsonBody(body),
  });
}

export function deleteWorkflow(id: string): Promise<void> {
  return request<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function runWorkflow(id: string, body: WorkflowRunRequest): Promise<WorkflowRun> {
  const raw = await request<WorkflowRun | { runId: string; run: WorkflowRun }>(
    `/api/workflows/${encodeURIComponent(id)}/run`,
    {
      method: "POST",
      body: jsonBody(body),
      timeoutMs: 30_000,
    },
  );
  if ("run" in raw && raw.run) return raw.run;
  return raw as WorkflowRun;
}

export async function listWorkflowRuns(limit = 20, signal?: AbortSignal): Promise<WorkflowRun[]> {
  const raw = await request<unknown>(`/api/workflow-runs?limit=${encodeURIComponent(String(limit))}`, {
    signal,
    timeoutMs: 15_000,
  });
  return asArray<WorkflowRun>(raw, "runs");
}

export function getWorkflowRun(id: string, signal?: AbortSignal): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/api/workflow-runs/${encodeURIComponent(id)}`, { signal, timeoutMs: 15_000 });
}

export interface WorkflowStreamHandle {
  close(): void;
}

/**
 * 订阅工作流运行 SSE。事件形状由服务端决定，这里把每帧 JSON 交给调用方，
 * 调用方收到任何消息都回读一次 GET /api/workflow-runs/:id 即可（简单可靠）。
 * 服务端未实现该接口时 onError 会收到 404，调用方退回轮询。
 */
export function openWorkflowRunStream(
  runId: string,
  handlers: {
    onFrame?: (frame: unknown) => void;
    onStatus?: (status: "open" | "closed" | "error") => void;
    onError?: (error: ApiError) => void;
  },
  options: { signal?: AbortSignal } = {},
): WorkflowStreamHandle {
  const inner = new AbortController();
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    inner.abort();
    options.signal?.removeEventListener("abort", stop);
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  void (async () => {
    try {
      const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}/stream`, {
        headers: { accept: "text/event-stream" },
        signal: inner.signal,
        cache: "no-store",
      });
      if (!res.ok) throw await toHttpError(res);
      handlers.onStatus?.("open");
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dataLines: string[] = [];
      const flush = (): void => {
        if (dataLines.length === 0) return;
        const data = dataLines.join("\n");
        dataLines = [];
        if (!data || data === "[DONE]") return;
        try {
          handlers.onFrame?.(JSON.parse(data) as unknown);
        } catch {
          handlers.onFrame?.(data);
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":") || line.startsWith("event:")) continue;
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          flush();
          sep = buffer.indexOf("\n\n");
        }
      }
      if (dataLines.length > 0) flush();
      if (!stopped) handlers.onStatus?.("closed");
    } catch (err) {
      if (stopped) return;
      handlers.onStatus?.("error");
      handlers.onError?.(err instanceof ApiError ? err : new ApiError(errorMessage(err), { code: "stream" }));
    }
  })();

  return { close: stop };
}

/* ---------------------------------------------------------------- effort */

/** 运行中热调强度：POST /api/runs/:id/effort，下一次调用生效。 */
export function setRunEffort(
  runId: string,
  participantId: string,
  effort: EffortLevel,
): Promise<{ ok: boolean; participantId: string; effort: EffortLevel; note?: string }> {
  return request<{ ok: boolean; participantId: string; effort: EffortLevel; note?: string }>(
    `/api/runs/${encodeURIComponent(runId)}/effort`,
    {
      method: "POST",
      body: jsonBody({ participantId, effort }),
      timeoutMs: 20_000,
    },
  );
}

/** 运行中单独停止某个模型：只中断这一个，其余继续。 */
export function stopRunParticipant(
  runId: string,
  participantId: string,
): Promise<{ ok: boolean; participantId: string; note?: string }> {
  return request<{ ok: boolean; participantId: string; note?: string }>(
    `/api/runs/${encodeURIComponent(runId)}/participants/${encodeURIComponent(participantId)}/stop`,
    { method: "POST", timeoutMs: 20_000 },
  );
}

/* ---------------------------------------------------------------- artifacts */

/** 产物 URL：dataUrl 优先，其次按服务端给的 path 拼 /api/artifacts。 */
export function artifactUrl(runId: string, artifact: { path?: string; dataUrl?: string }): string | undefined {
  if (artifact.dataUrl) return artifact.dataUrl;
  const path = artifact.path;
  if (!path) return undefined;
  if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
  const base = path.split("/").filter(Boolean).pop() ?? path;
  return `/api/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(base)}`;
}

/* ------------------------------------------------------------- 模型目录同步 */

export interface RefreshModelsResult {
  updated: Array<{ provider: string; count: number; source: string }>;
  errors: Array<{ provider: string; message: string }>;
  total: number;
  note?: string;
}

/** 拉取各家上游的最新模型目录，合并进模型池（服务端会持久化 customModels）。 */
export function refreshModelCatalog(): Promise<RefreshModelsResult> {
  return request<RefreshModelsResult>("/api/models/refresh", { method: "POST", timeoutMs: 90_000 });
}

/* ================================================================
   v0.0.3 接口：附件上传 / 插件中心 / 预算用量
   服务端未就绪时统一抛 ApiError(status=404)，调用方展示占位。
   ================================================================ */

export interface UploadFileRequest {
  name: string;
  mime: string;
  size: number;
  dataBase64: string;
}

function parseErrorText(text: string, status: number): ApiError {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; detail?: string } };
    if (parsed?.error) {
      return new ApiError(parsed.error.message ?? `上传失败（HTTP ${status}）`, {
        code: parsed.error.code ?? `http_${status}`,
        status,
        detail: parsed.error.detail,
      });
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  return new ApiError(status === 404 ? "接口不存在（服务端版本可能较旧）" : `上传失败（HTTP ${status}）`, {
    code: `http_${status}`,
    status,
  });
}

/**
 * POST /api/uploads —— JSON base64 上传，带真实上传进度。
 * 采用 XHR 仅因为 fetch 无法上报上传进度；响应/错误形状与 request() 一致。
 */
export function uploadFile(
  body: UploadFileRequest,
  onProgress?: (percent: number) => void,
  options: { timeoutMs?: number } = {},
): Promise<UploadResponse> {
  return new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("accept", "application/json");
    xhr.timeout = options.timeoutMs ?? 120_000;
    let last = 0;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      const percent = Math.min(95, Math.round((event.loaded / event.total) * 100));
      if (percent > last) {
        last = percent;
        onProgress?.(percent);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResponse);
        } catch {
          reject(new ApiError("上传接口返回了无法识别的数据", { code: "bad_response", status: xhr.status }));
        }
        return;
      }
      reject(parseErrorText(xhr.responseText, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("上传失败：无法连接本机服务", { code: "network" }));
    xhr.ontimeout = () => reject(new ApiError("上传超时，请重试或换一个更小的文件", { code: "timeout" }));
    xhr.send(JSON.stringify(body));
  });
}

function normalizePluginList(raw: unknown): PluginInfo[] {
  if (Array.isArray(raw)) return raw as PluginInfo[];
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const key of ["plugins", "items", "list"]) {
      if (Array.isArray(rec[key])) return rec[key] as PluginInfo[];
    }
  }
  return [];
}

/** GET /api/plugins —— DSH 插件扫描 + 用户启停覆盖。 */
export async function listPlugins(signal?: AbortSignal): Promise<PluginInfo[]> {
  const raw = await request<unknown>("/api/plugins", { signal, timeoutMs: 30_000 });
  return normalizePluginList(raw);
}

/** PUT /api/plugins/:id —— 启用/停用，或覆盖桥接命令。 */
export async function updatePlugin(
  id: string,
  body: { enabled?: boolean; bridge?: PluginInfo["bridge"] },
): Promise<PluginInfo | undefined> {
  const raw = await request<PluginInfo | { plugin?: PluginInfo } | { ok?: boolean }>(
    `/api/plugins/${encodeURIComponent(id)}`,
    { method: "PUT", body: jsonBody(body), timeoutMs: 20_000 },
  );
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (rec.plugin && typeof rec.plugin === "object") return rec.plugin as PluginInfo;
    if (typeof rec.id === "string") return raw as PluginInfo;
  }
  return undefined;
}

export interface PluginTestEnvelope extends PluginTestResult {
  plugin?: PluginInfo;
}

/** POST /api/plugins/:id/test —— 执行桥接测试命令（超时 10s，只读）。 */
export interface PluginActionEnvelope {
  plugin: PluginInfo;
  action: import("@super-work/core").PluginAction;
  result: import("@super-work/core").PluginActionResponse;
}

/** POST /api/plugins/:id/action —— 执行插件适配动作。 */
export async function runPluginAction(
  id: string,
  actionId: string,
  inputs: Record<string, string>,
): Promise<PluginActionEnvelope> {
  return request<PluginActionEnvelope>(`/api/plugins/${encodeURIComponent(id)}/action`, {
    method: "POST",
    body: jsonBody({ actionId, inputs }),
    timeoutMs: 180_000,
  });
}

export async function testPlugin(id: string): Promise<PluginTestEnvelope> {
  const raw = await request<PluginTestResult | { result?: PluginTestResult; plugin?: PluginInfo }>(
    `/api/plugins/${encodeURIComponent(id)}/test`,
    { method: "POST", timeoutMs: 20_000 },
  );
  if (raw && typeof raw === "object") {
    const rec = raw as { result?: PluginTestResult; plugin?: PluginInfo };
    if (rec.result && typeof rec.result === "object") return { ...rec.result, plugin: rec.plugin };
  }
  return raw as PluginTestEnvelope;
}

/**
 * 预算用量：优先新接口 GET /api/budgets/usage；404 时用 /api/billing/summary 的今日窗口
 * 与 AppSettings.budgets 在本地推导，保证旧服务端也能显示预算条。
 */
export interface BudgetUsageView extends BudgetUsage {
  message?: string;
}

interface BudgetStatusResponse {
  window?: "today" | "month";
  today?: { tokens?: number; cost?: number; currency?: "CNY" | "USD" };
  tokens?: number;
  cost?: number;
  currency?: "CNY" | "USD";
  limits?: { tokens?: number; cost?: number };
  limitTokens?: number;
  limitCost?: number;
  percent?: number;
  blocked?: boolean;
  cheapMode?: boolean;
  message?: string;
}

function normalizeBudgetUsage(raw: BudgetStatusResponse): BudgetUsageView | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const today = raw.today;
  const tokens = typeof today?.tokens === "number" ? today.tokens : raw.tokens;
  const cost = typeof today?.cost === "number" ? today.cost : raw.cost;
  if (typeof tokens !== "number" && typeof cost !== "number") return undefined;
  const limitTokens = raw.limits?.tokens ?? raw.limitTokens;
  const limitCost = raw.limits?.cost ?? raw.limitCost;
  let percent = raw.percent;
  if (percent != null && percent > 0 && percent <= 1) percent = Math.round(percent * 1000) / 10;
  return {
    window: raw.window ?? "today",
    tokens: tokens ?? 0,
    cost: cost ?? 0,
    currency: raw.currency ?? today?.currency ?? "CNY",
    limitTokens,
    limitCost,
    percent,
    blocked: raw.blocked === true,
    cheapMode: raw.cheapMode === true,
    message: raw.message,
  };
}

export async function getBudgetUsage(
  budgets?: BudgetSettings,
  signal?: AbortSignal,
): Promise<BudgetUsageView> {
  try {
    const raw = await request<BudgetStatusResponse>("/api/budgets/usage", { signal, timeoutMs: 10_000 });
    const usage = normalizeBudgetUsage(raw);
    if (usage) return usage;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404) throw err;
  }
  const summary = await getBillingSummary(signal);
  const tokens = summary.today.totalTokens;
  const cost = summary.today.cost;
  const limitTokens = budgets?.dailyTokenLimit;
  const limitCost = budgets?.dailyCostLimit;
  const ratios: number[] = [];
  if (limitTokens && limitTokens > 0) ratios.push(tokens / limitTokens);
  if (limitCost && limitCost > 0) ratios.push(cost / limitCost);
  const ratio = ratios.length > 0 ? Math.max(...ratios) : undefined;
  return {
    window: "today",
    tokens,
    cost,
    currency: budgets?.currency ?? summary.today.currency,
    limitTokens,
    limitCost,
    percent: ratio == null ? undefined : Math.round(ratio * 1000) / 10,
    blocked: ratio != null && ratio >= 1,
    cheapMode: budgets?.cheapMode ?? false,
  };
}

/** 附件输入 → 轻量展示结构（RunDetail.attachments 可能只有 meta）。 */
export function attachmentInputFromMeta(meta: AttachmentMeta, text?: string): AttachmentInput {
  return {
    id: meta.id,
    name: meta.name,
    mime: meta.mime,
    kind: (meta.kind ?? "other") as AttachmentKind,
    text,
    path: meta.path,
    size: meta.size,
  };
}
