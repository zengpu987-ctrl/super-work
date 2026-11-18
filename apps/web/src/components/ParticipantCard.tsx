import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { PROVIDER_BY_ID } from "@super-work/core";
import type { EffortLevel } from "@super-work/core";
import type { ParticipantView } from "../lib/types";
import { stageLabel } from "../lib/types";
import { brandStyle } from "../lib/brand";
import { effortName, effortOf } from "../lib/effort";
import { estimateTokens, formatDuration, formatTokens } from "../lib/format";
import { BrandIcon } from "./BrandIcon";
import { EffortSelector } from "./EffortSelector";
import { IconAlert, IconChevronRight, IconLoader, IconStar, IconStopCircle } from "./Icons";

export interface ParticipantCardProps {
  participant: ParticipantView;
  now: number;
  isJudge: boolean;
  /** 配合模式下由角色编排解析出的角色名（含自定义角色） */
  roleLabel?: string;
  /** 运行中可热调强度；不传则只读 */
  onEffortChange?: (effort: EffortLevel) => Promise<void>;
  /** 运行中单独停止这个模型（其余模型继续）；不传则不显示停止入口 */
  onStop?: () => Promise<void> | void;
}

const STATE_META: Record<ParticipantView["state"], { label: string; className: string }> = {
  idle: { label: "待命", className: "" },
  streaming: { label: "作答中", className: "is-streaming" },
  done: { label: "已完成", className: "is-done" },
  error: { label: "失败", className: "is-error" },
  stopped: { label: "已停止", className: "is-stopped" },
};

