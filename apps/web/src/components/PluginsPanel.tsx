/** 设置 → 插件：DSH 插件表格（名称/版本/类型/状态/启用/测试/日志）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginAction, PluginInfo, PluginKind } from "@super-work/core";
import { api, errorMessage, isApiError } from "../lib/api";
import { formatRelative } from "../lib/format";
import {
  PLUGIN_KIND_LABEL,
  pluginSourceLabel,
  pluginStatusLabel,
  pluginStatusTone,
} from "../lib/v3";
import {
  IconAlert,
  IconCheck,
  IconLoader,
  IconPlug,
  IconRefresh,
  IconSearch,
  IconTerminal,
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";
import { RichText } from "./RichText";

export interface PluginsPanelProps {
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

const KIND_FILTERS: Array<{ value: PluginKind | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "native", label: "已迁移" },
  { value: "bridge", label: "桥接可运行" },
  { value: "ui-only", label: "原生适配" },
  { value: "unsupported", label: "宿主适配" },
];

export function PluginsPanel({ pushToast }: PluginsPanelProps) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PluginKind | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [testOutputs, setTestOutputs] = useState<Record<string, string>>({});
  const [runner, setRunner] = useState<{ plugin: PluginInfo; action: PluginAction } | null>(null);
  const [actionInputs, setActionInputs] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState(false);
  const [actionResult, setActionResult] = useState<import("@super-work/core").PluginActionResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listPlugins();
      setPlugins(list);
    } catch (err) {
      const status = isApiError(err) ? err.status : 0;
      setPlugins(null);
      setError({ status, message: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const list = plugins ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((plugin) => {
      if (kind !== "all" && plugin.kind !== kind) return false;
      if (!q) return true;
      return (
        plugin.name.toLowerCase().includes(q) ||
        plugin.id.toLowerCase().includes(q) ||
        (plugin.description ?? "").toLowerCase().includes(q) ||
        (plugin.capability ?? "").toLowerCase().includes(q)
      );
    });
  }, [kind, plugins, query]);

  const summary = useMemo(() => {
    const list = plugins ?? [];
    return {
      total: list.length,
      native: list.filter((item) => item.kind === "native").length,
      bridge: list.filter((item) => item.kind === "bridge").length,
      adapted: list.filter((item) => item.status === "adapted").length,
      linked: list.filter((item) => item.status === "linked").length,
      failed: list.filter((item) => item.lastTest?.ok === false).length,
      enabled: list.filter((item) => item.enabled).length,
    };
  }, [plugins]);

  const toggle = async (plugin: PluginInfo): Promise<void> => {
    setTogglingId(plugin.id);
    try {
      const updated = await api.updatePlugin(plugin.id, { enabled: !plugin.enabled });
      setPlugins((prev) =>
        (prev ?? []).map((item) =>
          item.id === plugin.id ? { ...item, ...(updated ?? {}), enabled: updated?.enabled ?? !plugin.enabled } : item,
        ),
      );
      pushToast("success", `${plugin.enabled ? "已停用" : "已启用"} ${plugin.name}`);
    } catch (err) {
      pushToast("error", "插件启用状态更新失败", errorMessage(err));
    } finally {
      setTogglingId(null);
    }
  };

  const test = async (plugin: PluginInfo): Promise<void> => {
    setTestingId(plugin.id);
    setExpandedId(plugin.id);
    try {
      const result = await api.testPlugin(plugin.id);
      const lastTest = {
        ok: result.ok,
        message: result.message,
        latencyMs: result.latencyMs,
        at: Date.now(),
      };
      if (result.output) {
        setTestOutputs((prev) => ({ ...prev, [plugin.id]: result.output ?? "" }));
      }
      setPlugins((prev) =>
        (prev ?? []).map((item) =>
          item.id === plugin.id
            ? { ...item, ...(result.plugin ?? {}), lastTest: result.plugin?.lastTest ?? lastTest }
            : item,
        ),
      );
      pushToast(
        result.ok ? "success" : "warn",
        `${plugin.name} 测试${result.ok ? "通过" : "未通过"} · ${result.latencyMs}ms`,
        result.message,
      );
    } catch (err) {
      pushToast("error", `${plugin.name} 测试失败`, errorMessage(err));
    } finally {
      setTestingId(null);
    }
  };

  const openRunner = (plugin: PluginInfo): void => {
    const action = plugin.actions?.[0];
    if (!action) {
      pushToast("warn", `${plugin.name} 没有可运行动作`);
      return;
    }
    const defaults: Record<string, string> = {};
    for (const field of action.fields ?? []) defaults[field.name] = field.defaultValue ?? "";
    setActionInputs(defaults);
    setActionResult(null);
    setRunner({ plugin, action });
  };

  const selectAction = (action: PluginAction): void => {
    if (!runner) return;
    const defaults: Record<string, string> = {};
    for (const field of action.fields ?? []) defaults[field.name] = field.defaultValue ?? "";
    setActionInputs(defaults);
    setActionResult(null);
    setRunner({ ...runner, action });
  };

  const applyNative = (result: import("@super-work/core").PluginActionResponse): void => {
    const data = (result.data ?? {}) as { theme?: string; font?: string; on?: boolean };
    if (result.native === "appearance") {
      if (data.theme) {
        document.documentElement.dataset.swTheme = data.theme;
        window.localStorage.setItem("superwork.theme", data.theme);
      }
      if (data.font) {
        document.documentElement.dataset.swFont = data.font;
        window.localStorage.setItem("superwork.font", data.font);
      }
    }
    if (result.native === "pet") {
      const existing = document.querySelector(".jarvis-orb");
      if (data.on === false) {
        existing?.remove();
      } else if (!existing) {
        const orb = document.createElement("div");
        orb.className = "jarvis-orb";
        orb.setAttribute("aria-hidden", "true");
        document.body.appendChild(orb);
      }
      window.localStorage.setItem("superwork.pet", data.on === false ? "off" : "on");
    }
    if (result.native === "launch") {
      const shell = document.querySelector(".app-shell");
      if (shell) {
        shell.classList.remove("is-launching");
        void (shell as HTMLElement).offsetWidth;
        shell.classList.add("is-launching");
        window.setTimeout(() => shell.classList.remove("is-launching"), 1600);
      }
    }
    if (result.native === "settings") {
      pushToast("info", "工具设置已并入设置页", result.message);
    }
  };

  const runAction = async (): Promise<void> => {
    if (!runner) return;
    setActionBusy(true);
    try {
      const envelope = await api.runPluginAction(runner.plugin.id, runner.action.id, actionInputs);
      setActionResult(envelope.result);
      if (envelope.result.native) applyNative(envelope.result);
      if (envelope.result.data && (envelope.result.data as { url?: string }).url) {
        window.open((envelope.result.data as { url: string }).url, "_blank", "noopener,noreferrer");
      }
      pushToast(envelope.result.ok ? "success" : "warn", `${runner.action.label}${envelope.result.ok ? "完成" : "失败"}`, envelope.result.message);
      setPlugins((prev) =>
        (prev ?? []).map((item) =>
          item.id === runner.plugin.id
            ? { ...item, lastTest: { ok: envelope.result.ok, message: envelope.result.message, latencyMs: envelope.result.latencyMs, at: Date.now() } }
            : item,
        ),
      );
    } catch (err) {
      pushToast("error", `${runner.action.label}失败`, errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  };

  if (error) {
    return (
      <div className="settings-panel">
        <div className="settings-panel__head">
          <span className="settings-panel__icon">
            <IconPlug size={16} />
          </span>
          <div>
            <h3>插件中心</h3>
            <p>读取 DSH 本机插件、标注迁移状态，并提供桥接测试入口。</p>
          </div>
        </div>
        <div className="settings-empty">
          {error.status === 404 ? (
            <>
              <IconAlert size={20} />
              <strong>插件接口未就绪（404）</strong>
              <span>
                服务端实现 <span className="mono">GET /api/plugins</span> 后，这里会自动列出 35 项 DSH 插件；
                当前页面保留占位，不影响运行与预算等其他设置。
              </span>
            </>
          ) : (
            <>
              <IconAlert size={20} />
              <strong>插件列表读取失败</strong>
              <span>{error.message}</span>
            </>
          )}
          <button type="button" className="btn" onClick={() => void load()}>
            <IconRefresh size={12} /> 重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-panel plugins-panel">
      <div className="settings-panel__head">
        <span className="settings-panel__icon">
          <IconPlug size={16} />
        </span>
        <div>
          <h3>插件中心</h3>
          <p>
            36 项插件均已适配：原生能力直接迁移，桥接插件可运行真实动作，DSH 专属 UI 以原生主题/背景/悬浮球等价实现。测试只执行版本命令，运行执行具体能力。
          </p>
        </div>
      </div>

      <div className="plugins-summary">
        <span>
          <b className="mono">{loading ? "…" : summary.total}</b> 项
        </span>
        <span className="is-ok">已原生 {summary.native}</span>
        <span className="is-accent">桥接 {summary.bridge}</span>
        <span>已适配 {summary.adapted}</span>
        <span className="is-muted">可跳转 {summary.linked}</span>
        <span className={summary.failed > 0 ? "is-err" : ""}>测试失败 {summary.failed}</span>
        <span className="is-muted">启用 {summary.enabled}</span>
      </div>

      <div className="plugins-filters">
        <label className="search-field">
          <IconSearch size={12} />
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称 / 包名 / 能力"
            aria-label="搜索插件"
          />
          {query ? (
            <button type="button" className="icon-btn" onClick={() => setQuery("")} aria-label="清空搜索">
              <IconX size={11} />
            </button>
          ) : null}
        </label>
        <select
          className="select plugins-filters__kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as PluginKind | "all")}
          aria-label="按类型筛选"
        >
          {KIND_FILTERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          <IconRefresh size={12} className={loading ? "spin" : ""} /> 刷新
        </button>
      </div>

      <div className="plugins-table-wrap">
        <table className="data-table plugins-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>版本</th>
              <th>类型</th>
              <th>状态</th>
              <th aria-label="启用" />
              <th>运行</th>
              <th>测试</th>
              <th>日志</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="data-table__empty">
                  <span className="mini-spin">
                    <IconLoader size={13} />
                  </span>{" "}
                  正在扫描 DSH 插件…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="data-table__empty">
                  没有匹配的插件。
                </td>
              </tr>
            ) : (
              filtered.map((plugin) => {
                const tone = pluginStatusTone(plugin);
                const expanded = expandedId === plugin.id;
                return (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    tone={tone}
                    expanded={expanded}
                    testing={testingId === plugin.id}
                    toggling={togglingId === plugin.id}
                    onToggle={() => void toggle(plugin)}
                    onTest={() => void test(plugin)}
                    onRun={() => openRunner(plugin)}
                    onToggleLog={() => setExpandedId(expanded ? null : plugin.id)}
                    testOutput={testOutputs[plugin.id]}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {plugins && plugins.some((plugin) => plugin.kind !== "native") ? (
        <p className="settings-panel__note">
          <IconAlert size={11} /> 所有插件均已适配：能桥接的直接运行，原生能力标注迁移，DSH 专属 UI 提供等价主题/跳转。
        </p>
      ) : null}

      {runner ? (
        <div className="plugin-runner" role="dialog" aria-modal="true" aria-label={`${runner.plugin.name} 运行`}>
          <div className="plugin-runner__backdrop" onClick={() => setRunner(null)} />
          <div className="plugin-runner__panel">
            <header className="plugin-runner__head">
              <div>
                <h3>{runner.plugin.name}</h3>
                <p>{runner.plugin.capability ?? runner.plugin.description}</p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setRunner(null)} aria-label="关闭运行面板">
                <IconX size={13} />
              </button>
            </header>
            {(runner.plugin.actions?.length ?? 0) > 1 ? (
              <div className="plugin-runner__actions">
                {(runner.plugin.actions ?? []).map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={`btn btn-sm${action.id === runner.action.id ? " btn-primary" : " btn-ghost"}`}
                    onClick={() => selectAction(action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
            {runner.action.description ? <p className="plugin-runner__desc">{runner.action.description}</p> : null}
            <div className="plugin-runner__form">
              {(runner.action.fields ?? []).map((field) => (
                <label className="plugin-runner__field" key={field.name}>
                  <span>{field.label}{field.required ? " *" : ""}</span>
                  {field.type === "textarea" ? (
                    <textarea
                      className="input"
                      rows={5}
                      value={actionInputs[field.name] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(event) => setActionInputs((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    />
                  ) : field.type === "select" ? (
                    <select
                      className="select"
                      value={actionInputs[field.name] ?? field.defaultValue ?? ""}
                      onChange={(event) => setActionInputs((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    >
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={field.type === "number" ? "number" : "text"}
                      value={actionInputs[field.name] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(event) => setActionInputs((prev) => ({ ...prev, [field.name]: event.target.value }))}
                    />
                  )}
                </label>
              ))}
              <div className="plugin-runner__foot">
                <button type="button" className="btn btn-primary" onClick={() => void runAction()} disabled={actionBusy}>
                  {actionBusy ? <IconLoader size={12} className="spin" /> : <IconTerminal size={12} />}
                  {actionBusy ? "运行中…" : "运行"}
                </button>
                <span className="mono">{runner.action.kind} · {runner.action.handler}</span>
              </div>
              {actionResult ? (
                <div className={`plugin-runner__result${actionResult.ok ? "" : " is-error"}`}>
                  <strong>{actionResult.message}</strong>
                  {actionResult.text ? <RichText text={actionResult.text} className="plugin-runner__text" /> : null}
                  {actionResult.imageUrl ? (
                    <img className="plugin-runner__image" src={actionResult.imageUrl} alt="插件产物" />
                  ) : null}
                  {actionResult.fileUrl && /\.(mp4|webm|mov)$/i.test(actionResult.fileUrl) ? (
                    <video className="plugin-runner__video" controls src={actionResult.fileUrl} />
                  ) : null}
                  {actionResult.fileUrl ? (
                    <a className="btn btn-sm" href={actionResult.fileUrl} target="_blank" rel="noopener noreferrer">
                      {/\.(mp4|webm|mov)$/i.test(actionResult.fileUrl) ? "打开视频" : "打开 / 下载产物"}
                    </a>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PluginRowProps {
  plugin: PluginInfo;
  tone: "ok" | "warn" | "err" | "muted";
  expanded: boolean;
  testing: boolean;
  toggling: boolean;
  onToggle: () => void;
  onTest: () => void;
  onRun: () => void;
  onToggleLog: () => void;
  testOutput?: string;
}

function PluginRow({
  plugin,
  tone,
  expanded,
  testing,
  toggling,
  onToggle,
  onTest,
  onRun,
  onToggleLog,
  testOutput,
}: PluginRowProps) {
  return (
    <>
      <tr className={expanded ? "is-expanded" : ""}>
        <td>
          <div className="plugin-name">
            <span className={`plugin-dot is-${tone}`} aria-hidden="true" />
            <span className="plugin-name__text" title={plugin.description}>
              {plugin.name}
            </span>
            <span className="plugin-name__source">{pluginSourceLabel(plugin)}</span>
          </div>
        </td>
        <td className="mono">{plugin.version || "—"}</td>
        <td>
          <span className={`tag plugin-kind is-${plugin.kind}`}>{PLUGIN_KIND_LABEL[plugin.kind]}</span>
        </td>
        <td>
          <span className={`plugin-status is-${tone}`}>
            {pluginStatusLabel(plugin)}
            {plugin.lastTest ? (
              <em>
                {plugin.lastTest.ok ? <IconCheck size={9} /> : <IconAlert size={9} />}
                {plugin.lastTest.latencyMs != null ? `${plugin.lastTest.latencyMs}ms` : ""}
              </em>
            ) : null}
          </span>
        </td>
        <td>
          <PaddleSwitch
            size="sm"
            checked={plugin.enabled}
            onChange={() => onToggle()}
            disabled={toggling}
            ariaLabel={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`}
            title={plugin.enabled ? "停用" : "启用"}
          />
        </td>
        <td>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRun} disabled={!plugin.actions?.length}>
            <IconTerminal size={11} /> 运行
          </button>
        </td>
        <td>
          {plugin.bridge ? (
            <button type="button" className="btn btn-sm" onClick={onTest} disabled={testing}>
              {testing ? <IconLoader size={11} className="spin" /> : <IconCheck size={11} />}
              {testing ? "测试中" : "测试"}
            </button>
          ) : (
            <span className="muted" title="该插件通过「运行」执行适配动作">—</span>
          )}
        </td>
        <td>
          <button
            type="button"
            className={`btn btn-sm btn-ghost${expanded ? " is-active" : ""}`}
            onClick={onToggleLog}
            aria-expanded={expanded}
          >
            {expanded ? "收起" : "查看"}
          </button>
        </td>
      </tr>
      {expanded ? (
        <tr className="plugin-log-row">
          <td colSpan={8}>
            <div className="plugin-log">
              <div className="plugin-log__meta">
                <span>
                  包名 <b className="mono">{plugin.dshPackage ?? plugin.id}</b>
                </span>
                {plugin.capability ? (
                  <span>
                    能力 <b>{plugin.capability}</b>
                  </span>
                ) : null}
                {plugin.bridge ? (
                  <span>
                    桥接 <b className="mono">{plugin.bridge.command}</b>{" "}
                    <span className="mono">{plugin.bridge.testArgs.join(" ")}</span>
                  </span>
                ) : (
                  <span className="is-muted">无桥接命令</span>
                )}
                {plugin.lastTest ? (
                  <span>
                    最近测试 {formatRelative(plugin.lastTest.at)} ·{" "}
                    <b className={plugin.lastTest.ok ? "is-ok" : "is-err"}>{plugin.lastTest.message}</b>
                  </span>
                ) : (
                  <span className="is-muted">尚未测试</span>
                )}
              </div>
              <p className="plugin-log__desc">{plugin.description || "无描述"}</p>
              {testOutput ? (
                <pre className="plugin-log__output">{testOutput}</pre>
              ) : (
                <p className="plugin-log__empty">测试后这里显示进程输出（最多 4KB，超时 10s）。</p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
