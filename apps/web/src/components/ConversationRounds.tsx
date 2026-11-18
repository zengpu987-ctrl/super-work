import { useState } from "react";
import type { RunView } from "../lib/types";
import { MODE_META } from "../lib/types";
import { formatClock, formatDuration, formatNumber } from "../lib/format";
import { ParticipantCard } from "./ParticipantCard";
import { IconChevronDown, IconChevronRight } from "./Icons";
import { RichText } from "./RichText";

export interface ConversationRoundsProps {
  rounds: RunView[];
  now: number;
}

function percentOfRound(run: RunView): { percent: number; tokens: number; window: number } | null {
  let best: { percent: number; tokens: number; window: number } | null = null;
  for (const call of run.contexts) {
    if (typeof call.utilization !== "number" || !call.contextWindow) continue;
    if (!best || call.utilization > best.percent) {
      best = { percent: call.utilization, tokens: call.promptTokens, window: call.contextWindow };
    }
  }
  return best;
}

function RoundBlock({ run, index, now }: { run: RunView; index: number; now: number }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(run.mode === "chat");
  const round = run.round ?? index + 1;
  const elapsed = run.finishedAt ? run.finishedAt - run.createdAt : undefined;
  const done = run.participants.filter((p) => p.state === "done").length;
  const ctx = percentOfRound(run);
  const answer = run.finalText.trim();
  const statusText = run.state === "error" ? "失败" : run.state === "running" ? "运行中" : "完成";

  return (
    <article className={`round-block is-${run.state}`}>
      <header className="round-block__head">
        <span className="round-block__index mono">第 {round} 轮</span>
        <span className="round-block__mode">{MODE_META[run.mode]?.name ?? run.mode}</span>
        <span className="round-block__meta">
          {done}/{run.participants.length} 个模型 · {formatClock(run.createdAt)}
          {elapsed != null ? ` · ${formatDuration(elapsed)}` : ""}
        </span>
        <span className={`round-block__status is-${run.state}`}>
          <span className="dot" aria-hidden="true" />
          {statusText}
        </span>
        <button
          type="button"
          className="round-block__toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
          过程
        </button>
      </header>

      <p className="round-block__command" title={run.command}>
        {run.command}
      </p>

      <div className={`round-block__answer${full ? " is-full" : ""}`}>
        {answer ? <RichText text={answer} /> : <span className="round-block__empty">（这一轮没有最终答案）</span>}
      </div>

      <footer className="round-block__foot">
        {ctx ? (
          <span className={`round-block__ctx is-${ctx.percent >= 0.85 ? "danger" : ctx.percent >= 0.7 ? "warn" : "ok"}`}>
            上下文 {(ctx.percent * 100).toFixed(1)}%（{formatNumber(ctx.tokens)} / {formatNumber(ctx.window)}）
          </span>
        ) : null}
        {run.history && run.history.rounds > 0 ? (
          <span className="round-block__note">
            注入 {run.history.rounds} 轮历史{run.history.truncated ? "（已截断）" : ""}
          </span>
        ) : null}
        {run.usage?.totalTokens ? (
          <span className="round-block__note mono">{formatNumber(run.usage.totalTokens)} tok</span>
        ) : null}
        {answer.length > 180 ? (
          <button type="button" className="round-block__more" onClick={() => setFull((value) => !value)}>
            {full ? "收起" : "展开全文"}
          </button>
        ) : null}
      </footer>

      {open ? (
        <div className="round-block__grid">
          {run.participants.map((participant) => (
            <ParticipantCard
              key={participant.id}
              participant={participant}
              now={now}
              isJudge={Boolean(run.judge && participant.model === run.judge.model)}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** 当前轮之前的历史轮次：按对话顺序堆叠，默认折叠过程。 */
export function ConversationRounds({ rounds, now }: ConversationRoundsProps) {
  if (rounds.length === 0) return null;
  return (
    <section className="conversation-rounds" aria-label="前几轮对话">
      <div className="conversation-rounds__head">
        <span className="conversation-rounds__title">对话历史</span>
        <span className="conversation-rounds__count mono">{rounds.length} 轮</span>
        <span className="conversation-rounds__hint">本轮会自动带上前面的命令与最终答案</span>
      </div>
      {rounds.map((round, index) => (
        <RoundBlock key={round.id} run={round} index={index} now={now} />
      ))}
      <div className="conversation-rounds__divider">
        <span>当前轮</span>
      </div>
    </section>
  );
}
