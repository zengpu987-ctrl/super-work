import { useEffect, useRef, useState } from "react";
import type { EffortLevel } from "@super-work/core";
import { PROVIDER_BY_ID } from "@super-work/core";
import { effortName } from "../lib/effort";
import { formatClock, formatDuration, formatTokens } from "../lib/format";
import { MODE_META } from "../lib/types";
import type { RunView } from "../lib/types";
import { artifactUrl } from "../lib/api";
import { BrandIcon } from "./BrandIcon";
import { FileArtifacts } from "./FileArtifacts";
import { ConversationRounds } from "./ConversationRounds";
import { EffortSelector } from "./EffortSelector";
import { RichText } from "./RichText";
import { IconChat, IconCheck, IconCopy, IconStopCircle, IconUsers } from "./Icons";

export interface ChatViewProps {
  run: RunView;
  now: number;
  pastRounds?: RunView[];
  onStop: () => void;
  onRerun: () => void;
  onHandoffToTeam: () => void;
  onBranch?: () => void;
  /** 调档：运行中走热调（下一次调用生效），结束后写回 Chat 模型供下一轮使用 */
  onEffortChange: (effort: EffortLevel) => void;
  /** 当前 Chat 模型的下一条消息档位（历史运行时用来显示「下一轮」的选择） */
  chatEffort?: EffortLevel;
}

