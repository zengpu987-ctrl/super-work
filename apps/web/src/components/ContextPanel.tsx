import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContextRunSummary, ContextSectionName } from "@super-work/core";
import { api, errorMessage, isApiError } from "../lib/api";
import type { ContextCall, RunState } from "../lib/types";
import { STAGE_LABELS } from "../lib/types";
import { formatNumber } from "../lib/format";
import { IconAlert, IconBrain, IconDatabase, IconLoader, IconRefresh } from "./Icons";

export interface ContextPanelProps {
  runId: string | null;
  runState: RunState | null;
  liveContexts: ContextCall[];
}

const SECTION_META: Record<ContextSectionName, { label: string; className: string }> = {
  system: { label: "System", className: "system" },
  command: { label: "命令", className: "command" },
  memory: { label: "记忆", className: "memory" },
  reference: { label: "参考", className: "reference" },
  history: { label: "历史", className: "history" },
  output: { label: "输出", className: "output" },
};

const SECTION_ORDER: ContextSectionName[] = ["system", "command", "memory", "reference", "history", "output"];

function callKey(item: { participantId: string; stage: string; at: number }): string {
  return `${item.participantId}:${item.stage}:${item.at}`;
}

export function ContextPanel({ runId, runState, liveContexts }: ContextPanelProps) {
  const [summary, setSummary] = useState<ContextRunSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);

  const load = useCallback(
    async (id: string, silent = false) => {
      if (!silent) setLoading(true);
      setMissing(null);
      try {
        const data = await api.getRunContext(id);
        setSummary(data);
      } catch (err) {
        if (isApiError(err) && err.status === 404) {
          setMissing("服务端尚未提供上下文接口（/api/runs/:id/context），或该运行没有上下文快照。");
        } else {
          setMissing(`上下文读取失败：${errorMessage(err)}`);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setSummary(null);
    setMissing(null);
    if (!runId) return;
    void load(runId);
  }, [load, runId]);

  // 运行结束后再拉一次：服务端通常在落库后才有完整快照。
  useEffect(() => {
    if (!runId || runState !== "done") return;
    const timer = setTimeout(() => void load(runId, true), 900);
    return () => clearTimeout(timer);
  }, [load, runId, runState]);

  const calls = useMemo<ContextCall[]>(() => {
    const byKey = new Map<string, ContextCall>();
    for (const item of summary?.calls ?? []) {
      byKey.set(callKey(item), { ...item, at: item.at });
    }
    for (const item of liveContexts) byKey.set(callKey(item), item);
    return [...byKey.values()].sort((a, b) => a.at - b.at);
  }, [liveContexts, summary]);

  const peak = Math.max(
    summary?.peakPromptTokens ?? 0,
    ...calls.map((item) => item.promptTokens ?? 0),
    0,
  );

  return (
    <div className="context-panel">
      <div className="orchestration__head">
        <div>
          <h2 className="rail-panel-title">上下文洞察</h2>
          <p className="rail-panel-sub">每次模型调用的 token 构成与窗口占用</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => runId && void load(runId)}
          disabled={!runId || loading}
          title="刷新上下文"
          aria-label="刷新上下文"
        >
          {loading ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
        </button>
      </div>

      {!runId ? (
        <div className="context-empty">
          <span className="context-empty__icon">
            <IconBrain size={18} />
          </span>
          <h3>还没有运行</h3>
          <p>运行一次后，这里会按调用列出 system / 命令 / 记忆 / 参考 的 token 堆叠与上下文窗口占用。</p>
        </div>
      ) : calls.length === 0 ? (
        <div className="context-empty">
          <span className="context-empty__icon">
            <IconDatabase size={18} />
          </span>
          <h3>{loading ? "正在读取上下文…" : "暂无上下文数据"}</h3>
          <p>
            {missing ??
              (runState === "running"
                ? "模型调用开始后会实时出现；运行结束后也会从 /api/runs/:id/context 回读。"
                : "本次运行没有回传上下文快照（服务端接口可能尚未就绪）。")}
          </p>
          {missing ? (
            <span className="context-empty__degrade">
              <IconAlert size={11} /> 优雅降级：不影响答案与产物查看
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <div className="context-summary">
            <div>
              <span>调用次数</span>
              <b className="mono">{calls.length}</b>
            </div>
            <div>
              <span>峰值 prompt</span>
              <b className="mono">{formatNumber(peak)}</b>
            </div>
            <div>
              <span>峰值占用</span>
              <b className="mono">
                {summary?.peakUtilization != null
                  ? `${Math.round(summary.peakUtilization * 100)}%`
                  : calls.reduce<number>((max, item) => Math.max(max, item.utilization ?? 0), 0) > 0
                    ? `${Math.round(
                        calls.reduce<number>((max, item) => Math.max(max, item.utilization ?? 0), 0) * 100,
                      )}%`
                    : "—"}
              </b>
            </div>
          </div>

          {summary?.tightest ? (
            <div className="context-tightest" role="status">
              最紧的窗口：<b>{summary.tightest.model}</b>
              <span className="mono">
                {formatNumber(summary.tightest.contextWindow)} · {Math.round(summary.tightest.utilization * 100)}%
              </span>
            </div>
          ) : null}

          <div className="context-legend">
            {SECTION_ORDER.map((name) => (
              <span className={`context-legend__item context-legend__item--${SECTION_META[name].className}`} key={name}>
                <i aria-hidden="true" />
                {SECTION_META[name].label}
              </span>
            ))}
          </div>

          <ol className="context-list" aria-label="上下文调用列表">
            {calls.map((call, index) => {
              const sections = SECTION_ORDER.map((name) => {
                const found = call.sections?.find((section) => section.name === name);
                return { name, tokens: found?.tokens ?? 0 };
              }).filter((section) => section.tokens > 0);
              const total = Math.max(
                call.promptTokens ?? 0,
                sections.reduce((sum, section) => sum + section.tokens, 0),
                1,
              );
              const utilization =
                call.utilization ??
                (call.contextWindow ? (call.promptTokens ?? 0) / call.contextWindow : undefined);
              return (
                <li className="context-call" key={`${callKey(call)}:${index}`}>
                  <div className="context-call__head">
                    <span className="context-call__stage">{STAGE_LABELS[call.stage] ?? call.stage}</span>
                    <span className="context-call__model" title={call.model}>
                      {call.model}
                    </span>
                    <span className="context-call__tokens mono">{formatNumber(call.promptTokens)} tok</span>
                    {call.injectedMemoryIds?.length ? (
                      <span className="tag tag-accent">记忆 {call.injectedMemoryIds.length}</span>
                    ) : null}
                  </div>

                  <div
                    className="context-stack"
                    role="img"
                    aria-label={`上下文构成：${sections
                      .map((section) => `${SECTION_META[section.name].label} ${section.tokens}`)
                      .join("，")}`}
                  >
                    {sections.map((section) => (
                      <span
                        key={section.name}
                        className={`context-seg context-seg--${SECTION_META[section.name].className}`}
                        style={{ width: `${(section.tokens / total) * 100}%` }}
                        title={`${SECTION_META[section.name].label} · ${formatNumber(section.tokens)} tok`}
                      />
                    ))}
                  </div>

                  <div className="context-call__foot">
                    <span className="context-call__window">
                      {call.contextWindow ? (
                        <>
                          窗口 <span className="mono">{formatNumber(call.contextWindow)}</span> · 占用{" "}
                          <b className={`mono${utilization != null && utilization > 0.8 ? " is-tight" : ""}`}>
                            {utilization != null ? `${Math.round(utilization * 100)}%` : "—"}
                          </b>
                        </>
                      ) : (
                        "未回传上下文窗口"
                      )}
                    </span>
                    {call.recalledMemoryIds?.length ? (
                      <span className="context-call__recall">
                        召回 <b className="mono">{call.recalledMemoryIds.length}</b>
                        {" · "}注入 <b className="mono">{call.injectedMemoryIds?.length ?? 0}</b>
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}
