/** 设置 → 插件：DSH 插件表格（名称/版本/类型/状态/启用/测试/日志）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginInfo, PluginKind } from "@super-work/core";
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
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface PluginsPanelProps {
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

const KIND_FILTERS: Array<{ value: PluginKind | "all"; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "native", label: "已迁移" },
  { value: "bridge", label: "桥接可运行" },
  { value: "ui-only", label: "仅 DSH UI" },
  { value: "unsupported", label: "暂不支持" },
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
      uiOnly: list.filter((item) => item.kind === "ui-only").length,
      unsupported: list.filter((item) => item.kind === "unsupported").length,
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
            能桥接的提供可运行入口，已原生的标注迁移，DSH 专属 UI 插件标注仅 DSH。测试只执行版本/帮助命令，不跑真实任务。
          </p>
        </div>
      </div>

      <div className="plugins-summary">
        <span>
          <b className="mono">{loading ? "…" : summary.total}</b> 项
        </span>
        <span className="is-ok">已迁移 {summary.native}</span>
        <span className="is-accent">桥接 {summary.bridge}</span>
        <span>仅 DSH {summary.uiOnly}</span>
        <span className="is-muted">不适用 {summary.unsupported}</span>
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
              <th>测试</th>
              <th>日志</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="data-table__empty">
                  <span className="mini-spin">
                    <IconLoader size={13} />
                  </span>{" "}
                  正在扫描 DSH 插件…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="data-table__empty">
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
                    onToggleLog={() => setExpandedId(expanded ? null : plugin.id)}
                    testOutput={testOutputs[plugin.id]}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {plugins && plugins.some((plugin) => plugin.kind === "ui-only") ? (
        <p className="settings-panel__note">
          <IconAlert size={11} /> 「仅 DSH UI」插件无法直接迁移到 Super Work；建议在 DSH 中保留，或使用 Super Work
          原生的工作台 / 主题替代。
        </p>
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
          <button type="button" className="btn btn-sm" onClick={onTest} disabled={testing}>
            {testing ? <IconLoader size={11} className="spin" /> : <IconCheck size={11} />}
            {testing ? "测试中" : "测试"}
          </button>
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
          <td colSpan={7}>
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