export function ParticipantCard({ participant, now, isJudge, roleLabel, onEffortChange, onStop }: ParticipantCardProps) {
  const meta = PROVIDER_BY_ID[participant.provider];
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [activeStageIndex, setActiveStageIndex] = useState(0);
  const [effortSaving, setEffortSaving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reasoningRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const stateMeta = STATE_META[participant.state];
  const streaming = participant.state === "streaming";
  const stages = participant.stages ?? [];
  const hasStageTabs = stages.length >= 2;
  const safeStageIndex = Math.min(activeStageIndex, Math.max(0, stages.length - 1));
  const activeStage = hasStageTabs ? stages[safeStageIndex] : undefined;

  // 按阶段展示：text / reasoning 都跟随当前阶段；stages 缺失时保持原有单段行为。
  const displayText = activeStage ? activeStage.text : participant.text;
  const displayReasoning = activeStage
    ? (activeStage.reasoning ?? (safeStageIndex === 0 ? participant.reasoning : ""))
    : participant.reasoning;
  const elapsed =
    streaming && participant.startedAt
      ? Math.max(0, now - participant.startedAt)
      : participant.latencyMs;
  const usage = participant.usage;
  const outTokens = usage?.outputTokens ?? usage?.totalTokens;
  const showCursor = streaming && (!hasStageTabs || safeStageIndex === stages.length - 1);

  // 切换到另一个参与者实例时重置阶段与滚动。
  useEffect(() => {
    setActiveStageIndex(0);
    stickRef.current = true;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    if (reasoningRef.current) reasoningRef.current.scrollTop = 0;
  }, [participant.id]);

  useEffect(() => {
    if (activeStageIndex > 0 && activeStageIndex >= stages.length) setActiveStageIndex(0);
  }, [activeStageIndex, stages.length]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [displayText, displayReasoning]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const selectStage = (index: number): void => {
    setActiveStageIndex(index);
    stickRef.current = true;
    // 切换阶段后回到该段文本顶部
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      if (reasoningRef.current) reasoningRef.current.scrollTop = 0;
    });
  };

  return (
    <article
      className={`participant-card is-${participant.state}`}
      style={brandStyle(meta?.color ?? "#64748b") as unknown as CSSProperties}
      aria-label={`${participant.label}（${meta?.name ?? participant.provider}），角色 ${roleLabel || participant.role}，状态 ${stateMeta.label}`}
    >
      <header className="participant-card__head">
        <BrandIcon
          provider={participant.provider}
          size={22}
          title={`${meta?.name ?? participant.provider} 官方商标`}
        />
        <div className="participant-card__title">
          <span className="participant-card__name" title={participant.label}>
            {participant.label}
          </span>
          <span className="participant-card__model" title={participant.model}>
            {meta?.name ?? participant.provider} · {participant.model}
          </span>
        </div>
        <span className={`participant-card__state ${stateMeta.className}`}>
          <span className="dot" aria-hidden="true" />
          {stateMeta.label}
        </span>
        {participant.state === "streaming" && onStop ? (
          <button
            type="button"
            className="participant-card__stop"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop();
              } finally {
                setStopping(false);
              }
            }}
            title="停止此模型，保留已生成内容"
            aria-label={`停止 ${participant.label}`}
          >
            {stopping ? <IconLoader size={11} className="spin" /> : <IconStopCircle size={12} />}
            <span className="participant-card__stop-text">{stopping ? "停止中…" : "停止"}</span>
          </button>
        ) : null}
      </header>

      <div className="participant-card__role">
        <span className={`tag${roleLabel && roleLabel !== participant.role ? " tag-accent" : ""}`}>
          {roleLabel || participant.role || "独立视角"}
        </span>
        {isJudge ? (
          <span className="tag tag-accent">
            <IconStar size={9} /> 裁决者
          </span>
        ) : null}
        {hasStageTabs ? (
          <span className="tag" title="该模型在不同阶段都有发言，可在下方切换">
            {stages.length} 阶段
          </span>
        ) : null}
      </div>

      <div className="participant-card__effort">
        <span className="participant-card__effort-label">强度</span>
        <EffortSelector
          size="md"
          value={participant.effortNext ?? participant.effort}
          onChange={(next) => {
            if (!onEffortChange) return;
            setEffortSaving(true);
            void onEffortChange(next).finally(() => setEffortSaving(false));
          }}
          disabled={!onEffortChange || effortSaving}
          ariaLabel={`${participant.label} 推理强度`}
        />
        <span className="participant-card__effort-current">
          本次：{effortName(participant.effort)}
        </span>
        {participant.effortNext && participant.effortNext !== participant.effort ? (
          <span className="participant-card__effort-next" role="status">
            下次生效
          </span>
        ) : null}
        {!onEffortChange ? <span className="participant-card__effort-readonly">只读</span> : null}
      </div>

      {hasStageTabs ? (
        <div className="stage-tabs" role="group" aria-label="按阶段查看该模型的输出">
          {stages.map((stage, index) => (
            <button
              key={`${stage.stage}-${index}`}
              type="button"
              className={`stage-tab${index === safeStageIndex ? " is-active" : ""}`}
              onClick={() => selectStage(index)}
              aria-pressed={index === safeStageIndex}
              aria-label={`查看${stageLabel(stage.stage)}阶段输出`}
              title={`${stageLabel(stage.stage)} · ${stage.text.length} 字`}
            >
              {stageLabel(stage.stage)}
            </button>
          ))}
        </div>
      ) : null}

      {displayReasoning.length > 0 ? (
        <div className="reasoning">
          <button
            type="button"
            className="reasoning__toggle"
            onClick={() => setReasoningOpen((prev) => !prev)}
            aria-expanded={reasoningOpen}
            aria-label={reasoningOpen ? "收起思考过程" : "展开思考过程"}
          >
            <span className="chevron" aria-hidden="true">
              <IconChevronRight size={11} />
            </span>
            思考过程
            {streaming && !displayText ? (
              <span className="mini-spin" aria-hidden="true">
                <IconLoader size={10} />
              </span>
            ) : null}
            <span className="reasoning__count">
              ≈{formatTokens(estimateTokens(displayReasoning))} tok
            </span>
          </button>
          {reasoningOpen ? (
            <div className="reasoning__body" ref={reasoningRef}>
              {displayReasoning}
              {showCursor && !displayText ? <span className="cursor" aria-hidden="true" /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="participant-card__body" ref={bodyRef} onScroll={onScroll} tabIndex={0}>
        {participant.error && participant.state !== "stopped" ? (
          <div className="participant-card__error" role="alert">
            <IconAlert size={12} />
            <span>{participant.error}</span>
          </div>
        ) : null}
        {displayText ? <span>{displayText}</span> : null}
        {participant.state === "stopped" ? (
          <div className="participant-card__stopped-note">已由你停止 · 以上为部分输出</div>
        ) : null}
        {!displayText && !participant.error ? (
          <div className="participant-card__placeholder">
            {streaming ? (
              <>
                <span className="mini-spin" aria-hidden="true">
                  <IconLoader size={11} />
                </span>
                正在生成…
              </>
            ) : participant.state === "done" ? (
              "（此阶段没有文本输出）"
            ) : participant.state === "stopped" ? (
              "已停止，这一阶段没有输出"
            ) : (
              "等待调度…"
            )}
          </div>
        ) : null}
        {showCursor ? <span className="cursor" aria-hidden="true" /> : null}
      </div>

      <footer className="participant-card__foot">
        <span title="本段耗时">{elapsed != null ? formatDuration(elapsed) : "—"}</span>
        {outTokens != null ? <span className="sep">|</span> : null}
        {outTokens != null ? <span title="输出 token">{formatTokens(outTokens)} tok</span> : null}
        {usage?.reasoningTokens ? (
          <>
            <span className="sep">|</span>
            <span title="推理 token">思考 {formatTokens(usage.reasoningTokens)}</span>
          </>
        ) : null}
        <span className="right">
          {streaming ? "接收流式输出" : participant.state === "error" ? "调用失败" : ""}
        </span>
      </footer>
    </article>
  );
}
