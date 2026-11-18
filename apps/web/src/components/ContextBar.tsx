import { useEffect, useMemo, useState } from "react";
import type { ContextRunSummary, ContextSectionName } from "@super-work/core";
import { api } from "../lib/api";
import { formatNumber } from "../lib/format";
import type { ContextCall, RunView } from "../lib/types";
import { IconAlert, IconBrain, IconChevronRight } from "./Icons";

export interface ContextBarProps {
  run: RunView | null;
  onOpenContext: () => void;
}

const SECTION_ORDER: ContextSectionName[] = ["system", "command", "memory", "reference", "history", "output"];

function callKey(item: { participantId: string; stage: string; at: number }): string {
  return `${item.participantId}:${item.stage}:${item.at}`;
}

function percentOf(tokens: number, window?: number): number | undefined {
  if (!window || window <= 0) return undefined;
  return Math.min(1, tokens / window);
}

/**
 * 对话底部常驻的上下文占用条。
 * 分母取参与模型里最紧的上下文窗口，分子取本轮单次调用的提示词 token（估算）。
 */
export function ContextBar({ run, onOpenContext }: ContextBarProps) {
  const [summary, setSummary] = useState<ContextRunSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSummary(null);
    setFailed(false);
    if (!run?.id || run.contexts.length > 0) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await api.getRunContext(run.id);
          if (!cancelled) setSummary(data);
        } catch {
          if (!cancelled) setFailed(true);
        }
      })();
    }, run.state === "running" ? 1500 : 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [run?.id, run?.contexts.length, run?.state]);

  const calls = useMemo<ContextCall[]>(() => {
    if (!run) return [];
    if (run.contexts.length > 0) return run.contexts;
    return (summary?.calls ?? []) as ContextCall[];
  }, [run, summary]);

  if (!run) return null;

  const tightest = calls.reduce<ContextCall | null>((best, call) => {
    if (typeof call.utilization !== "number") return best;
    if (!best || (best.utilization ?? 0) < call.utilization) return call;
    return best;
  }, null);
  const peak = calls.reduce((max, call) => Math.max(max, call.promptTokens ?? 0), 0);
  const window = tightest?.contextWindow;
  // 分母只认模型目录里的真实窗口；没有就不显示百分比，避免用峰值反推一个假窗口。
  const percent = tightest?.utilization ?? (window ? percentOf(peak, window) : undefined);
  const pctText = percent == null ? "—" : `${(percent * 100).toFixed(percent < 0.1 ? 1 : 0)}%`;
  const level = percent == null ? "idle" : percent >= 0.85 ? "danger" : percent >= 0.7 ? "warn" : "ok";
  const sections = SECTION_ORDER.map((name) => ({
    name,
    tokens: tightest?.sections?.find((section) => section.name === name)?.tokens ?? 0,
  })).filter((section) => section.tokens > 0);
  const sectionTotal = sections.reduce((sum, section) => sum + section.tokens, 0);
  const round = run.round ?? 1;
  const history = run.history;

  return (
    <div className={`context-bar is-${level}`} role="status" aria-live="polite">
      <div className="context-bar__lead">
        <span className="context-bar__icon" aria-hidden="true">
          <IconBrain size={13} />
        </span>
        <span className="context-bar__label">上下文</span>
        <span className={`context-bar__pct mono is-${level}`}>{pctText}</span>
      </div>

      <div
        className="context-bar__track"
        title={
          percent == null
            ? "还没有上下文数据"
            : `本轮提示词约 ${formatNumber(tightest?.promptTokens ?? peak)} tokens / 窗口 ${formatNumber(window)}（最紧：${tightest?.model ?? "未知模型"}）`
        }
        aria-label="上下文窗口占用"
      >
        <div className="context-bar__fill" style={{ width: percent == null ? "0%" : `${Math.max(2, percent * 100)}%` }}>
          {sections.map((section) => (
            <span
              key={section.name}
              className={`context-seg context-seg--${section.name}`}
              style={{ width: `${sectionTotal > 0 ? (section.tokens / sectionTotal) * 100 : 0}%` }}
              title={`${section.name} · ${formatNumber(section.tokens)} tok`}
            />
          ))}
        </div>
      </div>

      <div className="context-bar__meta">
        <span className="context-bar__tokens mono">
          {tightest?.promptTokens != null || peak > 0
            ? `${formatNumber(tightest?.promptTokens ?? peak)}${window ? ` / ${formatNumber(window)}` : ""} tok`
            : "暂无调用"}
        </span>
        {tightest?.model ? (
          <span className="context-bar__tight" title="上下文窗口最紧的模型">
            最紧 {tightest.model}
          </span>
        ) : failed ? (
          <span className="context-bar__tight is-warn">
            <IconAlert size={10} /> 上下文接口不可用
          </span>
        ) : null}
        <span className="context-bar__round">
          第 {round} 轮
          {history && history.rounds > 0
            ? ` · 带 ${history.rounds} 轮历史${history.truncated ? "（已截断）" : ""}`
            : ""}
        </span>
        <button
          type="button"
          className="context-bar__open"
          onClick={onOpenContext}
          title="打开右栏「上下文洞察」查看每次调用的构成"
        >
          洞察 <IconChevronRight size={10} />
        </button>
      </div>
    </div>
  );
}
