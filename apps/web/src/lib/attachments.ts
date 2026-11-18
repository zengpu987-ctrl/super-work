/**
 * 命令区附件：类型判定、大小/数量限制、token 估算与上传视图模型。
 * 解析与提取由服务端完成（POST /api/uploads）；这里只保留纯函数，方便测试与复用。
 */
import type { AttachmentInput, AttachmentKind } from "@super-work/core";
import { estimateTokens } from "./format";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 图片在上下文里按"一张图约 800 token"粗估，与服务端预算提示对齐。 */
export const IMAGE_TOKEN_ESTIMATE = 800;
/** 预测览只展示前 2000 字（与设计稿一致）。 */
export const PREVIEW_CHARS = 2000;

export type AttachmentStage = "uploading" | "parsing" | "ready" | "error";

export interface AttachmentDraft {
  /** 本地稳定 id（上传前后都不变，chips key 用它） */
  localId: string;
  /** 服务端 attachment id（成功后才有） */
  id?: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  stage: AttachmentStage;
  /** 0-100 */
  progress: number;
  text?: string;
  preview?: string;
  dataUrl?: string;
  path?: string;
  chars?: number;
  error?: string;
  /** 重试时重新读取并上传 */
  file?: File;
}

export interface FileRejection {
  name: string;
  reason: string;
}

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "html",
  "htm",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "md",
  "mdx",
  "txt",
  "csv",
  "log",
  "conf",
  "env",
]);

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];

export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index < 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

export function classifyAttachment(name: string, mime: string): AttachmentKind {
  const ext = extensionOf(name);
  const lowerMime = (mime || "").toLowerCase();
  if (lowerMime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) {
    return "image";
  }
  if (lowerMime === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || lowerMime.includes("wordprocessingml")) return "docx";
  if (ext === "doc" || lowerMime === "application/msword") return "doc";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (TEXT_MIME_PREFIXES.some((prefix) => lowerMime.startsWith(prefix))) return "text";
  return "other";
}

export const ATTACHMENT_KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  pdf: "PDF",
  docx: "Word",
  doc: "Word",
  code: "代码",
  text: "文本",
  other: "文件",
};

export const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.h,.cpp,.css,.html,.sh,.yml,.yaml,.sql,.log";

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function newLocalId(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function draftFromFile(file: File): AttachmentDraft {
  return {
    localId: newLocalId(),
    name: file.name || "剪贴板文件",
    mime: file.type || "application/octet-stream",
    size: file.size,
    kind: classifyAttachment(file.name, file.type),
    stage: "uploading",
    progress: 0,
    file,
  };
}

/** 过滤一次投放的文件：超数量/超大/不支持的类型返回可读原因，不静默丢弃。 */
export function filterFiles(
  files: File[],
  existingCount: number,
): { accepted: File[]; rejected: FileRejection[] } {
  const accepted: File[] = [];
  const rejected: FileRejection[] = [];
  let count = existingCount;
  for (const file of files) {
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `最多 ${MAX_ATTACHMENTS} 个附件` });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: `超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}` });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: "文件为空" });
      continue;
    }
    const kind = classifyAttachment(file.name, file.type);
    if (kind === "other" && !file.type) {
      // 未知二进制类型直接拒绝，避免上传后才报解析失败。
      rejected.push({ name: file.name, reason: "暂不支持该文件类型" });
      continue;
    }
    accepted.push(file);
    count += 1;
  }
  return { accepted, rejected };
}

export function attachmentTokens(draft: AttachmentDraft): number {
  if (draft.kind === "image") return IMAGE_TOKEN_ESTIMATE;
  if (draft.text) return estimateTokens(draft.text);
  if (draft.preview) return estimateTokens(draft.preview);
  if (draft.chars) return Math.round(draft.chars * 0.6);
  return 0;
}

export function totalAttachmentTokens(drafts: AttachmentDraft[]): number {
  return drafts.filter((draft) => draft.stage === "ready").reduce((sum, draft) => sum + attachmentTokens(draft), 0);
}

export function isAttachmentBusy(draft: AttachmentDraft): boolean {
  return draft.stage === "uploading" || draft.stage === "parsing";
}

export function anyAttachmentBusy(drafts: AttachmentDraft[]): boolean {
  return drafts.some(isAttachmentBusy);
}

export function readyAttachmentInputs(drafts: AttachmentDraft[]): AttachmentInput[] {
  return drafts
    .filter((draft) => draft.stage === "ready" && draft.id)
    .map((draft) => ({
      id: draft.id!,
      name: draft.name,
      mime: draft.mime,
      kind: draft.kind,
      text: draft.text,
      path: draft.path,
      size: draft.size,
    }));
}

/** 读取 File 为 base64（不带 data: 前缀，服务端按 JSON 传输）。 */
export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function previewOf(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** 上传后把服务端 meta 合并回草稿（保留本地 id 与 file 以便重试）。 */
export function applyUploadMeta(
  draft: AttachmentDraft,
  meta: {
    id: string;
    name?: string;
    mime?: string;
    size?: number;
    kind?: AttachmentKind;
    chars?: number;
    preview?: string;
    dataUrl?: string;
    path?: string;
    text?: string;
    error?: string;
  },
): AttachmentDraft {
  if (meta.error) {
    return {
      ...draft,
      id: meta.id,
      stage: "error",
      progress: 100,
      error: meta.error,
    };
  }
  const text = meta.text;
  return {
    ...draft,
    id: meta.id,
    name: meta.name ?? draft.name,
    mime: meta.mime ?? draft.mime,
    size: meta.size ?? draft.size,
    kind: meta.kind ?? draft.kind,
    stage: "ready",
    progress: 100,
    text,
    chars: meta.chars ?? text?.length ?? draft.chars,
    preview: previewOf(meta.text) ?? meta.preview ?? draft.preview,
    dataUrl: meta.dataUrl ?? draft.dataUrl,
    path: meta.path ?? draft.path,
    error: undefined,
  };
}
