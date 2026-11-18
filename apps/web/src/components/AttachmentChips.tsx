/** 命令区附件 chips + 预览（图片 120px 缩略图 / 文本前 2000 字）。 */
import type { AttachmentDraft } from "../lib/attachments";
import {
  ATTACHMENT_KIND_LABEL,
  PREVIEW_CHARS,
  attachmentTokens,
  formatBytes,
} from "../lib/attachments";
import { formatNumber } from "../lib/format";
import {
  IconAlert,
  IconFileCode,
  IconFilePdf,
  IconFileText,
  IconImage,
  IconLoader,
  IconRefresh,
  IconUpload,
  IconX,
} from "./Icons";

export interface AttachmentChipsProps {
  attachments: AttachmentDraft[];
  expandedId: string | null;
  disabled?: boolean;
  onExpand: (localId: string | null) => void;
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
  onPick: () => void;
}

function KindIcon({ kind }: { kind: AttachmentDraft["kind"] }) {
  if (kind === "image") return <IconImage size={13} />;
  if (kind === "pdf") return <IconFilePdf size={13} />;
  if (kind === "docx" || kind === "doc") return <IconFileText size={13} />;
  if (kind === "code") return <IconFileCode size={13} />;
  return <IconFileText size={13} />;
}

export function AttachmentChips({
  attachments,
  expandedId,
  disabled,
  onExpand,
  onRetry,
  onRemove,
  onPick,
}: AttachmentChipsProps) {
  const expanded = attachments.find((draft) => draft.localId === expandedId);

  if (attachments.length === 0) {
    return (
      <div className="attach-toolbar">
        <button type="button" className="attach-add" onClick={onPick} title="添加附件（也可拖拽或 ⌘V 粘贴）">
          <IconUpload size={12} /> 附件
        </button>
        <span className="attach-hint">
          支持图片 / PDF / Word / 代码 · 最多 8 个 · 单个 20MB · 可拖拽或 ⌘V 粘贴
        </span>
      </div>
    );
  }

  return (
    <div className="attach-area">
      <div className="attach-toolbar">
        <span className="attach-count">
          <IconUpload size={11} /> 附件 {attachments.length}/8
        </span>
        <button type="button" className="attach-add" onClick={onPick} disabled={disabled}>
          ＋ 添加
        </button>
        <span className="attach-hint">可拖拽整区或 ⌘V 粘贴</span>
      </div>

      <div className="attach-chips" role="list" aria-label="附件列表">
        {attachments.map((draft) => {
          const busy = draft.stage === "uploading" || draft.stage === "parsing";
          const isError = draft.stage === "error";
          const isExpanded = expandedId === draft.localId;
          return (
            <div
              key={draft.localId}
              role="listitem"
              className={`attach-chip is-${draft.stage}${isExpanded ? " is-expanded" : ""}`}
              title={`${draft.name} · ${ATTACHMENT_KIND_LABEL[draft.kind]} · ${formatBytes(draft.size)}`}
            >
              <button
                type="button"
                className="attach-chip__body"
                onClick={() => onExpand(isExpanded ? null : draft.localId)}
                aria-expanded={isExpanded}
                aria-label={`查看附件 ${draft.name}`}
              >
                <span className={`attach-chip__icon is-${draft.kind}`}>
                  {busy ? <IconLoader size={12} className="spin" /> : <KindIcon kind={draft.kind} />}
                </span>
                <span className="attach-chip__main">
                  <span className="attach-chip__name">{draft.name}</span>
                  <span className="attach-chip__meta mono">
                    {ATTACHMENT_KIND_LABEL[draft.kind]}
                    <span className="sep">·</span>
                    {formatBytes(draft.size)}
                    {draft.stage === "ready" ? (
                      <>
                        <span className="sep">·</span>
                        {draft.kind === "image" ? "约 800 tokens" : `${formatNumber(attachmentTokens(draft))} tokens`}
                      </>
                    ) : null}
                    {draft.stage === "uploading" ? (
                      <>
                        <span className="sep">·</span>
                        上传 {draft.progress}%
                      </>
                    ) : null}
                    {draft.stage === "parsing" ? (
                      <>
                        <span className="sep">·</span>
                        解析中…
                      </>
                    ) : null}
                    {isError ? (
                      <>
                        <span className="sep">·</span>
                        失败
                      </>
                    ) : null}
                  </span>
                  {busy ? (
                    <span className="attach-chip__progress" aria-hidden="true">
                      <span style={{ width: `${draft.progress}%` }} />
                    </span>
                  ) : null}
                </span>
              </button>
              <span className="attach-chip__actions">
                {isError ? (
                  <button
                    type="button"
                    className="attach-chip__btn is-retry"
                    onClick={() => onRetry(draft.localId)}
                    title="重试上传"
                    aria-label={`重试 ${draft.name}`}
                  >
                    <IconRefresh size={11} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="attach-chip__btn"
                  onClick={() => onRemove(draft.localId)}
                  title="移除附件"
                  aria-label={`移除 ${draft.name}`}
                >
                  <IconX size={11} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {expanded && expanded.stage === "ready" ? (
        <div className="attach-preview">
          <div className="attach-preview__head">
            <span className="attach-preview__title">
              {expanded.kind === "image" ? "图片预览" : "提取预览"}
              <span className="mono">
                {expanded.kind === "image"
                  ? "约 800 tokens"
                  : `${formatNumber(expanded.chars ?? expanded.text?.length ?? 0)} 字 · 前 ${PREVIEW_CHARS} 字`}
              </span>
            </span>
            <button type="button" className="icon-btn" onClick={() => onExpand(null)} aria-label="收起预览">
              <IconX size={12} />
            </button>
          </div>
          {expanded.kind === "image" && expanded.dataUrl ? (
            <img className="attach-preview__image" src={expanded.dataUrl} alt={expanded.name} width={120} height={120} />
          ) : expanded.text ? (
            <pre className="attach-preview__text">{expanded.preview ?? expanded.text.slice(0, PREVIEW_CHARS)}</pre>
          ) : expanded.error ? (
            <p className="attach-preview__error">
              <IconAlert size={11} /> {expanded.error}
            </p>
          ) : (
            <p className="attach-preview__error">
              <IconAlert size={11} /> 该文件没有可预览的文本内容（图片会以原图随运行提交）。
            </p>
          )}
        </div>
      ) : null}

      {expanded && expanded.stage === "error" ? (
        <div className="attach-preview is-error">
          <p className="attach-preview__error">
            <IconAlert size={11} /> {expanded.name}：{expanded.error ?? "上传/解析失败"}
          </p>
          <div className="attach-preview__actions">
            <button type="button" className="btn btn-sm" onClick={() => onRetry(expanded.localId)}>
              <IconRefresh size={11} /> 重试
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onRemove(expanded.localId)}>
              移除后继续
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
