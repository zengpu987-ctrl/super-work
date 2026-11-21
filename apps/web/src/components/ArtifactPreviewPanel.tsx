import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Artifact } from "@super-work/core";
import { outputExt } from "@super-work/core";
import { artifactUrl } from "../lib/api";
import {
  IconCode,
  IconDownload,
  IconExternal,
  IconFilePdf,
  IconFileText,
  IconImage,
  IconVideo,
  IconX,
} from "./Icons";

export interface ArtifactPreviewPanelProps {
  files: Artifact[];
  runId: string;
  initialId?: string | null;
  onClose: () => void;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "aac", "ogg"]);
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
  "cpp", "hpp", "cs", "php", "sql", "sh", "bash", "zsh", "json", "yaml", "yml", "toml", "xml",
  "html", "css", "scss", "md", "txt", "csv", "tsv", "log",
]);
const KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "import", "from", "export", "default", "return",
  "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch", "finally",
  "throw", "new", "async", "await", "yield", "type", "interface", "enum", "extends", "implements",
  "public", "private", "protected", "static", "readonly", "def", "lambda", "None", "True", "False",
  "package", "func", "struct", "impl", "use", "pub", "fn", "match", "where", "select", "insert",
  "update", "delete", "create", "table", "and", "or", "not", "null", "true", "false", "this", "self",
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** 轻量语法高亮：不引入额外依赖，先转义再打 token，避免执行文件内容。 */
function highlightCode(code: string, ext: string): string {
  if (ext === "html" || ext === "xml") {
    return escapeHtml(code).replace(
      /(&lt;\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?&gt;)/g,
      (_m, open: string, tag: string, attrs: string, close: string) =>
        `<span class="tok-tag">${open}${tag}</span>${attrs.replace(/([\w:-]+)=(&quot;[^&]*?&quot;)/g, '<span class="tok-attr">$1</span>=<span class="tok-str">$2</span>')}<span class="tok-tag">${close}</span>`,
    );
  }
  if (ext === "json") {
    return escapeHtml(code).replace(
      /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
      (_m, str?: string, colon?: string, lit?: string, num?: string) =>
        str
          ? `<span class="${colon ? "tok-key" : "tok-str"}">${str}</span>${colon ?? ""}`
          : lit
            ? `<span class="tok-lit">${lit}</span>`
            : `<span class="tok-num">${num ?? ""}</span>`,
    );
  }
  const pattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b(?:const|let|var|function|class|import|from|export|default|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|async|await|yield|type|interface|enum|extends|implements|public|private|protected|static|readonly|def|lambda|None|True|False|package|func|struct|impl|use|pub|fn|match|where|select|insert|update|delete|create|table|and|or|not|null|true|false|this|self)\b)|(\b\d+(?:\.\d+)?\b)/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    out += escapeHtml(code.slice(last, match.index));
    const [raw, comment, str, keyword, num] = match;
    const cls = comment ? "tok-comment" : str ? "tok-str" : keyword ? "tok-key" : "tok-num";
    out += `<span class="${cls}">${escapeHtml(raw ?? num ?? "")}</span>`;
    last = match.index + raw.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function fileIcon(ext: string) {
  if (ext === "pdf") return IconFilePdf;
  if (IMAGE_EXTS.has(ext)) return IconImage;
  if (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return IconVideo;
  if (CODE_EXTS.has(ext)) return IconCode;
  return IconFileText;
}

export function ArtifactPreviewPanel({ files, runId, initialId, onClose }: ArtifactPreviewPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(initialId ?? files[files.length - 1]?.id ?? null);
  const active = files.find((file) => file.id === activeId) ?? files[files.length - 1];
  const ext = active ? outputExt(active.title) : "";
  const url = active ? artifactUrl(runId, active) : undefined;
  const code = active?.text ?? "";
  const highlighted = useMemo(
    () => (active && CODE_EXTS.has(ext) ? highlightCode(code, ext) : ""),
    [active, code, ext],
  );

  if (!active) return null;

  const body = (() => {
    if (ext === "pdf" && url) {
      return (
        <div className="artifact-preview__pdf">
          <iframe src={url} title={active.title} />
        </div>
      );
    }
    if (IMAGE_EXTS.has(ext) && url) {
      return (
        <div className="artifact-preview__media">
          <img src={url} alt={active.title} />
        </div>
      );
    }
    if (VIDEO_EXTS.has(ext) && url) {
      return (
        <div className="artifact-preview__media">
          <video src={url} controls preload="metadata" />
        </div>
      );
    }
    if (AUDIO_EXTS.has(ext) && url) {
      return (
        <div className="artifact-preview__audio">
          <audio src={url} controls preload="metadata" />
        </div>
      );
    }
    if (ext === "html" && code) {
      return (
        <iframe
          className="artifact-preview__html"
          title={`${active.title} 可视化`}
          sandbox="allow-scripts"
          srcDoc={code}
        />
      );
    }
    if (code) {
      return (
        <div className="artifact-preview__code">
          <div className="artifact-preview__codebar">
            <span>{ext.toUpperCase() || "TEXT"}</span>
            <span>{code.split("\n").length} 行</span>
          </div>
          <pre dangerouslySetInnerHTML={{ __html: highlighted }} />
        </div>
      );
    }
    return (
      <div className="artifact-preview__empty">
        <IconFileText size={24} />
        <p>这个文件没有可内嵌的文本内容。</p>
        {url ? <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">在新窗口打开</a> : null}
      </div>
    );
  })();

  return createPortal(
    <aside className="artifact-preview" role="dialog" aria-label="文件预览">
      <header className="artifact-preview__head">
        <span className="artifact-preview__title">
          {fileIcon(ext) ? (() => { const Icon = fileIcon(ext); return <Icon size={14} />; })() : null}
          <b title={active.title}>{active.title}</b>
          <em>{ext.toUpperCase()}</em>
        </span>
        <span className="artifact-preview__actions">
          {url ? (
            <a className="icon-btn" href={url} target="_blank" rel="noreferrer" title="新窗口打开" aria-label="新窗口打开">
              <IconExternal size={13} />
            </a>
          ) : null}
          {url ? (
            <a className="icon-btn" href={url} download={active.title} title="下载" aria-label="下载">
              <IconDownload size={13} />
            </a>
          ) : null}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭文件预览" title="关闭">
            <IconX size={14} />
          </button>
        </span>
      </header>
      <nav className="artifact-preview__tabs" aria-label="文件列表">
        {files.map((file) => {
          const fExt = outputExt(file.title);
          const Icon = fileIcon(fExt);
          return (
            <button
              key={file.id}
              type="button"
              className={`artifact-preview__tab${file.id === active.id ? " is-active" : ""}`}
              onClick={() => setActiveId(file.id)}
              title={file.title}
            >
              <Icon size={12} />
              <span>{file.title}</span>
            </button>
          );
        })}
      </nav>
      <div className="artifact-preview__body">{body}</div>
    </aside>,
    document.body,
  );
}
