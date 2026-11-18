import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelInfo,
  ModelOption,
  ParticipantSpec,
  WorkflowCreateRequest,
  WorkflowDef,
  WorkflowRun,
  WorkflowStep,
} from "@super-work/core";
import { BUILTIN_WORKFLOWS } from "@super-work/core";
import { api, errorMessage, isApiError, type WorkflowStreamHandle } from "../lib/api";
import { formatDuration, formatRelative, formatTokens, truncate } from "../lib/format";
import { specFromModel, specKey } from "../lib/types";
import { RichText } from "./RichText";
import {
  IconAlert,
  IconCheck,
  IconEdit,
  IconHistory,
  IconLoader,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSave,
  IconStop,
  IconTrash,
  IconWorkflow,
  IconX,
} from "./Icons";

export interface WorkflowPageProps {
  models: ModelOption[];
  customModels: ModelInfo[];
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

interface StepDraft {
  id: string;
  name: string;
  role: string;
  modelKey: string;
  instruction: string;
  input: "command" | "previous" | "all";
  parallelGroup: string;
}

interface WorkflowDraft {
  id?: string;
  name: string;
  description: string;
  steps: StepDraft[];
}

const STEP_STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "等待", className: "is-pending" },
  running: { label: "执行中", className: "is-running" },
  done: { label: "完成", className: "is-done" },
  error: { label: "失败", className: "is-error" },
  skipped: { label: "跳过", className: "is-skipped" },
};

const INPUT_LABEL: Record<WorkflowStep["input"], string> = {
  command: "原始命令",
  previous: "上一步输出",
  all: "目前全部输出",
};

function stepId(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
}

function draftFromWorkflow(def: WorkflowDef, models: ModelOption[]): WorkflowDraft {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    steps: def.steps.map((step) => ({
      id: step.id || stepId(),
      name: step.name,
      role: step.role ?? "",
      modelKey: step.model ? specKey(step.model) : "",
      instruction: step.instruction,
      input: step.input,
      parallelGroup: step.parallelGroup != null ? String(step.parallelGroup) : "",
    })),
  };
}

function emptyDraft(): WorkflowDraft {
  return {
    name: "新的工作流",
    description: "",
    steps: [
      {
        id: stepId(),
        name: "第一步",
        role: "需求分析",
        modelKey: "",
        instruction: "拆解用户命令，给出可执行清单与验收标准。",
        input: "command",
        parallelGroup: "",
      },
    ],
  };
}

function draftToRequest(draft: WorkflowDraft, models: ModelOption[]): WorkflowCreateRequest {
  const lookup = new Map<string, ParticipantSpec>();
  for (const model of models) {
    const spec = specFromModel(model);
    lookup.set(specKey(spec), spec);
  }
  return {
    name: draft.name.trim() || "未命名工作流",
    description: draft.description.trim(),
    steps: draft.steps.map((step) => ({
      id: step.id,
      name: step.name.trim() || "未命名步骤",
      role: step.role.trim() || undefined,
      model: step.modelKey ? lookup.get(step.modelKey) : undefined,
      instruction: step.instruction,
      input: step.input,
      parallelGroup:
        step.parallelGroup.trim() === "" || Number.isNaN(Number(step.parallelGroup))
          ? undefined
          : Number(step.parallelGroup),
    })),
  };
}

function runStepsToDraft(run: WorkflowRun): WorkflowDraft {
  return {
    name: `${run.workflowName} · 复刻`,
    description: `基于运行 ${run.id.slice(0, 8)} 保存（原命令：${truncate(run.command, 80)}）`,
    steps: run.steps.map((step, index) => ({
      id: stepId(),
      name: step.name || `第 ${index + 1} 步`,
      role: step.name,
      modelKey: "",
      instruction:
        step.text.trim().length > 0
          ? `沿用第 ${index + 1} 步的目标，重新产出：${truncate(step.text, 160)}`
          : `沿用第 ${index + 1} 步的目标，重新产出。`,
      input: index === 0 ? "command" : "previous",
      parallelGroup: "",
    })),
  };
}

