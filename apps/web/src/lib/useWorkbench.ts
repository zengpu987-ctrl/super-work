/**
 * 工作台状态中心：所有网络读写 + SSE 生命周期 + 本地持久化。
 * 只用 React 内置 hooks（useReducer / useState / useRef / useEffect），不引状态库。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AppSettings,
  AttachmentMeta,
  BudgetSettings,
  CoordinationAssignment,
  CreateRunRequest,
  CustomRoleDef,
  EffortLevel,
  KeywordRule,
  ModelInfo,
  ModelOption,
  ParticipantSpec,
  PerformanceSettings,
  ProviderId,
  ProviderStatus,
  RunDetail,
  RunListItem,
  RunMode,
  ThreadSummary,
  Usage,
} from "@super-work/core";
import { COORD_ROLES, DEFAULT_POOL } from "@super-work/core";
import { effortName } from "./effort";
import {
  ApiError,
  api,
  errorMessage,
  type BudgetUsageView,
  type RunStreamHandle,
  type StreamStatus,
} from "./api";
import {
  anyAttachmentBusy,
  applyUploadMeta,
  draftFromFile,
  filterFiles,
  readFileBase64,
  readyAttachmentInputs,
  totalAttachmentTokens,
  type AttachmentDraft,
} from "./attachments";
import {
  checkRoleName,
  createCustomRoleId,
  duplicateRoleName,
  nextCustomRoleOrder,
  sortedCustomRoles,
  type RoleNameCheck,
} from "./v3";
import {
  DEMO_COMMAND,
  demoParticipants,
  fallbackModels,
  fallbackProviders,
  labelFor,
  nextToastId,
  runReducer,
  viewFromDetail,
} from "./store";
import type {
  FollowUpContext,
  RunView,
  SettingsSection,
  StreamStatusLabel,
  ToastItem,
} from "./types";
import { JUDGE_MODES, MAX_PARTICIPANTS, defaultRole } from "./types";
import { tail, truncate } from "./format";

const LS = {
  participants: "superwork.participants.v1",
  mode: "superwork.mode.v1",
  options: "superwork.options.v1",
  customModels: "superwork.customModels.v1",
  banner: "superwork.bannerDismissed.v1",
  judge: "superwork.judge.v1",
  coordination: "superwork.coordination.v1",
  roleEnabled: "superwork.roleEnabled.v1",
  useMemory: "superwork.useMemory.v1",
  customRoles: "superwork.customRoles.v1",
  cheapMode: "superwork.cheapMode.v1",
  chatModel: "superwork.chatModel.v1",
} as const;

export type CoordinationState = Record<string, ParticipantSpec[]>;
export type RoleEnabledState = Record<string, boolean>;

const DEFAULT_BUDGETS: BudgetSettings = {
  currency: "CNY",
  warnAtPercent: 80,
  cheapMode: false,
};

const DEFAULT_PERFORMANCE: PerformanceSettings = {
  concurrency: 3,
  timeoutMs: 90_000,
  defaultMaxTokens: 4096,
  streamChunkThrottleMs: 120,
};

const DEFAULT_SETTINGS: AppSettings = {
  language: "zh",
  allowLocalReuse: true,
  timeoutMs: 180_000,
  budgets: DEFAULT_BUDGETS,
  performance: DEFAULT_PERFORMANCE,
  keywords: [],
  customRoles: [],
};

/* ---------------------------------------------------------------- persistence */

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function isRunMode(value: unknown): value is RunMode {
  return (
    value === "parallel" ||
    value === "coordinate" ||
    value === "chat" ||
    value === "council" ||
    value === "debate" ||
    value === "pipeline" ||
    value === "vote" ||
    value === "auto"
  );
}

export function emptyCoordination(): CoordinationState {
  const state = {} as CoordinationState;
  for (const role of COORD_ROLES) state[role.id] = [];
  return state;
}

export function defaultRoleEnabled(): RoleEnabledState {
  return Object.fromEntries(COORD_ROLES.map((role) => [role.id, true])) as RoleEnabledState;
}

function loadCoordination(): CoordinationState {
  const state = emptyCoordination();
  const raw = readJson(LS.coordination);
  if (!raw || typeof raw !== "object") return state;
  for (const [roleId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    state[roleId] = value.filter(isParticipantSpec).map((spec) => ({
      provider: spec.provider,
      model: spec.model,
      relayId: spec.relayId,
      effort: spec.effort,
      role: typeof spec.role === "string" ? spec.role : undefined,
    }));
  }
  return state;
}

function loadRoleEnabled(): RoleEnabledState {
  const state = defaultRoleEnabled();
  const raw = readJson(LS.roleEnabled);
  if (!raw || typeof raw !== "object") return state;
  for (const [roleId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "boolean") state[roleId] = value;
  }
  return state;
}

function isCustomRoleDef(value: unknown): value is CustomRoleDef {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    typeof rec.name === "string" &&
    (rec.kind === "text" || rec.kind === "image")
  );
}

function loadCustomRoles(): CustomRoleDef[] {
  const raw = readJson(LS.customRoles);
  if (!Array.isArray(raw)) return [];
  return sortedCustomRoles(raw.filter(isCustomRoleDef).map((role) => ({
    id: role.id,
    name: role.name.slice(0, 12),
    description: typeof role.description === "string" ? role.description.slice(0, 200) : "",
    kind: role.kind,
    order: typeof role.order === "number" ? role.order : 100,
  })));
}

function loadUseMemory(): boolean {
  return readJson(LS.useMemory) !== false;
}

function isParticipantSpec(value: unknown): value is ParticipantSpec {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.provider === "string" && typeof rec.model === "string";
}

function loadParticipants(): ParticipantSpec[] | null {
  const raw = readJson(LS.participants);
  if (!Array.isArray(raw)) return null;
  const list = raw.filter(isParticipantSpec).map((spec) => ({
    provider: spec.provider,
    model: spec.model,
    relayId: spec.relayId,
    effort: spec.effort,
    role: typeof spec.role === "string" ? spec.role : undefined,
  }));
  return list;
}

function loadMode(): RunMode | null {
  const raw = readJson(LS.mode);
  return isRunMode(raw) ? raw : null;
}

function loadChatModel(): ParticipantSpec | null {
  const raw = readJson(LS.chatModel);
  if (!isParticipantSpec(raw)) return null;
  return {
    provider: raw.provider,
    model: raw.model,
    relayId: raw.relayId,
    effort: raw.effort,
    role: typeof raw.role === "string" ? raw.role : undefined,
  };
}

function loadOptions(): { rounds: number; critique: boolean } {
  const raw = readJson(LS.options);
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    return {
      rounds: typeof rec.rounds === "number" ? Math.min(5, Math.max(1, rec.rounds)) : 2,
      critique: typeof rec.critique === "boolean" ? rec.critique : true,
    };
  }
  return { rounds: 2, critique: true };
}

function loadCustomModels(): ModelInfo[] {
  const raw = readJson(LS.customModels);
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is ModelInfo => {
    if (!item || typeof item !== "object") return false;
    const rec = item as Record<string, unknown>;
    return typeof rec.id === "string" && typeof rec.provider === "string" && rec.id.length > 0;
  });
}

function loadJudgeKey(): string | null {
  const raw = readJson(LS.judge);
  return typeof raw === "string" ? raw : null;
}

function loadBannerDismissed(): boolean {
  return readJson(LS.banner) === true;
}

export function keyOf(spec: Pick<ParticipantSpec, "provider" | "model" | "relayId">): string {
  return `${spec.provider}:${spec.relayId ?? ""}:${spec.model}`;
}

/* ---------------------------------------------------------------- hook */

export interface StartRunOverrides {
  command?: string;
  mode?: RunMode;
  participants?: ParticipantSpec[];
  /** 强制开一个新工作（重跑 / 重新综合 / 演示用），不接续当前对话 */
  newThread?: boolean;
}

