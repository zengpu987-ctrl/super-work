import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import type { EffortLevel, ParticipantSpec, RunMode } from "@super-work/core";
import { PROVIDER_BY_ID } from "@super-work/core";
import { brandStyle } from "../lib/brand";
import { MODE_META, specKey } from "../lib/types";
import type { FollowUpContext } from "../lib/types";
import { formatNumber, truncate } from "../lib/format";
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, type AttachmentDraft } from "../lib/attachments";
import { AttachmentChips } from "./AttachmentChips";
import { BrandIcon } from "./BrandIcon";
import { EffortSelector } from "./EffortSelector";
import {
  IconAlert,
  IconBrain,
  IconPanelRight,
  IconArrowUp,
  IconStop,
  IconUpload,
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface ComposerProps {
  command: string;
  onCommandChange: (value: string) => void;
  mode: RunMode;
  participants: ParticipantSpec[];
  judgeKey: string | null;
  onRemoveParticipant: (index: number) => void;
  onOpenPicker: () => void;
  onRun: () => void;
  onStop: () => void;
  running: boolean;
  busy: boolean;
  offline: boolean;
  followUp: FollowUpContext | null;
  onClearFollowUp: () => void;
  useMemory: boolean;
  onUseMemoryChange: (value: boolean) => void;
  /** 由 App 依据模式 / 角色 / 价格算出来的预估文案 */
  estimateText: string;
  /** 当前参与模型里没有可用连接的个数 */
  unavailableCount: number;
  /* v0.0.3 附件 */
  attachments: AttachmentDraft[];
  attachmentBusy: boolean;
  attachmentTokens: number;
  attachmentTokenLimit?: number;
  expandedAttachmentId: string | null;
  onExpandedAttachmentChange: (localId: string | null) => void;
  onAddFiles: (files: File[]) => void;
  onRetryAttachment: (localId: string) => void;
  onRemoveAttachment: (localId: string) => void;
  /** 多轮对话：当前是第几轮（>1 时按钮改为「继续第 N 轮」） */
  round?: number;
  /** Chat：唯一模型与档位 */
  chatModel?: ParticipantSpec | null;
  onChatEffortChange?: (effort: EffortLevel) => void;
  onClearChatModel?: () => void;
}

export function Composer({
  command,
  onCommandChange,
  mode,
  participants,
  judgeKey,
  onRemoveParticipant,
  onOpenPicker,
  onRun,
  onStop,
  running,
  busy,
  offline,
  followUp,
  onClearFollowUp,
  useMemory,
  onUseMemoryChange,
  estimateText,
  unavailableCount,
  attachments,
  attachmentBusy,
  attachmentTokens,
  attachmentTokenLimit,
  expandedAttachmentId,
  onExpandedAttachmentChange,
  onAddFiles,
  onRetryAttachment,
  onRemoveAttachment,
  round = 1,
  chatModel,
  onChatEffortChange,
  onClearChatModel,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const tokenLimitExceeded =
    attachmentTokenLimit != null && attachmentTokenLimit > 0 && attachmentTokens > attachmentTokenLimit;
  const runDisabled = busy || attachmentBusy || command.trim().length === 0 || tokenLimitExceeded;

  // 输入内容变化时自适应高度（上限由 CSS 控制）。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(168, Math.max(36, el.scrollHeight))}px`;
  }, [command]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!running && !runDisabled && !event.repeat) onRun();
      }
    },
    [onRun, runDisabled, running],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      const files: File[] = [];
      const items = Array.from(event.clipboardData?.items ?? []);
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (files.length === 0) {
        for (const file of Array.from(event.clipboardData?.files ?? [])) files.push(file);
      }
      if (files.length === 0) return;
      event.preventDefault();
      onAddFiles(files);
    },
    [onAddFiles],
  );

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onAddFiles(files);
    },
    [onAddFiles],
  );

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const unavailable = unavailableCount;
  const chat = mode === "chat";
  const isJudge = (participant: ParticipantSpec): boolean =>
    judgeKey != null && specKey(participant) === judgeKey;

  return (
    <section
      className={`composer${dragActive ? " is-dragging" : ""}`}
      aria-label="命令台"
      onPaste={handlePaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive ? (
        <div className="composer__drop" role="status">
          <span className="composer__drop-icon">
            <IconUpload size={18} />
          </span>
          <strong>松开上传附件</strong>
          <span>图片 / PDF / Word / 代码，最多 {MAX_ATTACHMENTS} 个，单个 20MB</span>
        </div>
      ) : null}

      <div className="composer__inner">
        {followUp ? (
          <div className="composer__followup">
            <IconPanelRight size={12} />
            <span className="truncate">
              基于运行「{followUp.label}」继续追问 · 会将上一轮最终答案作为上下文一起发送
            </span>
            <button type="button" onClick={onClearFollowUp} aria-label="取消继续追问上下文">
              <IconX size={11} />
            </button>
          </div>
        ) : null}

        <div className="composer__box">
          <textarea
            id="command-input"
            ref={textareaRef}
            className="composer__input"
            value={command}
            onChange={(event) => onCommandChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              chat
                ? "发消息…"
                : "交给模型团队一个任务…"
            }
            rows={1}
            spellCheck={false}
            aria-label="命令输入"
            aria-describedby="composer-hint"
          />
          <div className="composer__attachments">
            <AttachmentChips
              attachments={attachments}
              expandedId={expandedAttachmentId}
              onExpand={onExpandedAttachmentChange}
              onRetry={onRetryAttachment}
              onRemove={onRemoveAttachment}
              onPick={pickFiles}
            />
          </div>
          <div className="composer__send">
            {running ? (
              <button type="button" className="composer__stop" onClick={onStop} aria-label="停止当前运行">
                <IconStop size={13} /> 停止
              </button>
            ) : (
              <button
                type="button"
                className="composer__run"
                onClick={onRun}
                disabled={runDisabled}
                title={
                  attachmentBusy
                    ? "附件仍在上传或解析中，完成后才能运行"
                    : tokenLimitExceeded
                      ? "附件已超出单次运行 token 上限"
                      : round > 1
                        ? `继续第 ${round} 轮：自动带上前面几轮的命令与最终答案`
                        : chat
                          ? `发送给 ${chatModel?.model ?? "模型"}（⌘ 或 Ctrl + Enter）`
                          : "运行命令（⌘ 或 Ctrl + Enter）"
                }
                aria-label={
                  round > 1
                    ? `继续第 ${round} 轮`
                    : chat
                      ? "发送消息"
                      : "运行命令（⌘ 或 Ctrl + Enter）"
                }
              >
                <IconArrowUp size={17} />
                <span className="sr-only">{busy ? "启动中…" : attachmentBusy ? "附件处理中…" : round > 1 ? `继续第 ${round} 轮` : chat ? "发送" : "运行"}</span>
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) onAddFiles(files);
            event.target.value = "";
          }}
          tabIndex={-1}
          aria-hidden="true"
        />

        <div className="composer__bar">
          <div className="composer__routing">
            <span className="composer__mode">
              {MODE_META[mode]?.name ?? mode}
              <span className="composer__mode-en">{MODE_META[mode]?.short ?? mode}</span>
            </span>
            {round > 1 ? (
              <span className="composer__round" title={`这是当前工作的第 ${round} 轮，运行时会自动带上前几轮`}>
                第 {round} 轮
              </span>
            ) : null}

            <span className="composer__bar-divider" aria-hidden="true" />

            <div className="chips" aria-label="当前参与模型">
              {participants.length === 0 ? (
                <span className="chips__empty">
                  <IconAlert size={11} /> 还没有参与模型
                </span>
              ) : (
                participants.map((participant, index) => {
                  const meta = PROVIDER_BY_ID[participant.provider];
                  const key = `${participant.provider}:${participant.model}:${index}`;
                  const judge = isJudge(participant);
                  const label = meta?.models.find((m) => m.id === participant.model)?.name ?? participant.model;
                  return (
                    <span
                      key={key}
                      className="chip"
                      style={brandStyle(meta?.color ?? "#64748b") as unknown as CSSProperties}
                      title={`${meta?.name ?? participant.provider} · ${participant.model}${participant.role ? ` · ${participant.role}` : ""}`}
                    >
                      <BrandIcon
                        provider={participant.provider}
                        size={13}
                        className="brand-icon--inline"
                        title={`${meta?.name ?? participant.provider} 官方商标`}
                      />
                      <span className="chip__name">{truncate(label, 22)}</span>
                      {judge ? (
                        <span className="chip__judge" aria-label="裁决者">
                          ★
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="chip__remove"
                        onClick={() => {
                          if (chat) onClearChatModel?.();
                          else onRemoveParticipant(index);
                        }}
                        aria-label={chat ? `更换模型（当前 ${label}）` : `移除 ${label}`}
                      >
                        <IconX size={9} />
                      </button>
                    </span>
                  );
                })
              )}
              <button
                type="button"
                className="chips__add"
                onClick={onOpenPicker}
                aria-label="打开参与模型编排"
              >
                <IconPanelRight size={11} /> 编排
              </button>
            </div>

            {chat && chatModel ? (
              <span className="composer__chat-effort" title="Chat 档位：影响推理强度与输出长度；运行中在画布上也能调">
                <span className="composer__chat-effort-label">档位</span>
                <EffortSelector
                  size="sm"
                  value={chatModel.effort ?? "medium"}
                  onChange={(effort) => onChatEffortChange?.(effort)}
                  ariaLabel="Chat 档位"
                />
              </span>
            ) : null}
          </div>

          <div className="composer__meta" id="composer-hint">
            {offline ? (
              <span className="composer__warning">
                <IconAlert size={10} /> 服务离线
              </span>
            ) : null}
            {unavailable > 0 ? (
              <span className="composer__warning">
                <IconAlert size={10} /> {unavailable} 个模型未连接
              </span>
            ) : null}
            {attachments.length > 0 ? (
              <span className={`composer__attach-meta${tokenLimitExceeded ? " is-over" : ""}`}>
                <IconAlert size={10} />
                附件约 {formatNumber(attachmentTokens)} tokens
                {tokenLimitExceeded ? ` · 超出单次上限 ${formatNumber(attachmentTokenLimit ?? 0)}` : ""}
                {attachmentBusy ? " · 上传/解析中禁止运行" : ""}
              </span>
            ) : null}
            <span>{estimateText}</span>
            <span className="composer__bar-divider" aria-hidden="true" />
            <span className="paddle-inline" title="运行时召回长期记忆并注入 system prompt">
              <IconBrain size={12} />
              <span>使用记忆</span>
              <PaddleSwitch
                size="sm"
                checked={useMemory}
                onChange={(next) => onUseMemoryChange(next)}
                ariaLabel="使用记忆"
              />
            </span>
            <span className="composer__bar-divider" aria-hidden="true" />
            <span>
              <kbd className="kbd">⌘</kbd>
              <span style={{ margin: "0 3px" }}>/</span>
              <kbd className="kbd">Ctrl</kbd> + <kbd className="kbd">↵</kbd> 运行
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
