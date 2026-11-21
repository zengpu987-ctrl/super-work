import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomRoleDef, EffortLevel, ParticipantSpec, Usage } from "@super-work/core";
import type { BudgetUsageView } from "../lib/api";
import type { RunView } from "../lib/types";
import { MODE_META, stageSlotsForMode, stageSlotIndex } from "../lib/types";
import { resolveRoleLabel } from "../lib/v3";
import { formatClock, formatDuration, formatTokens, truncate } from "../lib/format";
import { EmptyState } from "./EmptyState";
import { FinalAnswer } from "./FinalAnswer";
import { ChatView } from "./ChatView";
import { ConversationRounds } from "./ConversationRounds";
import { ParticipantCard } from "./ParticipantCard";
import { StageRibbon } from "./StageRibbon";
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconFileCode,
  IconFilePdf,
  IconFileText,
  IconImage,
  IconLoader,
  IconPaperclip,
  IconPlay,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconUsers,
  IconWallet,
  IconX,
} from "./Icons";

export interface RunCanvasProps {
  run: RunView | null;
  now: number;
  offline: boolean;
  hasConnection: boolean;
  demoBusy: boolean;
  judgeKey: string | null;
  onStop: () => void;
  onRerun: () => void;
  onReSynthesize: () => void;
  onFollowUp: () => void;
  onOpenSettings: () => void;
  onDemo: () => void;
  onPickExample: (command: string) => void;
  /** 运行中热调强度（下一次调用生效） */
  onEffortChange: (participantId: string, effort: EffortLevel) => Promise<void>;
  /** 运行中单独停止某个模型（其余模型继续） */
  onStopParticipant?: (participantId: string) => Promise<void> | void;
  /* v0.0.3 */
  customRoles: CustomRoleDef[];
  budgetUsage: BudgetUsageView | null;
  onOpenBudget: () => void;
  /** 多轮对话：本轮之前已完成的轮次 */
  pastRounds?: RunView[];
  /** Chat 与团队互通：把工作/对话交给 Chat 或团队继续 */
  onHandoffToChat?: (spec?: ParticipantSpec) => void;
  onHandoffToTeam?: () => void;
  /** Chat 档位写回（下一轮使用） */
  onChatEffortChange?: (effort: EffortLevel) => void;
  /** Chat 模型当前档位（历史运行时显示下一轮的选择） */
  chatEffort?: EffortLevel;
}

const STATUS_TEXT: Record<RunView["state"], string> = {
  loading: "载入中",
  running: "运行中",
  done: "已完成",
  error: "运行失败",
};