export interface Workbench {
  /* data */
  providers: ProviderStatus[];
  models: ModelOption[];
  customModels: ModelInfo[];
  history: RunListItem[];
  /** 多轮对话：工作列表（左栏按工作展示） */
  threads: ThreadSummary[];
  /** 当前工作里已完成的轮次（对话历史，按轮次升序） */
  pastRounds: RunView[];
  settings: AppSettings;
  server: { online: boolean; version?: string; checkedAt: number };
  loading: { providers: boolean; models: boolean; history: boolean; settings: boolean };
  initialLoading: boolean;
  offline: boolean;
  hasConnection: boolean;
  connectedProviderCount: number;
  availableModelCount: number;
  /* composer / orchestration */
  participants: ParticipantSpec[];
  mode: RunMode;
  setMode: (mode: RunMode) => void;
  /** Chat 模式唯一模型（每次只能有一个） */
  chatModel: ParticipantSpec | null;
  setChatModel: (spec: ParticipantSpec | null) => void;
  /** 从工作模式切到 Chat：默认用裁判或第一位参与模型接话 */
  handoffToChat: (spec?: ParticipantSpec) => void;
  /** 从 Chat 切回团队：默认并行，可指定配合 */
  handoffToTeam: (mode?: RunMode) => void;
  command: string;
  setCommand: (value: string) => void;
  rounds: number;
  setRounds: (value: number) => void;
  critique: boolean;
  setCritique: (value: boolean) => void;
  judgeKey: string | null;
  setJudgeKey: (key: string | null) => void;
  /* v0.0.2 coordination */
  coordination: CoordinationState;
  roleEnabled: RoleEnabledState;
  coordinationAssignments: CoordinationAssignment[];
  toggleRoleModel: (role: string, spec: ParticipantSpec) => void;
  clearRole: (role: string) => void;
  setRoleEnabled: (role: string, enabled: boolean) => void;
  setRoleParticipants: (role: string, specs: ParticipantSpec[]) => void;
  updateParticipantEffort: (index: number, effort: EffortLevel) => void;
  updateRoleModelEffort: (role: string, key: string, effort: EffortLevel) => void;
  changeRunEffort: (participantId: string, effort: EffortLevel) => Promise<void>;
  /** 运行中单独停止某个模型（其余继续） */
  stopParticipant: (participantId: string) => Promise<void>;
  /** 套用模型团队模板：覆盖并行与配合配置（运行中不可用） */
  applyTeamTemplate: (input: {
    mode: RunMode;
    participants: ParticipantSpec[];
    coordination: CoordinationAssignment[];
    judge?: ParticipantSpec;
  }) => void;
  useMemory: boolean;
  setUseMemory: (value: boolean) => void;
  /* v0.0.3 自定义角色 */
  customRoles: CustomRoleDef[];
  createCustomRole: (input: {
    name: string;
    description: string;
    kind: "text" | "image";
  }) => { role?: CustomRoleDef; error?: RoleNameCheck };
  updateCustomRole: (id: string, patch: Partial<Omit<CustomRoleDef, "id">>) => RoleNameCheck;
  deleteCustomRole: (id: string) => void;
  duplicateCustomRole: (id: string) => CustomRoleDef | undefined;
  reorderCustomRoles: (fromId: string, toId: string) => void;
  moveCustomRole: (id: string, delta: number) => void;
  /* v0.0.3 附件 */
  attachments: AttachmentDraft[];
  attachmentBusy: boolean;
  attachmentTokens: number;
  expandedAttachmentId: string | null;
  setExpandedAttachmentId: (localId: string | null) => void;
  addAttachmentFiles: (files: File[]) => void;
  retryAttachment: (localId: string) => void;
  removeAttachment: (localId: string) => void;
  clearAttachments: () => void;
  /* v0.0.3 预算 */
  budgets: BudgetSettings;
  performance: PerformanceSettings;
  keywords: KeywordRule[];
  cheapMode: boolean;
  setCheapMode: (value: boolean) => Promise<void>;
  budgetUsage: BudgetUsageView | null;
  budgetUsageFailed: boolean;
  budgetLoading: boolean;
  refreshBudget: () => Promise<void>;
  /* v0.0.3 高成本确认 */
  pendingConfirm: { message: string; detail?: string; payload: CreateRunRequest; source: "budget" } | null;
  confirmRun: () => Promise<void>;
  cancelConfirm: () => void;
  saveSettingsPatch: (patch: Partial<AppSettings>) => Promise<void>;
  /* run */
  run: RunView | null;
  busy: boolean;
  now: number;
  /* ui */
  toasts: ToastItem[];
  dismissToast: (id: number) => void;
  pushToast: (kind: ToastItem["kind"], message: string, detail?: string, durationMs?: number) => void;
  settingsOpen: boolean;
  settingsProvider: ProviderId | null;
  settingsSection: SettingsSection;
  openSettings: (provider?: ProviderId | null, section?: SettingsSection) => void;
  closeSettings: () => void;
  bannerDismissed: boolean;
  dismissBanner: () => void;
  followUp: FollowUpContext | null;
  beginFollowUp: () => void;
  clearFollowUp: () => void;
  /* actions */
  startRun: (overrides?: StartRunOverrides) => Promise<void>;
  stopRun: () => Promise<void>;
  rerun: () => Promise<void>;
  resynthesize: () => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  /** 打开一个工作（多轮对话），还原全部轮次 */
  loadThread: (threadId: string) => Promise<void>;
  resetRun: () => void;
  runDemo: () => Promise<void>;
  addParticipant: (provider: ProviderId, model: string) => void;
  toggleParticipant: (spec: ParticipantSpec) => void;
  removeParticipant: (index: number) => void;
  updateRole: (index: number, role: string) => void;
  reorderParticipants: (from: number, to: number) => void;
  moveParticipant: (index: number, delta: number) => void;
  addCustomModel: (provider: ProviderId, modelId: string) => boolean;
  removeCustomModel: (provider: ProviderId, modelId: string) => void;
  refreshProviders: () => Promise<void>;
  refreshModels: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  refreshAll: () => Promise<void>;
  saveSettings: (next: AppSettings) => Promise<void>;
  setServerOnline: (online: boolean, version?: string) => void;
  judgeSpec: ParticipantSpec | undefined;
}