/** Chat 模式的一轮：用户气泡 + 模型气泡，不做参与者卡片网格。 */
export function ChatView({ run, now, pastRounds, onStop, onRerun, onHandoffToTeam, onBranch, onEffortChange, chatEffort }: ChatViewProps) {
  const participant = run.participants[0];
  const meta = participant ? PROVIDER_BY_ID[participant.provider] : undefined;
  const running = run.state === "running";
  const streaming = run.finalStreaming || participant?.state === "streaming";
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const pinnedToLatest = useRef(true);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const viewKey = `${run.id}:${run.origin}`;
  useEffect(() => {
    const node = canvasRef.current;
    if (!node) return;
    pinnedToLatest.current = run.origin !== "history";
    node.scrollTo({ top: pinnedToLatest.current ? node.scrollHeight : 0, behavior: "instant" });
  }, [viewKey, run.origin]);

  useEffect(() => {
    const node = canvasRef.current;
    if (node && pinnedToLatest.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
  }, [run.finalText, running]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(run.finalText);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略复制失败 */
    }
  };

  const elapsed = run.finishedAt ? run.finishedAt - run.createdAt : running ? now - run.createdAt : undefined;
  // 运行中显示本次调用的实时档位；结束后显示下一轮将使用的档位（Chat 模型选择器同源）。
  const effort = running
    ? participant?.effort ?? chatEffort ?? "medium"
    : chatEffort ?? participant?.effort ?? "medium";

  return (
    <main
      className="canvas chat-canvas"
      aria-label="Chat 对话"
      ref={canvasRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        pinnedToLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
      }}
    >
      {pastRounds && pastRounds.length > 0 ? <ConversationRounds rounds={pastRounds} now={now} /> : null}

      <section className="chat-round">
        <div className="chat-bubble is-user">
          <span className="chat-bubble__label">你</span>
          <p>{run.command}</p>
          {run.attachments?.length ? (
            <ul className="chat-attachments" aria-label="本次运行附件">
              {run.attachments.map((attachment) => <li key={attachment.id}>{attachment.name}</li>)}
            </ul>
          ) : null}
        </div>
        <header className="chat-round__head">
          {participant ? (
            <BrandIcon
              provider={participant.provider}
              size={22}
              title={`${meta?.name ?? participant.provider} 官方商标`}
            />
          ) : (
            <span className="chat-round__icon" aria-hidden="true">
              <IconChat size={14} />
            </span>
          )}
          <div className="chat-round__names">
            <b>{participant?.label ?? "Chat 模型"}</b>
            <em>
              {meta?.name ?? participant?.provider ?? "未选择模型"} · 第 {run.round ?? 1} 轮 ·{" "}
              {formatClock(run.createdAt)}
              {elapsed != null ? ` · ${formatDuration(elapsed)}` : ""}
            </em>
          </div>

          <span className="chat-round__effort">
            <span className="chat-round__effort-label">档位</span>
            <EffortSelector
              size="sm"
              value={effort}
              onChange={(next) => onEffortChange(next)}
              ariaLabel="Chat 档位"
            />
          </span>

          <span className={`run-status run-status--${run.state}`} role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" />
            {running ? (streaming ? "回复中" : "思考中") : run.state === "error" ? "失败" : "已完成"}
          </span>


        </header>

        <div className="chat-transcript">
          <div className={`chat-bubble is-model${run.state === "error" ? " is-error" : ""}`}>
            {run.error ? (
              <p className="chat-bubble__error">{run.error}</p>
            ) : (
              <div className="chat-bubble__answer">
                <RichText text={run.finalText} streaming={streaming} />
                {!run.finalText && streaming ? <span className="chat-bubble__thinking">正在回复…</span> : null}
              </div>
            )}
          </div>

          {run.artifacts.length > 0 ? (
            <div className="chat-artifacts">
              {run.artifacts.filter((item) => item.kind === "image").length > 0 ? (
                <div className="chat-images">
                  {run.artifacts
                    .filter((item) => item.kind === "image")
                    .map((item) => {
                      const url = artifactUrl(run.id, item);
                      return url ? (
                        <a key={item.id} href={url} target="_blank" rel="noreferrer" title={item.title}>
                          <img src={url} alt={item.title} loading="lazy" />
                        </a>
                      ) : null;
                    })}
                </div>
              ) : null}
              {run.artifacts.filter((item) => item.kind === "file").length > 0 ? (
                <FileArtifacts files={run.artifacts.filter((item) => item.kind === "file")} runId={run.id} compact />
              ) : null}
            </div>
          ) : null}
        </div>


        <div className="chat-round__actions">
          {run.finalText.trim() ? (
            <button type="button" className="icon-btn" onClick={() => void copy()} aria-label="复制回复" title="复制回复">
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </button>
          ) : null}
          {running ? (
            <button type="button" className="btn btn-sm btn-danger" onClick={onStop}>
              <IconStopCircle size={11} /> 停止
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={onHandoffToTeam}
                title="把这个对话交给模型团队（并行）接着做；会自动带上 Chat 历史"
              >
                <IconUsers size={11} /> 交给团队
              </button>
              <button type="button" className="btn btn-sm" onClick={onRerun} title="用相同输入重新生成，仍在当前对话的下一轮">
                重新生成
              </button>
              {onBranch ? (
                <button type="button" className="btn btn-sm" onClick={onBranch} title="把截至这一轮的对话复制成一个新分支">
                  分支
                </button>
              ) : null}
            </>
          )}
        </div>

        <footer className="chat-round__foot">
          <span>{MODE_META[run.mode]?.name ?? run.mode}</span>
          <span className="sep" aria-hidden="true">·</span>
          <span>{effortName(effort)}</span>
          {run.usage?.totalTokens ? (
            <>
              <span className="sep" aria-hidden="true">·</span>
              <span className="mono">{formatTokens(run.usage.totalTokens)} tok</span>
            </>
          ) : null}
          {participant?.usage?.inputTokens != null ? (
            <>
              <span className="sep" aria-hidden="true">·</span>
              <span className="mono">
                输入 {formatTokens(participant.usage.inputTokens)} / 输出 {formatTokens(participant.usage.outputTokens ?? 0)}
              </span>
            </>
          ) : null}
          <span className="chat-round__hint">
            切到「并行 / 配合」或点「交给团队」，下一条命令由模型团队接着做
          </span>
        </footer>
      </section>
    </main>
  );
}