function totalUsage(run: RunView): Usage | undefined {
  if (run.usage) return run.usage;
  const parts = run.participants.map((participant) => participant.usage).filter(Boolean) as Usage[];
  if (parts.length === 0) return undefined;
  return parts.reduce<Usage>((acc, usage) => {
    acc.inputTokens = (acc.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    acc.outputTokens = (acc.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    acc.totalTokens = (acc.totalTokens ?? 0) + (usage.totalTokens ?? 0);
    return acc;
  }, {});
}

export function RunCanvas({
  run,
  now,
  offline,
  hasConnection,
  demoBusy,
  judgeKey,
  onStop,
  onRerun,
  onBranch,
  onReSynthesize,
  onFollowUp,
  onOpenSettings,
  onDemo,
  onPickExample,
  onEffortChange,
  onStopParticipant,
  customRoles,
  budgetUsage,
  onOpenBudget,
  pastRounds,
  onHandoffToChat,
  onHandoffToTeam,
  onChatEffortChange,
  chatEffort,
}: RunCanvasProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLElement | null>(null);
  const finalRef = useRef<HTMLDivElement | null>(null);
  const finalScrolledRef = useRef<string | null>(null);

  const roleBySpec = useMemo(() => {
    const map = new Map<string, string>();
    for (const assignment of run?.coordination ?? []) {
      const meta = resolveRoleLabel(assignment.role, customRoles);
      for (const spec of assignment.participants ?? []) {
        map.set(`${spec.provider}:${spec.model}`, meta.name);
      }
    }
    return map;
  }, [customRoles, run?.coordination]);

  const roleTags = useMemo(
    () =>
      (run?.coordination ?? []).map((assignment) => ({
        ...resolveRoleLabel(assignment.role, customRoles),
        count: assignment.participants?.length ?? 0,
      })),
    [customRoles, run?.coordination],
  );

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // 运行开始 / 载入历史时回到画布顶部。
  useEffect(() => {
    canvasRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [run?.id]);

  // 最终答案一开始流式输出，就把它滚进视野（每轮只自动滚一次）。
  // 打开历史工作时保持顶部：先看到前几轮，而不是直接跳到最后一轮的答案。
  const finalReady = !!run && (run.finalStreaming || run.finalText.trim().length > 0);
  useEffect(() => {
    if (!run || !finalReady) return;
    if (run.origin === "history") return;
    if (finalScrolledRef.current === run.id) return;
    finalScrolledRef.current = run.id;
    const node = finalRef.current;
    if (!node) return;
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    });
  }, [finalReady, run]);

  if (!run) {
    return (
      <main className="canvas" ref={canvasRef} aria-label="运行画布">
        <EmptyState
          onPickExample={onPickExample}
          onDemo={onDemo}
          onOpenSettings={onOpenSettings}
          demoBusy={demoBusy}
          hasConnection={hasConnection}
          offline={offline}
        />
      </main>
    );
  }

  if (run.state === "loading") {
    return (
      <main className="canvas" ref={canvasRef} aria-label="运行画布" aria-busy="true">
        <div className="canvas-loading">
          <div className="skeleton skeleton--head" />
          <div className="skeleton skeleton--ribbon" />
          <div className="skeleton-grid">
            {[0, 1, 2, 3].map((index) => (
              <div className="skeleton skeleton--card" key={index} />
            ))}
          </div>
          <div className="canvas-loading__note">
            <span className="mini-spin" aria-hidden="true">
              <IconLoader size={12} />
            </span>
            正在载入运行 #{run.id.slice(0, 8)} …
          </div>
        </div>
      </main>
    );
  }

  const running = run.state === "running";

  if (run.mode === "chat") {
    return (
      <ChatView
        run={run}
        now={now}
        pastRounds={pastRounds}
        onStop={onStop}
        onRerun={onRerun}
        onBranch={onBranch}
        onHandoffToTeam={() => onHandoffToTeam?.()}
        chatEffort={chatEffort}
        onEffortChange={(effort) => {
          const participant = run.participants[0];
          if (running && participant) void onEffortChange(participant.id, effort);
          onChatEffortChange?.(effort);
        }}
      />
    );
  }

  const usage = totalUsage(run);
  const budgetNotice = run.notices.find((notice) => /预算|budget|额度|超限|token 上限/i.test(notice.message));
  const budgetBlocked = run.guard?.budgets?.blocked === true || budgetNotice?.level === "error";
  const budgetMessage =
    budgetNotice?.message ?? run.guard?.budgets?.message ?? "本次运行已触及预算上限，剩余调用被拦截。";
  const elapsed = run.finishedAt ? run.finishedAt - run.createdAt : running ? now - run.createdAt : undefined;
  const completed = run.participants.filter(
    (participant) => participant.state === "done" || participant.state === "error" || participant.state === "stopped",
  ).length;
  const stoppedParticipants = run.participants.filter((participant) => participant.state === "stopped");
  const lastStage = run.stages[run.stages.length - 1];
  const slots = stageSlotsForMode(run.mode);
  const lastSlot = lastStage ? stageSlotIndex(lastStage.stage, slots) : -1;
  const finalVisible =
    run.finalText.trim().length > 0 ||
    run.finalStreaming ||
    run.artifacts.length > 0 ||
    run.state === "done" ||
    (running && lastSlot >= slots.length - 1);
  const streamNote =
    run.streamStatus === "reconnecting"
      ? "事件流中断，正在重连…"
      : run.streamStatus === "connecting"
        ? "正在连接事件流…"
        : null;

  const copyCommand = async (): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(run.command);
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1600);
      }
    } catch {
      /* 忽略复制失败 */
    }
  };

  return (
    <main className="canvas" ref={canvasRef} aria-label="运行画布" aria-busy={running}>
      {pastRounds && pastRounds.length > 0 ? <ConversationRounds rounds={pastRounds} now={now} /> : null}
      {budgetBlocked ? (
        <div className="budget-alert" role="alert">
          <span className="budget-alert__icon" aria-hidden="true">
            <IconWallet size={14} />
          </span>
          <div className="budget-alert__body">
            <strong>预算拦截：运行已停止继续消耗</strong>
            <span>{budgetMessage}</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={onOpenBudget}>
            调整预算
          </button>
        </div>
      ) : null}

      <div className="chat-bubble is-user team-command">
        <span className="chat-bubble__label">你</span>
        <h1 className="run-head__command">{run.command}</h1>
      </div>

      <section className={`run-head${run.state === "done" ? " is-done" : ""}`}>
        <div className="run-head__top">
          <span className="run-head__mode">{MODE_META[run.mode]?.name ?? run.mode}</span>
          {(run.round ?? 1) > 1 ? (
            <span className="tag tag-accent" title={`这是本工作的第 ${run.round} 轮`}>
              第 {run.round} 轮
            </span>
          ) : null}
          {run.history && run.history.rounds > 0 ? (
            <span
              className="tag"
              title={
                run.history.truncated
                  ? "前几轮对话超出上下文预算，已从最旧一轮开始截断"
                  : `已把前 ${run.history.rounds} 轮的命令与最终答案带入本次调用`
              }
            >
              带 {run.history.rounds} 轮历史{run.history.truncated ? " · 截断" : ""}
            </span>
          ) : null}
          {run.guard?.cheapMode ? (
            <span className="tag tag-warn" title="省钱模式：低档位、关闭互评、压缩上下文">
              省钱模式
            </span>
          ) : null}
          <span className={`run-status run-status--${run.state}`} role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" />
            {STATUS_TEXT[run.state]}
          </span>
          {streamNote ? (
            <span className="stream-strip">
              <span className="stream-strip__spin" aria-hidden="true">
                <IconLoader size={10} />
              </span>
              {streamNote}
            </span>
          ) : null}
          <span className="run-head__id mono">#{run.id.slice(0, 8)}</span>
          <span className="run-head__meta">
            {formatClock(run.createdAt)}
            {elapsed != null ? ` · ${formatDuration(elapsed)}` : ""}
            {run.origin === "history" ? " · 历史记录" : ""}
          </span>
          <div className="run-head__actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => void copyCommand()}
              aria-label="复制命令"
              title="复制命令"
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </button>
            {running ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={onStop} aria-label="停止运行">
                <IconStop size={11} /> 停止
              </button>
            ) : (
              <>
                {onHandoffToChat ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const spec: ParticipantSpec | undefined = run.judge?.provider && run.judge.model
                        ? { provider: run.judge.provider, model: run.judge.model }
                        : run.participants[0]
                          ? {
                              provider: run.participants[0].provider,
                              model: run.participants[0].model,
                              relayId: run.participants[0].relayId,
                              effort: run.participants[0].effort,
                            }
                          : undefined;
                      onHandoffToChat(spec);
                    }}
                    title="切到 Chat，用单个模型接着聊；会带上当前工作的上下文"
                  >
                    <IconUsers size={11} /> 用 Chat 继续
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onRerun}
                  aria-label="用相同命令与参与者重新运行"
                >
                  <IconRefresh size={12} /> 重新运行
                </button>
                {onBranch ? (
                  <button type="button" className="btn btn-sm" onClick={onBranch} title="把截至这一轮的对话复制成新分支">
                    分支
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        {run.attachments && run.attachments.length > 0 ? (
          <div className="run-attachments" aria-label="本次运行附件">
            <span className="run-attachments__label">
              <IconPaperclip size={11} /> 附件 {run.attachments.length}
            </span>
            {run.attachments.map((attachment) => (
              <span
                className="run-attachment"
                key={attachment.id}
                title={`${attachment.name} · ${attachment.kind} · ${attachment.size} bytes`}
              >
                {attachment.kind === "image" ? (
                  <IconImage size={11} />
                ) : attachment.kind === "pdf" ? (
                  <IconFilePdf size={11} />
                ) : attachment.kind === "code" ? (
                  <IconFileCode size={11} />
                ) : (
                  <IconFileText size={11} />
                )}
                <span className="run-attachment__name">{attachment.name}</span>
                {attachment.kind === "image" ? (
                  <em>图片</em>
                ) : attachment.chars != null ? (
                  <em className="mono">{formatTokens(attachment.chars)} 字</em>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}

        {roleTags.length > 0 ? (
          <div className="run-roles" aria-label="本次运行角色">
            <span className="run-roles__label">角色</span>
            {roleTags.map((role) => (
              <span
                className={`run-role-tag${role.builtin ? "" : " is-custom"}`}
                key={`${role.name}-${role.count}`}
                title={role.description}
              >
                {role.name}
                <b className="mono">{role.count}</b>
              </span>
            ))}
          </div>
        ) : null}

        <div className="run-stats">
          <div className="run-stat">
            <span className="run-stat__label">参与模型</span>
            <span className="run-stat__value">
              {run.participants.length} <span style={{ opacity: 0.5 }}>·</span> {completed} 完成
            </span>
          </div>
          <div className="run-stat">
            <span className="run-stat__label">已用时</span>
            <span className="run-stat__value">
              {elapsed != null ? formatDuration(elapsed) : running ? "计时中" : "—"}
            </span>
          </div>
          <div className="run-stat">
            <span className="run-stat__label">累计 token</span>
            <span className="run-stat__value is-accent">
              {usage?.totalTokens ? formatTokens(usage.totalTokens) : "—"}
            </span>
          </div>
          <div className="run-stat">
            <span className="run-stat__label">当前阶段</span>
            <span className="run-stat__value">{lastStage?.label ?? (running ? "准备中" : "—")}</span>
          </div>
          <div className="run-stat">
            <span className="run-stat__label">记忆</span>
            <span className="run-stat__value" title={run.memoryInjected == null ? "服务端未回传注入记忆明细，按 0 展示" : undefined}>
              {run.memoryInjected ?? 0} 条注入
            </span>
          </div>
          <div className="run-stat">
            <span className="run-stat__label">预算</span>
            <span className={`run-stat__value${budgetBlocked ? " is-danger" : ""}`}>
              {budgetUsage?.percent != null
                ? `今日 ${Math.round(budgetUsage.percent)}%`
                : run.guard?.budgets?.perRunTokens
                  ? `单次上限 ${formatTokens(run.guard.budgets.perRunTokens)}`
                  : "未设上限"}
              {run.guard?.cheapMode ? " · 省钱" : ""}
            </span>
          </div>
        </div>
      </section>

      <StageRibbon
        stages={run.stages}
        state={run.state}
        mode={run.mode}
        finalStreaming={run.finalStreaming}
      />

      {run.notices.filter((notice) => notice.level !== "info").length > 0 ? (
        <div className="notice-list" aria-label="运行提示">
          {run.notices
            .filter((notice) => notice.level !== "info")
            .slice(-4)
            .map((notice, index) => (
              <div className={`notice notice--${notice.level}`} key={`${notice.at}-${index}`} role="status">
                <span className={`tag ${notice.level === "error" ? "tag-err" : "tag-warn"}`}>
                  {notice.level === "error" ? "错误" : "提示"}
                </span>
                <span>{truncate(notice.message, 400)}</span>
              </div>
            ))}
        </div>
      ) : null}

      {run.error ? (
        <div className="error-card" role="alert">
          <span className="error-card__icon" aria-hidden="true">
            <IconAlert size={14} />
          </span>
          <div className="error-card__body">
            <div className="error-card__title">本次运行未能正常结束</div>
            <p className="error-card__message">{run.error}</p>
          </div>
          <div className="error-card__actions">
            {run.origin === "history" ? null : (
              <button type="button" className="btn btn-sm" onClick={onRerun}>
                <IconPlay size={11} /> 重试
              </button>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenSettings}>
              <IconTerminal size={11} /> 检查连接
            </button>
          </div>
        </div>
      ) : null}

      {finalVisible ? (
        <div className="final-anchor" ref={finalRef}>
          <FinalAnswer
            text={run.finalText}
            streaming={run.finalStreaming}
            state={run.state}
            usage={run.usage}
            createdAt={run.createdAt}
            finishedAt={run.finishedAt}
            participantCount={run.participants.length}
            judgeLabel={run.judge?.label}
            artifacts={run.artifacts}
            runId={run.id}
            memoryInjected={run.memoryInjected}
            onReSynthesize={onReSynthesize}
            onFollowUp={onFollowUp}
          />
        </div>
      ) : null}

      <details className="team-process" open={running || !finalVisible} key={run.id}>
        <summary>模型过程 <span>{completed}/{run.participants.length} 已结束</span></summary>
        <div className="team-process__body">
          <div className="participants-head">
            <span className="participants-head__title">参与者</span>
            <span className="participants-head__meta">
              {run.participants.length} 个模型 · {completed} 已结束
              {run.participants.some((participant) => participant.state === "error") ? (
                <>
                  {" · "}
                  <span style={{ color: "#fda4af" }}>
                    {run.participants.filter((participant) => participant.state === "error").length} 个失败
                  </span>
                </>
              ) : null}
            </span>
            <div className="participants-head__actions">
              {run.state === "running" ? (
                <span className="stream-strip" aria-live="polite">
                  <span className="stream-strip__spin" aria-hidden="true">
                    <IconLoader size={10} />
                  </span>
                  流式接收中
                </span>
              ) : null}
            </div>
          </div>

          {run.participants.length === 0 ? (
            <div className="rail-empty">
              <strong>没有参与者</strong>
              这次运行的参与者列表为空，检查运行参数或重新运行。
            </div>
          ) : (
            <div className="participants-grid">
              {run.participants.map((participant) => (
                <ParticipantCard
                  key={participant.id}
                  participant={participant}
                  now={now}
                  isJudge={judgeKey === `${participant.provider}:${participant.model}`}
                  roleLabel={
                    run.mode === "coordinate"
                      ? roleBySpec.get(`${participant.provider}:${participant.model}`)
                      : undefined
                  }
                  onEffortChange={
                    running && !participant.id.startsWith("spec-")
                      ? (effort) => onEffortChange(participant.id, effort)
                      : undefined
                  }
                  onStop={
                    running && participant.state === "streaming" && onStopParticipant
                      ? () => onStopParticipant(participant.id)
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          {stoppedParticipants.length > 0 ? (
            <div className="stopped-note" role="status">
              <span className="dot" aria-hidden="true" />
              已由你停止：{stoppedParticipants.map((participant) => participant.label).join("、")}
              <em>（未纳入完整结果，其余模型继续生成）</em>
            </div>
          ) : null}
        </div>
      </details>

      {run.state === "done" && !run.error ? (
        <div className="notice" role="status">
          <span className="tag tag-ok">
            <IconCheck size={9} /> 完成
          </span>
          <span>
            本次联合工作已结束 · 共 {run.participants.length} 个模型 · 用时{" "}
            {elapsed != null ? formatDuration(elapsed) : "—"}
            {usage?.totalTokens ? ` · ${formatTokens(usage.totalTokens)} token` : ""}
          </span>
        </div>
      ) : null}

      {offline ? (
        <div className="notice notice--warn" role="status">
          <span className="tag tag-warn">离线</span>
          <span>服务端暂时不可达，当前展示本地状态。恢复后重新运行即可。</span>
          <button type="button" className="btn btn-sm" onClick={onOpenSettings} style={{ marginLeft: "auto" }}>
            查看连接
          </button>
          <IconX size={10} style={{ display: "none" }} />
        </div>
      ) : null}
    </main>
  );
}