export function WorkflowPage({ models, customModels, pushToast }: WorkflowPageProps) {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [streamStatus, setStreamStatus] = useState<"idle" | "open" | "closed" | "error">("idle");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const streamRef = useRef<WorkflowStreamHandle | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  const stopWatching = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, runList] = await Promise.all([
        api.listWorkflows(),
        api.listWorkflowRuns(20).catch(() => [] as WorkflowRun[]),
      ]);
      setWorkflows(list);
      setRuns(runList);
      setMissing(false);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      if (isApiError(err) && err.status === 404) setMissing(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => stopWatching();
  }, [load, stopWatching]);

  const selected = useMemo(() => workflows.find((item) => item.id === selectedId) ?? null, [selectedId, workflows]);
  const missingModels = useMemo(
    () => (selected ? selected.steps.filter((step) => !step.model) : []),
    [selected],
  );

  const refreshRun = useCallback(
    async (id: string) => {
      try {
        const run = await api.getWorkflowRun(id);
        if (activeRunIdRef.current !== id) return;
        setActiveRun(run);
        setRunStatus(run.status);
        if (run.status === "running") {
          if (pollRef.current) clearTimeout(pollRef.current);
          pollRef.current = setTimeout(() => void refreshRun(id), 1200);
        } else {
          stopWatching();
          void api.listWorkflowRuns(20).then(setRuns).catch(() => undefined);
        }
      } catch (err) {
        if (activeRunIdRef.current !== id) return;
        setRunStatus("error");
        pushToast("error", "读取工作流运行失败", errorMessage(err));
      }
    },
    [pushToast, stopWatching],
  );

  const watchRun = useCallback(
    (id: string) => {
      stopWatching();
      activeRunIdRef.current = id;
      setRunId(id);
      setRunStatus("running");
      setStreamStatus("idle");
      // SSE 先上，任何帧都触发一次回读；服务端未实现该接口时自动退回轮询。
      streamRef.current = api.openWorkflowRunStream(id, {
        onFrame: () => void refreshRun(id),
        onStatus: (status) => setStreamStatus(status),
        onError: () => setStreamStatus("error"),
      });
      void refreshRun(id);
    },
    [refreshRun, stopWatching],
  );

  const startRun = async (): Promise<void> => {
    if (!selected) return;
    if (!command.trim()) {
      pushToast("warn", "先填写本次运行的命令");
      return;
    }
    setBusy("run");
    try {
      const result = await api.runWorkflow(selected.id, { command: command.trim() });
      const id = "id" in result && result.id ? result.id : null;
      if (!id) throw new Error("服务端没有返回运行 id");
      if ("status" in result) {
        setActiveRun(result as WorkflowRun);
        setRunStatus((result as WorkflowRun).status);
      }
      watchRun(id);
      pushToast("success", "工作流已启动", selected.name);
    } catch (err) {
      pushToast("error", "运行工作流失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const saveWorkflow = async (): Promise<void> => {
    if (!draft) return;
    if (!draft.name.trim()) {
      pushToast("warn", "工作流名称不能为空");
      return;
    }
    if (draft.steps.length === 0) {
      pushToast("warn", "至少需要一个步骤");
      return;
    }
    setBusy("save");
    try {
      const payload = draftToRequest(draft, models);
      const saved = draft.id
        ? await api.updateWorkflow(draft.id, payload)
        : await api.createWorkflow(payload);
      pushToast("success", draft.id ? "工作流已更新" : "工作流已创建", saved.name);
      setDraft(null);
      const list = await api.listWorkflows();
      setWorkflows(list);
      setSelectedId(saved.id);
    } catch (err) {
      pushToast("error", "保存工作流失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeWorkflow = async (def: WorkflowDef): Promise<void> => {
    if (confirmDelete !== def.id) {
      setConfirmDelete(def.id);
      setTimeout(() => setConfirmDelete((prev) => (prev === def.id ? null : prev)), 4000);
      return;
    }
    setConfirmDelete(null);
    setBusy(`delete:${def.id}`);
    try {
      await api.deleteWorkflow(def.id);
      pushToast("success", "工作流已删除", def.name);
      if (selectedId === def.id) setSelectedId(null);
      await load();
    } catch (err) {
      pushToast("error", "删除工作流失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openRun = async (run: WorkflowRun): Promise<void> => {
    stopWatching();
    activeRunIdRef.current = run.id;
    setRunId(run.id);
    setActiveRun(run);
    setRunStatus(run.status);
    if (run.status === "running") watchRun(run.id);
  };

  const patchStep = (id: string, patch: Partial<StepDraft>): void => {
    setDraft((prev) =>
      prev ? { ...prev, steps: prev.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) } : prev,
    );
  };

  const addStep = (): void => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            steps: [
              ...prev.steps,
              {
                id: stepId(),
                name: `第 ${prev.steps.length + 1} 步`,
                role: "",
                modelKey: "",
                instruction: "",
                input: prev.steps.length === 0 ? "command" : "previous",
                parallelGroup: "",
              },
            ],
          }
        : prev,
    );
  };

  const modelGroups = useMemo(() => {
    const groups = new Map<string, { label: string; models: ModelOption[] }>();
    for (const model of models) {
      const key = model.provider === "relay" ? `relay:${model.relayId ?? ""}` : model.provider;
      const label =
        model.provider === "relay"
          ? model.providerLabel ?? "中转站"
          : model.provider === "workbuddy"
            ? "WorkBuddy"
            : model.provider;
      const group = groups.get(key) ?? { label, models: [] };
      group.models.push(model);
      groups.set(key, group);
    }
    for (const model of customModels) {
      const key = model.provider;
      const group = groups.get(key) ?? { label: model.provider, models: [] };
      group.models.push({ ...model, available: true, connections: 1 });
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [customModels, models]);

  if (loading) {
    return (
      <div className="resource-loading">
        <IconLoader size={16} className="spin" /> 正在读取工作流…
      </div>
    );
  }

  if (missing) {
    return (
      <div className="resource-fallback">
        <span className="resource-fallback__icon">
          <IconWorkflow size={20} />
        </span>
        <h3>工作流接口未就绪</h3>
        <p>
          服务端实现 <code>/api/workflows</code> 与 <code>/api/workflow-runs</code> 后可在此编辑与运行。下面是内置模板预览：
        </p>
        <div className="builtin-list">
          {BUILTIN_WORKFLOWS.map((template) => (
            <div className="builtin-card" key={template.name}>
              <b>{template.name}</b>
              <p>{template.description}</p>
              <ol>
                {template.steps.map((step) => (
                  <li key={step.id}>
                    {step.name} · {INPUT_LABEL[step.input]}
                    {step.parallelGroup != null ? ` · 并行组 ${step.parallelGroup}` : ""}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <button type="button" className="btn" onClick={() => void load()}>
          <IconRefresh size={12} /> 重新读取
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="resource-fallback resource-fallback--error">
        <span className="resource-fallback__icon">
          <IconAlert size={20} />
        </span>
        <h3>工作流读取失败</h3>
        <p>{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          <IconRefresh size={12} /> 重试
        </button>
      </div>
    );
  }

  return (
    <div className="workflow-page">
      <div className="resource-toolbar">
        <div className="resource-toolbar__stats">
          <span>
            <b className="mono">{workflows.length}</b> 个工作流
          </span>
          <span>·</span>
          <span>
            <b className="mono">{workflows.filter((item) => item.builtin).length}</b> 个内置模板
          </span>
          <span>·</span>
          <span>最近运行 {runs.length} 条</span>
        </div>
        <div className="resource-toolbar__actions">
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            <IconRefresh size={12} /> 刷新
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => {
              setDraft(emptyDraft());
              setSelectedId(null);
            }}
          >
            <IconPlus size={12} /> 新建工作流
          </button>
        </div>
      </div>

      <div className="workflow-layout">
        <aside className="workflow-list" aria-label="工作流列表">
          {workflows.length === 0 ? (
            <div className="resource-empty">还没有工作流。点「新建工作流」开始。</div>
          ) : (
            workflows.map((def) => (
              <div
                key={def.id}
                className={`workflow-item${selectedId === def.id ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  className="workflow-item__main"
                  onClick={() => {
                    setSelectedId(def.id);
                    setDraft(null);
                  }}
                >
                  <span className="workflow-item__name">
                    {def.name}
                    {def.builtin ? <span className="tag">内置</span> : null}
                  </span>
                  <span className="workflow-item__desc">{def.description || "（无描述）"}</span>
                  <span className="workflow-item__meta mono">
                    {def.steps.length} 步 · {formatRelative(def.updatedAt)}
                  </span>
                </button>
                <div className="workflow-item__actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setDraft(draftFromWorkflow(def, models))}
                    title="编辑"
                    aria-label={`编辑 ${def.name}`}
                  >
                    <IconEdit size={12} />
                  </button>
                  <button
                    type="button"
                    className={`icon-btn${confirmDelete === def.id ? " is-danger" : ""}`}
                    onClick={() => void removeWorkflow(def)}
                    title={confirmDelete === def.id ? "再点一次确认" : "删除"}
                    aria-label={`删除 ${def.name}`}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              </div>
            ))
          )}

          <div className="run-history">
            <div className="run-history__head">
              <IconHistory size={12} /> 运行记录
            </div>
            {runs.length === 0 ? (
              <div className="run-history__empty">还没有工作流运行。</div>
            ) : (
              runs.map((run) => (
                <button
                  type="button"
                  key={run.id}
                  className={`run-history__item${runId === run.id ? " is-active" : ""}`}
                  onClick={() => void openRun(run)}
                >
                  <span className={`dot ${run.status === "done" ? "dot-ok" : run.status === "running" ? "dot-warn" : "dot-err"}`} />
                  <span className="run-history__name">{run.workflowName}</span>
                  <span className="run-history__meta mono">{formatRelative(run.createdAt)}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="workflow-main" aria-label="工作流编辑与运行">
          {draft ? (
            <div className="workflow-editor">
              <div className="editor-head">
                <h3>{draft.id ? "编辑工作流" : "新建工作流"}</h3>
                <div className="editor-head__actions">
                  <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void saveWorkflow()}
                    disabled={busy === "save"}
                  >
                    {busy === "save" ? <IconLoader size={12} className="spin" /> : <IconSave size={12} />} 保存工作流
                  </button>
                </div>
              </div>
              <div className="editor-meta">
                <label className="field-row">
                  <span>名称</span>
                  <input
                    className="input"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="工作流名称"
                  />
                </label>
                <label className="field-row">
                  <span>描述</span>
                  <input
                    className="input"
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="一句话说明这个工作流做什么"
                  />
                </label>
              </div>

              <div className="step-editor-list">
                {draft.steps.map((step, index) => (
                  <article className="step-editor" key={step.id}>
                    <header className="step-editor__head">
                      <span className="step-editor__index mono">{String(index + 1).padStart(2, "0")}</span>
                      <input
                        className="input step-editor__name"
                        value={step.name}
                        onChange={(event) => patchStep(step.id, { name: event.target.value })}
                        placeholder="步骤名称"
                        aria-label={`第 ${index + 1} 步名称`}
                      />
                      <label className="step-editor__input">
                        输入
                        <select
                          className="select"
                          value={step.input}
                          onChange={(event) =>
                            patchStep(step.id, { input: event.target.value as StepDraft["input"] })
                          }
                        >
                          <option value="command">原始命令</option>
                          <option value="previous">上一步输出</option>
                          <option value="all">全部输出</option>
                        </select>
                      </label>
                      <label className="step-editor__group">
                        并行组
                        <input
                          className="input mono"
                          type="number"
                          min={1}
                          value={step.parallelGroup}
                          onChange={(event) => patchStep(step.id, { parallelGroup: event.target.value })}
                          placeholder="空=串行"
                        />
                      </label>
                      <div className="step-editor__actions">
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              steps: draft.steps.filter((item) => item.id !== step.id),
                            })
                          }
                          aria-label="删除步骤"
                        >
                          <IconTrash size={12} />
                        </button>
                      </div>
                    </header>
                    <div className="step-editor__body">
                      <label className="field-row">
                        <span>角色提示词</span>
                        <input
                          className="input"
                          value={step.role}
                          onChange={(event) => patchStep(step.id, { role: event.target.value })}
                          placeholder="例如 需求分析 / 代码审查（作为 system 注入）"
                        />
                      </label>
                      <label className="field-row">
                        <span>指定模型</span>
                        <select
                          className="select"
                          value={step.modelKey}
                          onChange={(event) => patchStep(step.id, { modelKey: event.target.value })}
                        >
                          <option value="">不指定（沿用默认路由）</option>
                          {modelGroups.map((group) => (
                            <optgroup label={group.label} key={group.label}>
                              {group.models.map((model) => (
                                <option value={specKey(specFromModel(model))} key={`${model.provider}:${model.id}`}>
                                  {model.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                      <label className="field-row">
                        <span>指令</span>
                        <textarea
                          className="textarea"
                          rows={3}
                          value={step.instruction}
                          onChange={(event) => patchStep(step.id, { instruction: event.target.value })}
                          placeholder="这一步要做的事，会作为 user prompt 发送"
                        />
                      </label>
                    </div>
                  </article>
                ))}
                <button type="button" className="btn step-editor__add" onClick={addStep}>
                  <IconPlus size={12} /> 添加步骤
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="workflow-runner">
              <div className="runner-head">
                <div>
                  <h3>{selected.name}</h3>
                  <p>{selected.description || "（无描述）"}</p>
                </div>
                <span className="tag">{selected.steps.length} 步</span>
              </div>
              <ol className="runner-steps">
                {selected.steps.map((step, index) => (
                  <li key={step.id}>
                    <span className="mono">{String(index + 1).padStart(2, "0")}</span>
                    <b>{step.name}</b>
                    <span className="faint">{INPUT_LABEL[step.input]}</span>
                    {step.parallelGroup != null ? <span className="tag">并行组 {step.parallelGroup}</span> : null}
                    <span className="runner-steps__instruction">{truncate(step.instruction, 90)}</span>
                  </li>
                ))}
              </ol>
              <label className="field-row">
                <span>本次命令</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="输入这次工作流要处理的原始命令…"
                />
              </label>
              {missingModels.length > 0 ? (
                <div className="runner-warning" role="status">
                  <IconAlert size={12} /> 有 {missingModels.length} 个步骤还没选择模型，运行前请点「编辑」为每一步指定模型。
                </div>
              ) : null}
              <div className="runner-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void startRun()}
                  disabled={busy === "run" || runStatus === "running" || missingModels.length > 0}
                >
                  {busy === "run" ? <IconLoader size={12} className="spin" /> : <IconPlay size={12} />} 运行工作流
                </button>
                <button type="button" className="btn" onClick={() => setDraft(draftFromWorkflow(selected, models))}>
                  <IconEdit size={12} /> 编辑
                </button>
                {runStatus === "running" ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      stopWatching();
                      setRunStatus("done");
                      pushToast("info", "已停止查看运行（服务端可能仍在执行）");
                    }}
                  >
                    <IconStop size={12} /> 停止查看
                  </button>
                ) : null}
              </div>

              {activeRun ? (
                <div className="run-result">
                  <div className="run-result__head">
                    <h4>运行结果</h4>
                    <span className={`tag ${runStatus === "done" ? "tag-ok" : runStatus === "error" ? "tag-err" : "tag-warn"}`}>
                      {runStatus === "running" ? "运行中" : runStatus === "done" ? "完成" : "失败"}
                    </span>
                    <span className="run-result__stream">
                      {runStatus === "running"
                        ? streamStatus === "open"
                          ? "SSE 已连接"
                          : "SSE 连接中"
                        : streamStatus === "error"
                          ? "轮询兜底"
                          : "SSE 已结束"}
                    </span>
                    {activeRun.usage?.totalTokens ? (
                      <span className="mono">{formatTokens(activeRun.usage.totalTokens)} tok</span>
                    ) : null}
                    {activeRun.finishedAt ? (
                      <span className="mono">{formatDuration(activeRun.finishedAt - activeRun.createdAt)}</span>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm run-result__save"
                      onClick={() => setDraft(runStepsToDraft(activeRun))}
                      title="把这次运行的步骤保存成可复用工作流"
                    >
                      <IconSave size={11} /> 把本次运行保存为工作流
                    </button>
                  </div>
                  {activeRun.error ? <div className="run-result__error">{activeRun.error}</div> : null}
                  <ol className="run-steps">
                    {activeRun.steps.map((step, index) => {
                      const meta = STEP_STATUS[step.status] ?? STEP_STATUS.pending;
                      return (
                        <li className={`run-step ${meta.className}`} key={`${step.stepId}:${index}`}>
                          <div className="run-step__head">
                            <span className="run-step__index mono">{String(index + 1).padStart(2, "0")}</span>
                            <b>{step.name}</b>
                            <span className={`run-step__status ${meta.className}`}>
                              {step.status === "running" ? <IconLoader size={10} className="spin" /> : null}
                              {meta.label}
                            </span>
                            {step.latencyMs != null ? <span className="mono">{formatDuration(step.latencyMs)}</span> : null}
                            {step.usage?.totalTokens ? (
                              <span className="mono">{formatTokens(step.usage.totalTokens)} tok</span>
                            ) : null}
                          </div>
                          {step.error ? <p className="run-step__error">{step.error}</p> : null}
                          {step.text ? <pre className="run-step__text">{step.text}</pre> : null}
                        </li>
                      );
                    })}
                  </ol>
                  {activeRun.finalText ? (
                    <div className="run-result__final">
                      <h5>
                        <IconCheck size={12} /> 最终答案
                      </h5>
                      <RichText text={activeRun.finalText} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="resource-empty resource-empty--center">
              <IconWorkflow size={22} />
              <p>从左侧选择一个工作流，或新建一个。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