export function useWorkbench(): Workbench {
  const [providers, setProviders] = useState<ProviderStatus[]>(() => fallbackProviders());
  const [models, setModels] = useState<ModelOption[]>(() => fallbackModels());
  const [customModels, setCustomModels] = useState<ModelInfo[]>(() => loadCustomModels());
  const [history, setHistory] = useState<RunListItem[]>([]);
  /** 多轮对话：工作列表（左栏） */
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  /** 多轮对话：当前工作里已完成的轮次（按轮次升序） */
  const [pastRounds, setPastRounds] = useState<RunView[]>([]);
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    budgets: { ...DEFAULT_BUDGETS },
    performance: { ...DEFAULT_PERFORMANCE },
    keywords: [],
    customRoles: [],
  }));
  const [customRoles, setCustomRoles] = useState<CustomRoleDef[]>(() => loadCustomRoles());
  const [server, setServer] = useState<{ online: boolean; version?: string; checkedAt: number }>({
    online: false,
    checkedAt: 0,
  });
  const [loading, setLoading] = useState({
    providers: true,
    models: true,
    history: true,
    settings: true,
  });
  const [run, dispatchRun] = useReducer(runReducer, null);
  const [mode, setModeState] = useState<RunMode>(() => loadMode() ?? "parallel");
  const [chatModel, setChatModelState] = useState<ParticipantSpec | null>(() => loadChatModel());
  const chatModelRef = useRef<ParticipantSpec | null>(chatModel);
  const [command, setCommand] = useState("");
  const [options, setOptions] = useState(() => loadOptions());
  const [participants, setParticipants] = useState<ParticipantSpec[]>(() => loadParticipants() ?? []);
  const [coordination, setCoordination] = useState<CoordinationState>(() => loadCoordination());
  const [roleEnabled, setRoleEnabledState] = useState<RoleEnabledState>(() => loadRoleEnabled());
  const [useMemory, setUseMemoryState] = useState<boolean>(() => loadUseMemory());
  const [judgeKey, setJudgeKeyState] = useState<string | null>(() => loadJudgeKey());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<ProviderId | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("providers");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [expandedAttachmentId, setExpandedAttachmentId] = useState<string | null>(null);
  const [budgetUsage, setBudgetUsage] = useState<BudgetUsageView | null>(null);
  const [budgetUsageFailed, setBudgetUsageFailed] = useState(false);
  const [budgetLoading, setBudgetLoading] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<Workbench["pendingConfirm"]>(null);
  const [bannerDismissed, setBannerDismissed] = useState(() => loadBannerDismissed());
  const [followUp, setFollowUp] = useState<FollowUpContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const streamRef = useRef<RunStreamHandle | null>(null);
  const runRef = useRef<RunView | null>(null);
  /** 已加载的前端构建时间戳：服务端 dist 更新后自动刷新一次，避免 WebView 停在旧构建 */
  const webBuildRef = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings>(settings);
  const customRolesRef = useRef<CustomRoleDef[]>(customRoles);
  const attachmentsRef = useRef<AttachmentDraft[]>(attachments);
  const uploadTimers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const toastTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const providersLoadedRef = useRef(false);
  const modelsLoadedRef = useRef(false);
  const initializedRef = useRef(false);
  const seededFromStorageRef = useRef<boolean>(loadParticipants() !== null);
  const mountedRef = useRef(true);
  chatModelRef.current = chatModel;

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    customRolesRef.current = customRoles;
  }, [customRoles]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    writeJson(LS.customRoles, customRoles);
  }, [customRoles]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamRef.current?.close();
      streamRef.current = null;
      for (const timer of toastTimers.current.values()) clearTimeout(timer);
      toastTimers.current.clear();
      for (const timer of uploadTimers.current.values()) clearInterval(timer);
      uploadTimers.current.clear();
    };
  }, []);

  /* ---------- toasts ---------- */

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(
    (kind: ToastItem["kind"], message: string, detail?: string, durationMs?: number) => {
      const id = nextToastId();
      setToasts((prev) => [...prev.slice(-3), { id, kind, message, detail }]);
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
        toastTimers.current.delete(id);
      }, durationMs ?? (kind === "error" ? 7_000 : 4_500));
      toastTimers.current.set(id, timer);
    },
    [],
  );

  /* ---------- fetchers ---------- */

  const setServerOnline = useCallback((online: boolean, version?: string) => {
    setServer((prev) => ({ online, version: version ?? prev.version, checkedAt: Date.now() }));
  }, []);

  const refreshProviders = useCallback(async () => {
    try {
      const list = await api.listProviders();
      if (!mountedRef.current) return;
      setProviders(list);
      providersLoadedRef.current = true;
      setServerOnline(true);
    } catch (err) {
      if (!mountedRef.current) return;
      if (!providersLoadedRef.current) setProviders(fallbackProviders());
      if (err instanceof ApiError && err.code === "network") setServerOnline(false);
    } finally {
      if (mountedRef.current) setLoading((prev) => ({ ...prev, providers: false }));
    }
  }, [setServerOnline]);

  const refreshModels = useCallback(async () => {
    try {
      const res = await api.listModels();
      if (!mountedRef.current) return;
      // /api/models 并非所有模型都会返回；用 catalog 补齐已知模型。
      setModels(res.models);
      modelsLoadedRef.current = true;
      setServerOnline(true);
    } catch (err) {
      if (!mountedRef.current) return;
      if (!modelsLoadedRef.current) setModels(fallbackModels());
      if (err instanceof ApiError && err.code === "network") setServerOnline(false);
    } finally {
      if (mountedRef.current) setLoading((prev) => ({ ...prev, models: false }));
    }
  }, [setServerOnline]);

  const refreshHistory = useCallback(async () => {
    try {
      const [list, threadList] = await Promise.all([
        api.listRuns(30).catch(() => [] as RunListItem[]),
        api.listThreads(30).catch(() => [] as ThreadSummary[]),
      ]);
      if (!mountedRef.current) return;
      setHistory(list);
      setThreads(threadList);
    } catch {
      /* 历史失败可恢复，保持现有列表 */
    } finally {
      if (mountedRef.current) setLoading((prev) => ({ ...prev, history: false }));
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const res = await api.getSettings();
      if (!mountedRef.current) return;
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...res,
        budgets: { ...DEFAULT_BUDGETS, ...(res.budgets ?? {}) },
        performance: { ...DEFAULT_PERFORMANCE, ...(res.performance ?? {}) },
        keywords: Array.isArray(res.keywords) ? res.keywords : [],
        customRoles: Array.isArray(res.customRoles) ? res.customRoles : [],
      };
      settingsRef.current = merged;
      setSettings(merged);
      if (Array.isArray(res.customRoles) && res.customRoles.length > 0) {
        const serverRoles = sortedCustomRoles(res.customRoles.filter(isCustomRoleDef));
        setCustomRoles((local) => {
          const ids = new Set(serverRoles.map((role) => role.id));
          const mergedRoles = sortedCustomRoles([...serverRoles, ...local.filter((role) => !ids.has(role.id))]);
          customRolesRef.current = mergedRoles;
          return mergedRoles;
        });
      }
      setModeState((prev) => (loadMode() ? prev : res.defaultMode ?? prev));
    } catch {
      /* 保留默认设置 */
    } finally {
      if (mountedRef.current) setLoading((prev) => ({ ...prev, settings: false }));
    }
  }, []);

  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const health = await api.getHealth();
      if (!mountedRef.current) return health.ok;
      setServerOnline(true, health.version);
      // 服务端 dist 变了（重新构建前端）→ 空闲时自动刷新，避免旧构建的交互 bug 一直存在。
      const build = health.webBuild;
      if (typeof build === "number") {
        if (webBuildRef.current === null) {
          webBuildRef.current = build;
        } else if (build !== webBuildRef.current) {
          webBuildRef.current = build;
          if (import.meta.env.PROD) {
            const input = document.getElementById("command-input") as HTMLTextAreaElement | null;
            const busy =
              runRef.current?.state === "running" ||
              Boolean(document.querySelector(".modal, .team-layer, .resource-overlay"));
            if (busy || input?.value.trim()) {
              pushToast("info", "界面有更新，处理完当前内容后刷新页面", undefined, 4000);
            } else {
              pushToast("info", "界面已更新，正在刷新…", undefined, 1800);
              window.setTimeout(() => window.location.reload(), 900);
            }
          }
        }
      }
      return health.ok;
    } catch {
      if (!mountedRef.current) return false;
      setServerOnline(false);
      return false;
    }
  }, [pushToast, setServerOnline]);

  const refreshBudget = useCallback(async () => {
    setBudgetLoading(true);
    try {
      const usage = await api.getBudgetUsage(settingsRef.current.budgets);
      if (!mountedRef.current) return;
      setBudgetUsage(usage);
      setBudgetUsageFailed(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setBudgetUsageFailed(true);
      if (err instanceof ApiError && err.status !== 404) {
        // 静默：预算条退回「--」，不打断工作台
      }
    } finally {
      if (mountedRef.current) setBudgetLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshProviders(), refreshModels(), refreshHistory(), loadSettings()]);
    void refreshBudget();
    void checkHealth();
  }, [checkHealth, loadSettings, refreshBudget, refreshHistory, refreshModels, refreshProviders]);

  /* ---------- mount / polling ---------- */

  useEffect(() => {
    void refreshProviders();
    void refreshModels();
    void refreshHistory();
    void loadSettings();
    void refreshBudget();
    void checkHealth();
  }, [checkHealth, loadSettings, refreshBudget, refreshHistory, refreshModels, refreshProviders]);

  // 预算条每 60s 刷新一次；运行结束后会额外刷新。
  useEffect(() => {
    const timer = setInterval(() => void refreshBudget(), 60_000);
    return () => clearInterval(timer);
  }, [refreshBudget]);

  useEffect(() => {
    const timer = setInterval(() => {
      void checkHealth();
    }, 20_000);
    return () => clearInterval(timer);
  }, [checkHealth]);

  // 运行中每 500ms 走一次时钟，用于耗时显示。
  useEffect(() => {
    if (run?.state !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [run?.state, run?.id]);

  /* ---------- derive participants ---------- */

  useEffect(() => {
    if (initializedRef.current) return;
    if (loading.providers && loading.models) return;
    initializedRef.current = true;
    if (seededFromStorageRef.current) return;
    // 没有任何非 mock 模型可用时，默认池直接落成演示组合：第一次打开就能跑通完整流程。
    const hasNonMock = models.some((model) => model.available && model.provider !== "mock");
    const connected = new Set(providers.filter((p) => p.connected).map((p) => p.id));
    if (hasNonMock) {
      const pool = DEFAULT_POOL.filter((entry) => connected.has(entry.provider));
      setParticipants(pool.length > 0 ? pool : DEFAULT_POOL);
    } else {
      setParticipants(demoParticipants());
    }
  }, [loading.models, loading.providers, models, providers]);

  useEffect(() => {
    // 初始化完成前不写盘，否则会把空数组覆盖到已保存的编排上。
    if (!initializedRef.current) return;
    writeJson(LS.participants, participants);
  }, [participants]);

  useEffect(() => {
    writeJson(LS.mode, mode);
  }, [mode]);

  useEffect(() => {
    writeJson(LS.options, options);
  }, [options]);

  useEffect(() => {
    writeJson(LS.judge, judgeKey);
  }, [judgeKey]);

  useEffect(() => {
    writeJson(LS.coordination, coordination);
  }, [coordination]);

  useEffect(() => {
    writeJson(LS.roleEnabled, roleEnabled);
  }, [roleEnabled]);

  useEffect(() => {
    writeJson(LS.useMemory, useMemory);
  }, [useMemory]);

  useEffect(() => {
    writeJson(LS.customModels, customModels);
  }, [customModels]);

  const judgeSpec = useMemo<ParticipantSpec | undefined>(() => {
    if (!judgeKey) return undefined;
    const found = participants.find((p) => keyOf(p) === judgeKey);
    return found ? { provider: found.provider, model: found.model, role: found.role } : undefined;
  }, [judgeKey, participants]);

  /* ---------- participants mutations ---------- */

  const addParticipant = useCallback(
    (provider: ProviderId, model: string) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.provider === provider && p.model === model)) return prev;
        if (prev.length >= MAX_PARTICIPANTS) {
          pushToast("warn", `最多 ${MAX_PARTICIPANTS} 个参与模型`);
          return prev;
        }
        return [...prev, { provider, model, role: defaultRole(prev.length), effort: "medium" }];
      });
    },
    [pushToast],
  );

  const removeParticipant = useCallback(
    (index: number) => {
      const target = participants[index];
      if (!target) return;
      const targetKey = keyOf(target);
      const next = participants.filter((_, i) => i !== index);
      setParticipants(next);
      if (!next.some((p) => keyOf(p) === targetKey)) {
        setJudgeKeyState((prev) => (prev === targetKey ? null : prev));
      }
    },
    [participants],
  );


  const setChatModel = useCallback((spec: ParticipantSpec | null) => {
    setChatModelState(spec);
    chatModelRef.current = spec;
    writeJson(LS.chatModel, spec);
  }, []);

  /** 进入 Chat 时保证有一个模型可用（默认第一个可用模型 / 目录里的第一个）。 */
  const ensureChatModel = useCallback((): ParticipantSpec | null => {
    const current = chatModelRef.current;
    if (current) return current;
    const available = models.find((model) => model.available) ?? models[0];
    if (!available) return null;
    const next: ParticipantSpec = {
      provider: available.provider,
      model: available.id,
      relayId: available.relayId,
      effort: "medium",
      role: "通用对话助手",
    };
    setChatModel(next);
    return next;
  }, [models, setChatModel]);

  const setMode = useCallback(
    (next: RunMode) => {
      setModeState(next);
      if (next === "chat") ensureChatModel();
    },
    [ensureChatModel],
  );

  const handoffToChat = useCallback(
    (spec?: ParticipantSpec) => {
      const source = spec ?? chatModelRef.current ?? runRef.current?.participants[0];
      if (source) {
        setChatModel({
          provider: source.provider,
          model: source.model,
          relayId: source.relayId,
          effort: source.effort ?? "medium",
          role: "通用对话助手",
        });
      } else {
        ensureChatModel();
      }
      setModeState("chat");
      document.getElementById("command-input")?.focus();
      pushToast("info", "已切到 Chat：下一条消息由这个模型接着聊，会带上当前工作的上下文", undefined, 4200);
    },
    [ensureChatModel, pushToast, setChatModel],
  );

  const handoffToTeam = useCallback(
    (target: RunMode = "parallel") => {
      setModeState(target === "coordinate" ? "coordinate" : "parallel");
      document.getElementById("command-input")?.focus();
      pushToast(
        "info",
        target === "coordinate"
          ? "已切到配合：下一条命令由已配置的角色团队接着做，会带上 Chat 上下文"
          : "已切到并行：下一条命令由已选模型团队接着做，会带上 Chat 上下文",
        undefined,
        4200,
      );
    },
    [pushToast],
  );

  const toggleParticipant = useCallback((spec: ParticipantSpec) => {
    const key = keyOf(spec);
    setParticipants((prev) => {
      // 同一模型可以因「不同角色」存在多份；这里只删最后一份，避免点一下把同模型全部移除。
      let removeAt = -1;
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        if (keyOf(prev[i]!) === key) {
          removeAt = i;
          break;
        }
      }
      if (removeAt >= 0) return prev.filter((_, i) => i !== removeAt);
      if (prev.length >= MAX_PARTICIPANTS) return prev;
      return [
        ...prev,
        {
          provider: spec.provider,
          model: spec.model,
          relayId: spec.relayId,
          effort: spec.effort ?? "medium",
          role: defaultRole(prev.length),
        },
      ];
    });
  }, []);

  // 裁判模型必须仍在编队里；删掉最后一份后清空，避免静默调用一个不存在的模型。
  useEffect(() => {
    if (judgeKey && !participants.some((p) => keyOf(p) === judgeKey)) setJudgeKeyState(null);
  }, [judgeKey, participants]);

  const updateRole = useCallback((index: number, role: string) => {
    setParticipants((prev) =>
      prev.map((p, i) => (i === index ? { ...p, role: role.slice(0, 60) } : p)),
    );
  }, []);

  const updateParticipantEffort = useCallback((index: number, effort: EffortLevel) => {
    setParticipants((prev) => prev.map((spec, i) => (i === index ? { ...spec, effort } : spec)));
  }, []);

  const updateRoleModelEffort = useCallback((role: string, key: string, effort: EffortLevel) => {
    setCoordination((prev) => ({
      ...prev,
      [role]: (prev[role] ?? []).map((spec) => (keyOf(spec) === key ? { ...spec, effort } : spec)),
    }));
  }, []);

  const reorderParticipants = useCallback((from: number, to: number) => {
    setParticipants((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const moveParticipant = useCallback((index: number, delta: number) => {
    setParticipants((prev) => {
      const target = index + delta;
      if (index < 0 || index >= prev.length || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      if (!moved) return prev;
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const addCustomModel = useCallback(
    (provider: ProviderId, modelId: string) => {
      const id = modelId.trim();
      if (!id) {
        pushToast("warn", "模型 ID 不能为空");
        return false;
      }
      if (id.length > 120) {
        pushToast("warn", "模型 ID 过长");
        return false;
      }
      const exists =
        models.some((m) => m.provider === provider && m.id === id) ||
        customModels.some((m) => m.provider === provider && m.id === id);
      if (exists) {
        pushToast("info", "该模型已在可选列表中");
        return false;
      }
      setCustomModels((prev) => [...prev, { id, name: id, provider }]);
      pushToast("success", `已添加模型 ${id}`);
      return true;
    },
    [customModels, models, pushToast],
  );

  const removeCustomModel = useCallback((provider: ProviderId, modelId: string) => {
    setCustomModels((prev) => prev.filter((m) => !(m.provider === provider && m.id === modelId)));
  }, []);

  /* ---------- v0.0.2 coordination ---------- */

  const toggleRoleModel = useCallback((role: string, spec: ParticipantSpec) => {
    const key = keyOf(spec);
    setCoordination((prev) => {
      const current = prev[role] ?? [];
      const exists = current.some((item) => keyOf(item) === key);
      return {
        ...prev,
        [role]: exists ? current.filter((item) => keyOf(item) !== key) : [...current, spec],
      };
    });
    setRoleEnabledState((prev) => (prev[role] ? prev : { ...prev, [role]: true }));
  }, []);

  const clearRole = useCallback((role: string) => {
    setCoordination((prev) => ({ ...prev, [role]: [] }));
  }, []);

  const setRoleEnabled = useCallback((role: string, enabled: boolean) => {
    setRoleEnabledState((prev) => ({ ...prev, [role]: enabled }));
  }, []);

  const setRoleParticipants = useCallback((role: string, specs: ParticipantSpec[]) => {
    setCoordination((prev) => ({ ...prev, [role]: specs }));
  }, []);

  const setUseMemory = useCallback((value: boolean) => setUseMemoryState(value), []);

  /* ---------- v0.0.3 settings patch / 自定义角色 / 附件 / 预算 ---------- */

  const saveSettingsPatch = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next: AppSettings = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      try {
        await api.saveSettings(next);
      } catch (err) {
        pushToast("error", "设置保存失败", errorMessage(err));
      }
    },
    [pushToast],
  );

  const persistCustomRoles = useCallback(
    (next: CustomRoleDef[]) => {
      const ordered = sortedCustomRoles(next).map((role, index) => ({
        ...role,
        order: 100 + index,
      }));
      customRolesRef.current = ordered;
      setCustomRoles(ordered);
      void saveSettingsPatch({ customRoles: ordered });
    },
    [saveSettingsPatch],
  );

  const createCustomRole = useCallback(
    (input: { name: string; description: string; kind: "text" | "image" }) => {
      const current = customRolesRef.current;
      if (current.length >= 24) {
        return { error: { ok: false, message: "自定义角色上限 24 个" } as RoleNameCheck };
      }
      const check = checkRoleName(input.name, current);
      if (!check.ok) return { error: check };
      const role: CustomRoleDef = {
        id: createCustomRoleId(),
        name: input.name.trim(),
        description: input.description.trim().slice(0, 200),
        kind: input.kind,
        order: nextCustomRoleOrder(current),
      };
      persistCustomRoles([...current, role]);
      setCoordination((prev) => ({ ...prev, [role.id]: [] }));
      setRoleEnabledState((prev) => ({ ...prev, [role.id]: true }));
      return { role };
    },
    [persistCustomRoles],
  );

  const updateCustomRole = useCallback(
    (id: string, patch: Partial<Omit<CustomRoleDef, "id">>) => {
      const current = customRolesRef.current;
      const existing = current.find((role) => role.id === id);
      if (!existing) return { ok: false, message: "角色不存在" } as RoleNameCheck;
      if (patch.name != null) {
        const check = checkRoleName(patch.name, current, id);
        if (!check.ok) return check;
      }
      const next = current.map((role) =>
        role.id === id
          ? {
              ...role,
              name: patch.name != null ? patch.name.trim() : role.name,
              description:
                patch.description != null ? patch.description.trim().slice(0, 200) : role.description,
              kind: patch.kind ?? role.kind,
              order: patch.order ?? role.order,
            }
          : role,
      );
      persistCustomRoles(next);
      return { ok: true } as RoleNameCheck;
    },
    [persistCustomRoles],
  );

  const deleteCustomRole = useCallback(
    (id: string) => {
      persistCustomRoles(customRolesRef.current.filter((role) => role.id !== id));
      setCoordination((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setRoleEnabledState((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [persistCustomRoles],
  );

  const duplicateCustomRole = useCallback(
    (id: string) => {
      const current = customRolesRef.current;
      const source = current.find((role) => role.id === id);
      if (!source) return undefined;
      if (current.length >= 24) {
        pushToast("warn", "自定义角色上限 24 个");
        return undefined;
      }
      const role: CustomRoleDef = {
        ...source,
        id: createCustomRoleId(),
        name: duplicateRoleName(source.name, current),
        order: nextCustomRoleOrder(current),
      };
      persistCustomRoles([...current, role]);
      setCoordination((prev) => ({ ...prev, [role.id]: [...(prev[id] ?? [])] }));
      setRoleEnabledState((prev) => ({ ...prev, [role.id]: true }));
      return role;
    },
    [persistCustomRoles, pushToast],
  );

  const reorderCustomRoles = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const current = customRolesRef.current;
      const fromIndex = current.findIndex((role) => role.id === fromId);
      const toIndex = current.findIndex((role) => role.id === toId);
      if (fromIndex < 0 || toIndex < 0) return;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return;
      next.splice(toIndex, 0, moved);
      persistCustomRoles(next);
    },
    [persistCustomRoles],
  );

  const moveCustomRole = useCallback(
    (id: string, delta: number) => {
      const current = customRolesRef.current;
      const index = current.findIndex((role) => role.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return;
      next.splice(target, 0, moved);
      persistCustomRoles(next);
    },
    [persistCustomRoles],
  );

  const stopUploadTimer = useCallback((localId: string) => {
    const timer = uploadTimers.current.get(localId);
    if (timer) {
      clearInterval(timer);
      uploadTimers.current.delete(localId);
    }
  }, []);

  const patchAttachment = useCallback((localId: string, patch: Partial<AttachmentDraft>) => {
    setAttachments((prev) =>
      prev.map((draft) => (draft.localId === localId ? { ...draft, ...patch } : draft)),
    );
  }, []);

  const runUpload = useCallback(
    async (localId: string, file: File) => {
      stopUploadTimer(localId);
      patchAttachment(localId, { stage: "uploading", progress: 3, error: undefined, file });
      const timer = setInterval(() => {
        setAttachments((prev) =>
          prev.map((draft) =>
            draft.localId === localId && draft.stage === "uploading"
              ? { ...draft, progress: Math.min(92, draft.progress + Math.max(2, Math.round((92 - draft.progress) / 7))) }
              : draft,
          ),
        );
      }, 220);
      uploadTimers.current.set(localId, timer);
      try {
        const dataBase64 = await readFileBase64(file);
        const res = await api.uploadFile(
          {
            name: file.name || "剪贴板文件",
            mime: file.type || "application/octet-stream",
            size: file.size,
            dataBase64,
          },
          (percent) => {
            setAttachments((prev) =>
              prev.map((draft) =>
                draft.localId === localId
                  ? { ...draft, progress: Math.max(draft.progress, Math.min(95, percent)) }
                  : draft,
              ),
            );
          },
        );
        const meta = res?.attachment;
        if (!meta || typeof meta.id !== "string") {
          throw new ApiError("上传接口未返回附件信息", { code: "bad_response" });
        }
        setAttachments((prev) =>
          prev.map((draft) =>
            draft.localId === localId
              ? applyUploadMeta(draft, {
                  id: meta.id,
                  name: meta.name,
                  mime: meta.mime,
                  size: meta.size,
                  kind: meta.kind,
                  chars: meta.chars,
                  preview: meta.preview,
                  dataUrl: meta.dataUrl,
                  path: meta.path,
                  text: meta.text,
                  error: meta.error,
                })
              : draft,
          ),
        );
      } catch (err) {
        setAttachments((prev) =>
          prev.map((draft) =>
            draft.localId === localId
              ? { ...draft, stage: "error", progress: 100, error: errorMessage(err) }
              : draft,
          ),
        );
        pushToast("warn", "附件上传失败", `${file.name}：${errorMessage(err)}`);
      } finally {
        stopUploadTimer(localId);
      }
    },
    [patchAttachment, pushToast, stopUploadTimer],
  );

  const addAttachmentFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { accepted, rejected } = filterFiles(files, attachmentsRef.current.length);
      for (const item of rejected.slice(0, 3)) {
        pushToast("warn", "已跳过附件", `${item.name}：${item.reason}`);
      }
      if (accepted.length === 0) return;
      const drafts = accepted.map(draftFromFile);
      attachmentsRef.current = [...attachmentsRef.current, ...drafts];
      setAttachments((prev) => [...prev, ...drafts]);
      setExpandedAttachmentId(drafts[0]?.localId ?? null);
      for (const draft of drafts) {
        if (draft.file) void runUpload(draft.localId, draft.file);
      }
    },
    [pushToast, runUpload],
  );

  const retryAttachment = useCallback(
    (localId: string) => {
      const draft = attachmentsRef.current.find((item) => item.localId === localId);
      if (!draft?.file) {
        pushToast("warn", "无法重试：原文件已不可用，请重新选择");
        return;
      }
      void runUpload(localId, draft.file);
    },
    [pushToast, runUpload],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      stopUploadTimer(localId);
      setAttachments((prev) => {
        const next = prev.filter((draft) => draft.localId !== localId);
        attachmentsRef.current = next;
        return next;
      });
      setExpandedAttachmentId((prev) => (prev === localId ? null : prev));
    },
    [stopUploadTimer],
  );

  const clearAttachments = useCallback(() => {
    for (const timer of uploadTimers.current.values()) clearInterval(timer);
    uploadTimers.current.clear();
    attachmentsRef.current = [];
    setAttachments([]);
    setExpandedAttachmentId(null);
  }, []);

  const cheapMode = settings.budgets?.cheapMode === true;

  const setCheapMode = useCallback(
    async (value: boolean) => {
      const budgets = { ...(settingsRef.current.budgets ?? DEFAULT_BUDGETS), cheapMode: value };
      await saveSettingsPatch({ budgets });
      pushToast("info", value ? "省钱模式已开启" : "省钱模式已关闭", value ? "默认档位 low、关闭互评、压缩上下文" : "恢复常规档位与上下文");
    },
    [pushToast, saveSettingsPatch],
  );

  const attachmentBusy = useMemo(() => anyAttachmentBusy(attachments), [attachments]);
  const attachmentTokens = useMemo(() => totalAttachmentTokens(attachments), [attachments]);

  const roleIds = useMemo(
    () => [...COORD_ROLES.map((role) => role.id as string), ...sortedCustomRoles(customRoles).map((role) => role.id)],
    [customRoles],
  );

  const coordinationAssignments = useMemo<CoordinationAssignment[]>(
    () =>
      roleIds
        .filter((roleId) => roleEnabled[roleId] !== false)
        .map((roleId) => ({ role: roleId, participants: coordination[roleId] ?? [] }))
        .filter((assignment) => assignment.participants.length > 0),
    [coordination, roleEnabled, roleIds],
  );

  /* ---------- settings / ui ---------- */

  const openSettings = useCallback((provider?: ProviderId | null, section?: SettingsSection) => {
    setSettingsProvider(provider ?? null);
    if (section) setSettingsSection(section);
    else if (provider) setSettingsSection("providers");
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    writeJson(LS.banner, true);
  }, []);

  const saveSettings = useCallback(
    async (next: AppSettings) => {
      try {
        const saved = await api.saveSettings(next);
        setSettings(saved);
        pushToast("success", "设置已保存");
      } catch (err) {
        setSettings(next);
        pushToast("error", "设置保存失败", errorMessage(err));
      }
    },
    [pushToast],
  );

  /* ---------- streaming ---------- */

  const stopStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
  }, []);

  const mapStreamStatus = (status: StreamStatus, detail?: string): void => {
    const map: Record<StreamStatus, StreamStatusLabel> = {
      connecting: "connecting",
      open: "open",
      reconnecting: "reconnecting",
      closed: "closed",
      failed: "failed",
    };
    dispatchRun({ type: "stream-status", status: map[status] });
    if (status === "reconnecting") {
      pushToast("warn", "事件流中断，正在自动重连…", detail);
    }
  };

  /** 回读上下文摘要，推导本次注入的记忆条数（RunDetail 可能不回传 options.memoryIds）。 */
  const enrichMemoryCount = useCallback(async (targetId: string) => {
    try {
      const summary = await api.getRunContext(targetId);
      const ids = new Set<string>();
      for (const call of summary.calls ?? []) {
        for (const id of call.injectedMemoryIds ?? []) ids.add(id);
      }
      if (ids.size > 0 && mountedRef.current && runRef.current?.id === targetId) {
        dispatchRun({ type: "memory-count", count: ids.size });
      }
    } catch {
      /* 上下文接口未就绪时按 0 展示 */
    }
  }, []);

  /** 运行结束后回读详情：补齐各阶段发言（stages）、usage、记忆注入与最终答案。 */
  const enrichRun = useCallback(
    async (targetId: string) => {
      const current = runRef.current;
      if (!current || current.id !== targetId) return;
      try {
        const detail = await api.getRun(targetId);
        if (!mountedRef.current) return;
        if (runRef.current?.id !== targetId) return;
        dispatchRun({ type: "snapshot", detail, now: Date.now() });
      } catch {
        /* 详情补齐失败不影响已经流式展示的内容 */
      }
      void enrichMemoryCount(targetId);
    },
    [enrichMemoryCount],
  );

  const attachStream = useCallback(
    (runId: string) => {
      stopStream();
      streamRef.current = api.openRunStream(runId, {
        onSnapshot: (detail) => {
          if (!mountedRef.current) return;
          dispatchRun({ type: "snapshot", detail, now: Date.now() });
          if (detail.status !== "running") {
            stopStream();
            void refreshHistory();
            setTimeout(() => void refreshHistory(), 900);
          }
        },
        onEvent: (event) => {
          if (!mountedRef.current) return;
          dispatchRun({ type: "event", event, now: Date.now() });
          if (event.type === "run.done" || event.type === "run.error") {
            // 不能立刻 abort：服务端通常在发完 run.done 后才落库并关闭连接，
            // 提前断开会让本次运行在历史里停留在"进行中"。等它自然关闭，2.5s 兜底。
            const handle = streamRef.current;
            setTimeout(() => {
              if (streamRef.current === handle) stopStream();
            }, 2500);
            void refreshHistory();
            void refreshBudget();
            setTimeout(() => void refreshHistory(), 900);
            // 回读详情，补齐 ParticipantResult.stages（卡片按阶段切换需要）。
            const targetId = event.type === "run.done" ? event.runId : runRef.current?.id;
            if (targetId) setTimeout(() => void enrichRun(targetId), 600);
          }
        },
        onStatus: (status, detail) => {
          if (!mountedRef.current) return;
          mapStreamStatus(status, detail);
        },
        onError: (err) => {
          if (!mountedRef.current) return;
          if (err.code !== "network") pushToast("warn", "事件流读取失败，正在重试", err.message);
        },
        onClose: (reason) => {
          if (!mountedRef.current) return;
          streamRef.current = null;
          if (reason === "done") {
            void refreshHistory();
            return;
          }
          if (reason === "aborted") return;
          // 服务端提前关闭或连接失败：回读一次详情兜底。
          void (async () => {
            try {
              const detail = await api.getRun(runId);
              if (!mountedRef.current) return;
              dispatchRun({ type: "snapshot", detail, now: Date.now() });
              void refreshHistory();
            } catch (err) {
              if (!mountedRef.current) return;
              dispatchRun({
                type: "fail",
                message: `运行已中断：${errorMessage(err)}`,
                now: Date.now(),
              });
            }
          })();
        },
      }, {});
    },
    [enrichRun, pushToast, refreshBudget, refreshHistory, stopStream],
  );

  const completeStart = useCallback(
    (createdId: string, payload: CreateRunRequest, meta?: { threadId?: string; round?: number }) => {
      setFollowUp(null);
      clearAttachments();
      // 接续对话：把刚结束的上一轮收进对话历史（新工作不保留旧轮次）。
      setPastRounds((prev) => {
        const current = runRef.current;
        if (!current || current.id === createdId) return prev;
        if (!meta?.threadId || current.threadId !== meta.threadId) return prev;
        if (prev.some((item) => item.id === current.id)) return prev;
        return [...prev, current];
      });
      const budgetsNow = settingsRef.current.budgets;
      dispatchRun({
        type: "begin",
        id: createdId,
        command: payload.command,
        mode: payload.mode,
        participants: payload.participants,
        coordination: payload.mode === "coordinate" ? payload.coordination : undefined,
        attachments: (payload.attachments ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          mime: item.mime,
          size: item.size ?? 0,
          kind: item.kind,
          path: item.path,
          chars: item.text?.length,
        })),
        guard: {
          cheapMode: budgetsNow?.cheapMode === true,
          budgets: {
            perRunTokens: budgetsNow?.perRunTokenLimit,
            perRunCost: budgetsNow?.perRunCostLimit,
            currency: budgetsNow?.currency,
            blocked: false,
          },
        },
        judge: payload.judge
          ? {
              label: labelFor(payload.judge.provider, payload.judge.model),
              provider: payload.judge.provider,
              model: payload.judge.model,
            }
          : undefined,
        threadId: meta?.threadId,
        round: meta?.round,
        now: Date.now(),
      });
      setNow(Date.now());
      attachStream(createdId);
      void refreshBudget();
    },
    [attachStream, clearAttachments, refreshBudget],
  );

  const launchRun = useCallback(
    async (payload: CreateRunRequest, force: boolean) => {
      const body = force ? ({ ...payload, force: true } as CreateRunRequest) : payload;
      const created = await api.createRun(body);
      if (!mountedRef.current) return;
      completeStart(created.id, payload, {
        threadId: created.run?.threadId ?? payload.threadId ?? created.id,
        round: created.run?.round ?? 1,
      });
    },
    [completeStart],
  );

  const startRun = useCallback(
    async (overrides?: StartRunOverrides) => {
      const text = (overrides?.command ?? command).trim();
      const runMode = overrides?.mode ?? mode;
      const chat = runMode === "chat";
      const chatSpec = chat ? chatModelRef.current ?? ensureChatModel() : null;
      const specs = (overrides?.participants ?? (chat ? (chatSpec ? [chatSpec] : []) : participants))
        .map((spec) => ({
          provider: spec.provider,
          model: spec.model,
          relayId: spec.relayId,
          effort: spec.effort ?? "medium",
          role: (spec.role ?? "").trim() || undefined,
        }))
        .filter((spec) => spec.model.length > 0);

      const coordinate = runMode === "coordinate";
      const assignments = coordinate ? coordinationAssignments : [];
      const coordinationSpecs = assignments.flatMap((assignment) => assignment.participants);

      if (!text) {
        pushToast("warn", "先在命令台输入一条命令");
        return;
      }
      if (chat && specs.length !== 1) {
        pushToast("warn", "Chat 模式需要选择一个模型", "Chat 每次只能和一个模型聊天；在右栏「Chat 模型」里选一个。", 5000);
        return;
      }
      if (coordinate ? coordinationSpecs.length === 0 : specs.length === 0) {
        pushToast(
          "warn",
          coordinate ? "配合模式还没有配置任何角色模型" : "至少选择一个参与模型",
        );
        return;
      }
      if (runRef.current?.state === "running") {
        pushToast("info", "上一次运行还在进行中");
        return;
      }
      const drafts = attachmentsRef.current;
      if (anyAttachmentBusy(drafts)) {
        pushToast("warn", "附件仍在上传或解析中", "等附件处理完成后才能运行");
        return;
      }
      const readyDrafts = drafts.filter((draft) => draft.stage === "ready" && draft.id);
      const attachmentInputs = readyAttachmentInputs(drafts);
      const attachTokens = totalAttachmentTokens(readyDrafts);
      const budgetsNow = settingsRef.current.budgets;
      const performanceNow = settingsRef.current.performance;
      if (budgetsNow?.perRunTokenLimit && attachTokens > budgetsNow.perRunTokenLimit) {
        pushToast(
          "error",
          "附件超出单次运行 token 上限",
          `附件约 ${attachTokens} tokens，上限 ${budgetsNow.perRunTokenLimit}；请移除部分附件或调高预算。`,
          8_000,
        );
        return;
      }

      // parallel 的裁判是可选的：未选裁判时服务端按顺序拼接各答案。
      const judge = JUDGE_MODES.includes(runMode)
        ? judgeSpec
          ? { provider: judgeSpec.provider, model: judgeSpec.model, role: judgeSpec.role }
          : runMode === "parallel" || specs.length === 0
            ? undefined
            : { provider: specs[0]!.provider, model: specs[0]!.model, role: specs[0]!.role }
        : undefined;
      const payload: CreateRunRequest = {
        command: text,
        mode: runMode,
        // 有多轮对话时：沿用当前工作 id，服务端自动带上前面几轮的命令与最终答案。
        threadId: overrides?.newThread ? undefined : runRef.current?.threadId ?? undefined,
        participants: coordinate ? coordinationSpecs : specs,
        coordination: coordinate
          ? assignments.map((assignment) => ({
              role: assignment.role,
              participants: assignment.participants.map((spec) => ({
                provider: spec.provider,
                model: spec.model,
                relayId: spec.relayId,
                effort: spec.effort ?? "medium",
                role: spec.role,
              })),
            }))
          : undefined,
        judge,
        attachments: attachmentInputs.length > 0 ? attachmentInputs : undefined,
        options: {
          rounds: options.rounds,
          critique: options.critique,
          language: settings.language,
          timeoutMs: performanceNow?.timeoutMs ?? settings.timeoutMs,
          useMemory,
          cheapMode: budgetsNow?.cheapMode === true,
          perCallMaxTokens: budgetsNow?.perCallMaxTokens,
          concurrency: performanceNow?.concurrency,
          performance: performanceNow,
          budgetLimitTokens: budgetsNow?.perRunTokenLimit,
          budgetLimitCost: budgetsNow?.perRunCostLimit,
          budgetCurrency: budgetsNow?.currency,
          customRoles: coordinate ? customRolesRef.current : undefined,
        },
      };

      // 新工作：清空上一段对话的轮次，避免把旧轮次混进新工作。
      if (overrides?.newThread || !runRef.current?.threadId) setPastRounds([]);
      setBusy(true);
      try {
        await launchRun(payload, false);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setPendingConfirm({
            message: err.message,
            detail: err.detail,
            payload,
            source: "budget",
          });
          return;
        }
        pushToast("error", "运行创建失败", errorMessage(err));
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [
      command,
      coordinationAssignments,
      followUp,
      judgeSpec,
      launchRun,
      mode,
      options,
      participants,
      pushToast,
      settings,
      useMemory,
    ],
  );

  const confirmRun = useCallback(async () => {
    const pending = pendingConfirm;
    if (!pending) return;
    setPendingConfirm(null);
    setBusy(true);
    try {
      await launchRun(pending.payload, true);
    } catch (err) {
      pushToast("error", "确认后仍无法开始运行", errorMessage(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [launchRun, pendingConfirm, pushToast]);

  const cancelConfirm = useCallback(() => setPendingConfirm(null), []);

  const stopRun = useCallback(async () => {
    const current = runRef.current;
    if (!current || current.state !== "running") return;
    const id = current.id;
    try {
      await api.cancelRun(id);
      pushToast("info", "已请求停止运行");
      // 若当前没有事件流（例如打开的是历史里"运行中"的记录），主动回读状态，
      // 避免 UI 永远停在"运行中"。
      setTimeout(() => {
        void (async () => {
          if (runRef.current?.id !== id || runRef.current.state !== "running") return;
          try {
            const detail = await api.getRun(id);
            if (!mountedRef.current) return;
            dispatchRun({ type: "snapshot", detail, now: Date.now() });
            if (detail.status === "running") {
              dispatchRun({ type: "fail", message: "已请求停止，但服务端仍未结束该运行。", now: Date.now() });
            }
            void refreshHistory();
          } catch {
            if (!mountedRef.current) return;
            dispatchRun({ type: "fail", message: "已请求停止运行。", now: Date.now() });
          }
        })();
      }, 1200);
    } catch (err) {
      pushToast("error", "停止失败", errorMessage(err));
    }
  }, [pushToast, refreshHistory]);

  const changeRunEffort = useCallback(
    async (participantId: string, effort: EffortLevel) => {
      const current = runRef.current;
      if (!current || current.state !== "running") {
        pushToast("warn", "运行已结束，强度未生效");
        return;
      }
      if (participantId.startsWith("spec-")) {
        pushToast("info", "运行还在启动，稍后再调整强度");
        return;
      }
      dispatchRun({ type: "effort-pending", participantId, effort });
      try {
        const res = await api.setRunEffort(current.id, participantId, effort);
        const applied = res.effort ?? effort;
        dispatchRun({ type: "effort-pending", participantId, effort: applied });
        pushToast("success", `已更新为 ${effortName(applied)}，下一次调用生效`, undefined, 2000);
      } catch (err) {
        // 回滚基线是「服务端已生效」的 effort：清掉 pending 即回到最后已生效值。
        dispatchRun({ type: "effort-clear", participantId });
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          pushToast("warn", "运行已结束，强度未生效");
        } else if (err instanceof ApiError && err.code === "network") {
          pushToast("error", "强度更新失败（服务不可达），已回滚");
        } else {
          pushToast("error", "强度更新失败，已回滚", errorMessage(err));
        }
      }
    },
    [pushToast],
  );

  /** 运行中单独停止某个模型：只停这一个，其余继续；状态由 SSE 的 model.stopped 回写。 */
  const stopParticipant = useCallback(
    async (participantId: string) => {
      const current = runRef.current;
      if (!current || current.state !== "running") {
        pushToast("warn", "运行已结束，无法单独停止模型");
        return;
      }
      try {
        await api.stopRunParticipant(current.id, participantId);
        pushToast("info", "已停止该模型，其余模型继续", undefined, 2500);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // 已结束/已停止：拉一次快照收敛状态，不显示红色错误
          pushToast("warn", "该模型已经停止或运行已结束");
          try {
            const detail = await api.getRun(current.id);
            if (mountedRef.current && detail.id === current.id) {
              dispatchRun({ type: "snapshot", detail, now: Date.now() });
            }
          } catch {
            /* 快照失败就保持现状 */
          }
        } else {
          pushToast("error", "未能停止，请重试", errorMessage(err));
        }
      }
    },
    [pushToast],
  );


  /** 套用团队模板：整体替换并行参与者与配合角色配置，并恢复模式 / 裁判。 */
  const applyTeamTemplate = useCallback(
    (input: {
      mode: RunMode;
      participants: ParticipantSpec[];
      coordination: CoordinationAssignment[];
      judge?: ParticipantSpec;
    }) => {
      if (runRef.current?.state === "running") {
        pushToast("warn", "运行中不能套用团队模板");
        return;
      }
      setModeState(input.mode);
      setParticipants(input.participants.slice(0, MAX_PARTICIPANTS).map((spec) => ({ ...spec })));
      const next = {} as CoordinationState;
      const roleKeys = new Set<string>([
        ...COORD_ROLES.map((role) => role.id as string),
        ...customRolesRef.current.map((role) => role.id),
        ...input.coordination.map((assignment) => assignment.role),
      ]);
      for (const roleId of roleKeys) next[roleId] = [];
      for (const assignment of input.coordination) {
        next[assignment.role] = assignment.participants.map((spec) => ({ ...spec }));
      }
      setCoordination(next);
      const enabled = {} as RoleEnabledState;
      for (const roleId of roleKeys) enabled[roleId] = true;
      setRoleEnabledState(enabled);
      setJudgeKeyState(input.judge ? keyOf(input.judge) : null);
      setPastRounds([]);
      dispatchRun({ type: "reset" });
      pushToast("success", "已套用团队模板", undefined, 2200);
    },
    [pushToast],
  );

  const rerun = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    await startRun({
      command: current.command,
      mode: current.mode,
      newThread: true,
      participants: current.participants.map((participant) => ({
        provider: participant.provider,
        model: participant.model,
        role: participant.role,
        effort: participant.effort,
      })),
    });
  }, [startRun]);

  const resynthesize = useCallback(async () => {
    const current = runRef.current;
    if (!current || !current.finalText.trim()) return;
    const anchor =
      current.participants.find((participant) => participant.state === "done") ?? current.participants[0];
    if (!anchor) {
      pushToast("warn", "这次运行没有可用的参与者输出");
      return;
    }
    const command = [
      "请基于下面的原始命令与多方答案，重新综合一版更准确、更有条理的最终答案。",
      "不要复述提示词，直接给出结论；若多方答案存在冲突，明确指出采用哪一方及理由。",
      "",
      `原始命令：`,
      current.command,
      "",
      "多方答案摘录：",
      ...current.participants
        .filter((participant) => participant.text.trim())
        .slice(0, 6)
        .map((participant) => `- ${participant.label}（${participant.role}）：${truncate(participant.text, 700)}`),
    ].join("\n");
    await startRun({
      command,
      mode: "council",
      newThread: true,
      participants: [{ provider: anchor.provider, model: anchor.model, role: "总协调 / 重新综合" }],
    });
  }, [pushToast, startRun]);

  const loadRun = useCallback(
    async (id: string) => {
      stopStream();
      dispatchRun({ type: "loading", id });
      try {
        const detail = await api.getRun(id);
        if (!mountedRef.current) return;
        dispatchRun({ type: "snapshot", detail, now: Date.now() });
        // 打开历史运行时：把右栏编排还原成这次运行实际用的模式与角色，而不是编辑器当前状态。
        if (detail.mode === "coordinate" && detail.coordination && detail.coordination.length > 0) {
          setModeState("coordinate");
          setCoordination(() => {
            const next = {} as CoordinationState;
            const roleKeys = new Set<string>([
              ...COORD_ROLES.map((role) => role.id as string),
              ...customRolesRef.current.map((role) => role.id),
              ...(detail.coordination ?? []).map((assignment) => assignment.role),
            ]);
            for (const roleId of roleKeys) next[roleId] = [];
            for (const assignment of detail.coordination ?? []) {
              next[assignment.role] = (assignment.participants ?? []).map((spec) => ({ ...spec }));
            }
            return next;
          });
          setRoleEnabledState(() => {
            const enabled = {} as RoleEnabledState;
            const roleKeys = new Set<string>([
              ...COORD_ROLES.map((role) => role.id as string),
              ...customRolesRef.current.map((role) => role.id),
              ...(detail.coordination ?? []).map((assignment) => assignment.role),
            ]);
            for (const roleId of roleKeys) enabled[roleId] = true;
            return enabled;
          });
        } else {
          setModeState(detail.mode === "coordinate" ? "coordinate" : detail.mode === "chat" ? "chat" : "parallel");
          if (detail.mode === "chat") {
            const first = detail.participants[0];
            if (first) {
              setChatModel({
                provider: first.provider,
                model: first.model,
                effort: first.effort ?? "medium",
                role: first.role,
              });
            }
          }
          if (detail.participants.length > 0) {
            setParticipants(
              detail.participants.map((p) => ({
                provider: p.provider,
                model: p.model,
                role: p.role,
                effort: p.effort,
              })),
            );
          }
        }
        void enrichMemoryCount(detail.id);
        // 历史里点开一个"运行中"的 run：接回事件流，继续看剩余输出。
        if (detail.status === "running") {
          attachStream(detail.id);
        } else {
          void refreshHistory();
        }
      } catch (err) {
        if (!mountedRef.current) return;
        dispatchRun({ type: "reset" });
        pushToast("error", "加载运行详情失败", errorMessage(err));
      }
    },
    [attachStream, enrichMemoryCount, pushToast, refreshHistory, stopStream],
  );

  /** 打开一个工作：把前面几轮还原成对话历史，最后一轮作为当前运行。 */
  const loadThread = useCallback(
    async (threadId: string) => {
      try {
        const detail = await api.getThread(threadId);
        if (!mountedRef.current) return;
        const views = detail.runs.map(viewFromDetail);
        const last = views[views.length - 1];
        if (!last) {
          pushToast("warn", "这个工作里还没有运行");
          return;
        }
        setPastRounds(views.slice(0, -1));
        await loadRun(last.id);
      } catch (err) {
        if (!mountedRef.current) return;
        pushToast("error", "加载工作失败", errorMessage(err));
      }
    },
    [loadRun, pushToast],
  );

  const resetRun = useCallback(() => {
    stopStream();
    dispatchRun({ type: "reset" });
    setPastRounds([]);
    setFollowUp(null);
  }, [stopStream]);

  const runDemo = useCallback(async () => {
    const demo = demoParticipants();
    setParticipants(demo);
    setModeState("parallel");
    setCommand(DEMO_COMMAND);
    setPastRounds([]);
    await startRun({ command: DEMO_COMMAND, mode: "parallel", participants: demo, newThread: true });
  }, [startRun]);

  // 多轮对话上线后，"继续追问"不再把上一轮答案塞进命令里：
  // 直接聚焦命令台，运行时会自动带上本工作的前几轮。
  const beginFollowUp = useCallback(() => {
    const input = document.getElementById("command-input") as HTMLTextAreaElement | null;
    input?.focus();
    pushToast("info", "直接在命令台输入下一轮即可，会自动带上前面的对话", undefined, 3000);
  }, [pushToast]);

  const clearFollowUp = useCallback(() => setFollowUp(null), []);

  /* ---------- derived ---------- */

  const connectedProviderCount = useMemo(
    () => providers.filter((provider) => provider.connected).length,
    [providers],
  );
  const availableModelCount = useMemo(
    () => models.filter((model) => model.available).length,
    [models],
  );
  const hasConnection = connectedProviderCount > 0;
  const initialLoading = loading.providers && loading.models && loading.history;
  const offline = !server.online && server.checkedAt > 0;
  const budgets = settings.budgets ?? DEFAULT_BUDGETS;
  const performance = settings.performance ?? DEFAULT_PERFORMANCE;
  const keywords = settings.keywords ?? [];

  return {
    providers,
    models,
    customModels,
    history,
    threads,
    pastRounds,
    settings,
    server,
    loading,
    initialLoading,
    offline,
    hasConnection,
    connectedProviderCount,
    availableModelCount,
    participants,
    mode,
    setMode,
    chatModel,
    setChatModel,
    handoffToChat,
    handoffToTeam,
    command,
    setCommand,
    rounds: options.rounds,
    setRounds: (value: number) =>
      setOptions((prev) => ({ ...prev, rounds: Math.min(5, Math.max(1, value)) })),
    critique: options.critique,
    setCritique: (value: boolean) => setOptions((prev) => ({ ...prev, critique: value })),
    judgeKey,
    setJudgeKey: setJudgeKeyState,
    coordination,
    roleEnabled,
    coordinationAssignments,
    toggleRoleModel,
    clearRole,
    setRoleEnabled,
    setRoleParticipants,
    updateParticipantEffort,
    updateRoleModelEffort,
    changeRunEffort,
    stopParticipant,
    applyTeamTemplate,
    useMemory,
    setUseMemory,
    customRoles,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    duplicateCustomRole,
    reorderCustomRoles,
    moveCustomRole,
    attachments,
    attachmentBusy,
    attachmentTokens,
    expandedAttachmentId,
    setExpandedAttachmentId,
    addAttachmentFiles,
    retryAttachment,
    removeAttachment,
    clearAttachments,
    budgets,
    performance,
    keywords,
    cheapMode,
    setCheapMode,
    budgetUsage,
    budgetUsageFailed,
    budgetLoading,
    refreshBudget,
    pendingConfirm,
    confirmRun,
    cancelConfirm,
    saveSettingsPatch,
    run,
    busy,
    now,
    toasts,
    dismissToast,
    pushToast,
    settingsOpen,
    settingsProvider,
    settingsSection,
    openSettings,
    closeSettings,
    bannerDismissed,
    dismissBanner,
    followUp,
    beginFollowUp,
    clearFollowUp,
    startRun,
    stopRun,
    rerun,
    resynthesize,
    loadRun,
    loadThread,
    resetRun,
    runDemo,
    addParticipant,
    toggleParticipant,
    removeParticipant,
    updateRole,
    reorderParticipants,
    moveParticipant,
    addCustomModel,
    removeCustomModel,
    refreshProviders,
    refreshModels,
    refreshHistory,
    refreshAll,
    saveSettings,
    setServerOnline,
    judgeSpec,
  };
}

/* ---------------------------------------------------------------- helpers */

function buildFollowUpCommand(context: FollowUpContext, question: string): string {
  return [
    "【基于上一轮联合工作的最终答案继续追问】",
    `上一轮命令：${context.command}`,
    "",
    "上一轮最终答案：",
    tail(context.finalText, 1600),
    "",
    `追问：${question}`,
  ].join("\n");
}

