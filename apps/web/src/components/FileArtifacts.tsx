import { useState } from "react";
import type { Artifact } from "@super-work/core";
import { outputExt } from "@super-work/core";
import { artifactUrl } from "../lib/api";
import {
  IconAlert,
  IconCode,
  IconDownload,
  IconFilePdf,
  IconFileText,
  IconImage,
  IconVideo,
} from "./Icons";

export interface FileArtifactsProps {
  files: Artifact[];
  runId: string;
  /** Chat / 卡片内使用的紧凑样式 */
  compact?: boolean;
}

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(ext: string) {
  if (ext === "pdf") return IconFilePdf;
  if (["docx", "xlsx", "pptx", "csv", "tsv", "md", "txt"].includes(ext)) return IconFileText;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return IconImage;
  if (["mp4", "webm", "mov", "m4v", "mp3", "wav", "m4a"].includes(ext)) return IconVideo;
  return IconCode;
}

/** 模型产出的文件列表：下载 + 文本预览 + 转换失败提示。 */
export function FileArtifacts({ files, runId, compact }: FileArtifactsProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (files.length === 0) {
    return <div className="artifact-empty">还没有文件产物。模型按文件协议输出后会实时出现在这里。</div>;
  }

  return (
    <div className={`file-list${compact ? " is-compact" : ""}`} role="list" aria-label="文件产物">
      {files.map((file) => {
        const ext = outputExt(file.title);
        const Icon = iconFor(ext);
        const url = artifactUrl(runId, file);
        const size = formatBytes(file.meta?.size);
        const error = typeof file.meta?.error === "string" ? file.meta.error : undefined;
        const converted = file.meta?.converted === true;
        const previewable = typeof file.text === "string" && file.text.length > 0;
        const open = openId === file.id;
        return (
          <div className="file-item" key={file.id} role="listitem">
            <div className="file-item__main">
              <span className={`file-item__icon is-${ext || "txt"}`} aria-hidden="true">
                <Icon size={15} />
              </span>
              <div className="file-item__names">
                <b className="file-item__name" title={file.title}>
                  {file.title}
                </b>
                <em className="file-item__meta" title={file.mime}>
                  {(ext || "txt").toUpperCase()}
                  {converted ? " · 已转换" : ""}
                  {size ? ` · ${size}` : ""}
                </em>
              </div>
            </div>
            <div className="file-item__actions">
              {url ? (
                <a
                  className="btn btn-sm"
                  href={url}
                  download={file.title}
                  title={`下载 ${file.title}`}
                  aria-label={`下载 ${file.title}`}
                >
                  <IconDownload size={11} /> 下载
                </a>
              ) : null}
              {previewable ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setOpenId(open ? null : file.id)}
                  aria-expanded={open}
                >
                  {open ? "收起" : "预览"}
                </button>
              ) : null}
            </div>
            {error ? (
              <div className="file-item__error" role="alert">
                <IconAlert size={11} /> {error}
              </div>
            ) : null}
            {open && previewable ? (
              <pre className="file-preview">{file.text!.slice(0, 60_000)}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
