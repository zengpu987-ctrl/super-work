import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Artifact } from "@super-work/core";
import { artifactUrl } from "../lib/api";
import { FileArtifacts } from "./FileArtifacts";
import { RichText } from "./RichText";
import { estimateTokens, formatDuration, formatTokens } from "../lib/format";
import type { RunState } from "../lib/types";
import {
  IconAlert,
  IconCheck,
  IconCode,
  IconCopy,
  IconDownload,
  IconExternal,
  IconGrid,
  IconImage,
  IconFileText,
  IconLoader,
  IconRefresh,
  IconSpark,
  IconTerminal,
  IconVideo,
  IconX,
} from "./Icons";

export interface FinalAnswerProps {
  text: string;
  streaming: boolean;
  state: RunState;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  createdAt: number;
  finishedAt?: number;
  participantCount: number;
  judgeLabel?: string;
  artifacts: Artifact[];
  runId: string;
  /** 本次注入记忆条数；服务端未回传时 undefined → 按 0 展示并注明。 */
  memoryInjected?: number;
  onReSynthesize: () => void;
  onFollowUp: () => void;
}

type TabId = "answer" | "images" | "videos" | "code" | "files";
type CodeTab = "code" | "preview";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走兜底 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 把建模产物包成可独立运行的预览页。
 * 约定与 server 的 buildPreviewHtml 一致：本地 ESM three + importmap。
 */
function previewErrorScript(): string {
  return `<script>
(function(){
  function report(message){
    try { parent.postMessage({ type: "sw-preview-error", message: String(message) }, "*"); } catch (e) {}
  }
  window.addEventListener("error", function (event) {
    report((event && (event.message || (event.error && event.error.message))) || "预览脚本运行失败");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    report((reason && reason.message) || "预览 Promise 未处理异常");
  });
})();
<\/script>`;
}

function buildPreviewDoc(code: string, vendorUrl: string): string {
  const importmap = `<script type="importmap">{"imports":{"three":"${vendorUrl}","three/addons/":"/vendor/addons/"}}</script>`;
  const globalThree = `import * as THREE from "three"; window.THREE = THREE;`;
  const errorScript = previewErrorScript();
  if (/^\s*(<!doctype|<html)/i.test(code)) {
    if (/vendor\/three/i.test(code)) {
      if (/<\/head>/i.test(code)) return code.replace(/<\/head>/i, `${errorScript}</head>`);
      return `${errorScript}${code}`;
    }
    const injected = `${errorScript}\n${importmap}\n<script type="module">${globalThree}<\/script>`;
    if (/<\/head>/i.test(code)) return code.replace(/<\/head>/i, `${injected}</head>`);
    return `${injected}${code}`;
  }
  const hasImport = /^\s*import\s/m.test(code);
  const body = hasImport
    ? `${globalThree}\n${code}`
    : `${globalThree}\ntry {\n${code}\n} catch (err) { document.body.innerHTML = '<pre style="color:#e06c75;padding:12px;white-space:pre-wrap">预览执行失败：' + String(err) + '</pre>'; }`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<style>html,body{margin:0;height:100%;background:#0b0e15;overflow:hidden}canvas{display:block}body{color:#e8ecf3;font-family:system-ui,sans-serif}</style>
${errorScript}
${importmap}</head><body><div id="app"></div><script type="module">
${body}
<\/script></body></html>`;
}

export function FinalAnswer({
  text,
  streaming,
  state,
  usage,
  createdAt,
  finishedAt,
  participantCount,
  judgeLabel,
  artifacts,
  runId,
  memoryInjected,
  onReSynthesize,
  onFollowUp,
}: FinalAnswerProps) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<TabId>("answer");
  const [manualTab, setManualTab] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [imageCopied, setImageCopied] = useState(false);
  const [codeIndex, setCodeIndex] = useState(0);
  const [codeTab, setCodeTab] = useState<CodeTab>("code");
  const [vendor, setVendor] = useState<"idle" | "checking" | "ok" | "missing">("idle");
  const [vendorUrl, setVendorUrl] = useState("/vendor/three.module.js");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const images = useMemo(() => artifacts.filter((item) => item.kind === "image"), [artifacts]);
  const codes = useMemo(() => artifacts.filter((item) => item.kind === "code3d"), [artifacts]);
  const videos = useMemo(() => artifacts.filter((item) => item.kind === "video"), [artifacts]);
  const files = useMemo(() => artifacts.filter((item) => item.kind === "file"), [artifacts]);
  const activeCode = codes[Math.min(codeIndex, Math.max(0, codes.length - 1))];

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // 没有文本但已有产物时，自动落到产物页签（用户手动切过就不抢）。
  useEffect(() => {
    if (manualTab) return;
    if (!text.trim() && images.length > 0) setTab("images");
    else if (!text.trim() && images.length === 0 && videos.length > 0) setTab("videos");
    else if (!text.trim() && images.length === 0 && videos.length === 0 && codes.length > 0) setTab("code");
    else if (!text.trim() && images.length === 0 && videos.length === 0 && codes.length === 0 && files.length > 0) setTab("files");
  }, [codes.length, files.length, images.length, manualTab, text, videos.length]);

  const fileCountRef = useRef(files.length);
  // 新交付文件：自动切到文件页签；FileArtifacts 会在右侧打开预览。
  useEffect(() => {
    if (files.length > fileCountRef.current && files.length > 0 && !manualTab) {
      setTab("files");
    }
    fileCountRef.current = files.length;
  }, [files.length, manualTab]);

  useEffect(() => {
    if (tab !== "code" || codeTab !== "preview" || vendor !== "idle") return;
    setVendor("checking");
    let cancelled = false;
    void (async () => {
      for (const url of ["/vendor/three.module.js", "/vendor/three.min.js"]) {
        try {
          const res = await fetch(url, { cache: "no-store", method: "HEAD" });
          if (cancelled) return;
          if (res.ok) {
            setVendorUrl(url);
            setVendor("ok");
            return;
          }
        } catch {
          /* 继续尝试下一个 */
        }
      }
      if (!cancelled) setVendor("missing");
    })();
    return () => {
      cancelled = true;
    };
  }, [codeTab, tab, vendor]);

  // 预览 iframe 内的运行错误（WebGL 不可用 / 脚本报错）通过 postMessage 回报。
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; message?: string } | null;
      if (data && data.type === "sw-preview-error") {
        setPreviewError(data.message ?? "预览运行失败");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (codeTab !== "preview") setPreviewError(null);
  }, [codeTab]);

  // 灯箱：Esc 关闭 / ←→ 切换
  useEffect(() => {
    if (lightbox == null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setLightbox(null);
      else if (event.key === "ArrowRight" && images.length > 1) {
        setLightbox((prev) => (prev == null ? prev : (prev + 1) % images.length));
      } else if (event.key === "ArrowLeft" && images.length > 1) {
        setLightbox((prev) => (prev == null ? prev : (prev - 1 + images.length) % images.length));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [images.length, lightbox]);

  const handleCopyImage = useCallback(async () => {
    if (lightbox == null) return;
    const item = images[lightbox];
    const url = item ? artifactUrl(runId, item) : undefined;
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const type = blob.type || item?.mime || "image/png";
      if (navigator.clipboard && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        setImageCopied(true);
        setTimeout(() => setImageCopied(false), 1600);
        return;
      }
      await navigator.clipboard.writeText(url);
      setImageCopied(true);
      setTimeout(() => setImageCopied(false), 1600);
    } catch {
      /* 失败时保留下载/新窗口入口 */
    }
  }, [images, lightbox, runId]);

  const handleCopy = useCallback(async () => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1800);
  }, [text]);

  const handleDownloadMarkdown = (): void => {
    if (!text.trim()) return;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `super-work-${runId}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const selectTab = (next: TabId): void => {
    setManualTab(true);
    setTab(next);
  };

  const downloadCode = (): void => {
    if (!activeCode?.text) return;
    const mime = activeCode.mime ?? (activeCode.title.includes("建模") ? "text/html" : "text/plain");
    const ext = mime.includes("html") ? "html" : mime.includes("javascript") ? "js" : "txt";
    const blob = new Blob([activeCode.text], { type: `text/plain;charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeCode.title.replace(/[\\/:*?"<>|\s]+/g, "-")}.${ext}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const fullscreenPreview = (): void => {
    const node = previewRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen?.();
  };

  const duration = finishedAt ? finishedAt - createdAt : undefined;
  const totalTokens = usage?.totalTokens ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined);
  const estimated = text ? estimateTokens(text) : 0;
  const showTabs = images.length > 0 || videos.length > 0 || codes.length > 0 || files.length > 0;
  const memoryCount = memoryInjected ?? 0;

  return (
    <section className="final-card" aria-label="最终答案与产物">
      <header className="final-card__head">
        <span className="final-card__badge" aria-hidden="true">
          <IconSpark size={14} />
        </span>
        <div className="final-card__title">
          <h2>
            最终答案
            {judgeLabel ? <span className="final-card__judge">裁判：{judgeLabel}</span> : null}
          </h2>
          <p className="final-card__sub">
            {streaming
              ? "正在综合…"
              : state === "error"
                ? "运行中断，以下为已生成内容"
                : state === "done"
                  ? `已综合 ${participantCount} 个模型的输出${duration ? ` · ${formatDuration(duration)}` : ""}`
                  : "实时生成中"}
          </p>
        </div>
        <div className="final-card__actions">
          <button type="button" className="btn btn-sm" onClick={handleCopy} disabled={!text.trim()}>
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            <span>{copied ? "已复制" : "复制"}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleDownloadMarkdown}
            disabled={!text.trim()}
            title="把最终答案导出为 Markdown 文件"
          >
            <IconDownload size={12} /> .md
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onReSynthesize}
            disabled={!text.trim() || streaming || state === "running"}
            title="用一位参与者基于上述结果重新综合一版"
          >
            <IconRefresh size={12} /> 重新综合
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onFollowUp}
            disabled={!text.trim() || streaming}
            title="带着本轮结论继续追问"
          >
            <IconTerminal size={12} /> 继续追问
          </button>
        </div>
      </header>

      {showTabs ? (
        <div className="artifact-tabs" role="tablist" aria-label="最终答案与产物">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "answer"}
            className={`artifact-tab${tab === "answer" ? " is-active" : ""}`}
            onClick={() => selectTab("answer")}
          >
            答案
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "images"}
            className={`artifact-tab${tab === "images" ? " is-active" : ""}`}
            onClick={() => selectTab("images")}
            disabled={images.length === 0}
          >
            <IconImage size={12} /> 图片 <b className="mono">{images.length}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "videos"}
            className={`artifact-tab${tab === "videos" ? " is-active" : ""}`}
            onClick={() => selectTab("videos")}
            disabled={videos.length === 0}
          >
            <IconVideo size={12} /> 视频 <b className="mono">{videos.length}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            className={`artifact-tab${tab === "code" ? " is-active" : ""}`}
            onClick={() => selectTab("code")}
            disabled={codes.length === 0}
          >
            <IconCode size={12} /> 代码 <b className="mono">{codes.length}</b>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={`artifact-tab${tab === "files" ? " is-active" : ""}`}
            onClick={() => selectTab("files")}
            disabled={files.length === 0}
          >
            <IconFileText size={12} /> 文件 <b className="mono">{files.length}</b>
          </button>
          {tab !== "images" && images.length > 0 && streaming ? (
            <span className="artifact-tabs__live" role="status">
              <span className="dot dot-warn" aria-hidden="true" /> 生图产物实时到达
            </span>
          ) : null}
        </div>
      ) : null}

      {tab === "answer" ? (
        text ? (
          <div className="final-card__body" tabIndex={0} aria-live={streaming ? "polite" : "off"}>
            <RichText text={text} streaming={streaming} />
          </div>
        ) : (
          <div className="final-card__placeholder">
            {streaming || state === "running" ? (
              <>
                <span className="mini-spin" aria-hidden="true">
                  <IconLoader size={12} />
                </span>
                等待参与模型作答完成后开始综合…
              </>
            ) : images.length > 0 || videos.length > 0 || codes.length > 0 || files.length > 0 ? (
              "本次运行没有文本答案，但产出了文件 / 图片 / 代码，可在上方页签查看。"
            ) : (
              "本次运行没有生成最终答案。"
            )}
          </div>
        )
      ) : null}

      {tab === "videos" ? (
        <div className="artifact-videos" role="tabpanel" aria-label="视频产物">
          {videos.length === 0 ? (
            <div className="artifact-empty">还没有视频产物。</div>
          ) : (
            <div className="video-list">
              {videos.map((item) => {
                const url = artifactUrl(runId, item);
                return (
                  <figure className="video-card" key={item.id}>
                    {url ? (
                      <video className="video-card__player" controls preload="metadata" src={url} title={item.title} />
                    ) : (
                      <div className="artifact-empty">缺少视频地址</div>
                    )}
                    <figcaption>
                      <span className="video-card__title">{item.title}</span>
                      {typeof item.meta?.size === "number" ? (
                        <span className="video-card__meta mono">{formatBytes(Number(item.meta.size))}</span>
                      ) : null}
                      {url ? (
                        <a className="btn btn-sm" href={url} download={item.title} aria-label={`下载 ${item.title}`}>
                          <IconDownload size={11} /> 下载
                        </a>
                      ) : null}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {tab === "files" ? (
        <div className="artifact-files" role="tabpanel" aria-label="文件产物">
          <FileArtifacts files={files} runId={runId} />
        </div>
      ) : null}

      {tab === "images" ? (
        <div className="artifact-images" role="tabpanel" aria-label="图片产物">
          {images.length === 0 ? (
            <div className="artifact-empty">还没有图片产物。生图角色完成后会实时出现在这里。</div>
          ) : (
            <div className="image-grid">
              {images.map((item, index) => {
                const url = artifactUrl(runId, item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className="image-tile"
                    onClick={() => setLightbox(index)}
                    title={item.title}
                    aria-label={`查看图片 ${item.title}`}
                  >
                    {url ? (
                      <img src={url} alt={item.title} loading="lazy" />
                    ) : (
                      <span className="image-tile__missing">
                        <IconAlert size={14} /> 缺少图片地址
                      </span>
                    )}
                    <span className="image-tile__caption">{item.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {tab === "code" ? (
        <div className="artifact-code" role="tabpanel" aria-label="代码产物">
          {codes.length === 0 ? (
            <div className="artifact-empty">还没有代码产物。建模角色完成时会实时出现在这里。</div>
          ) : (
            <>
              <div className="code-bar">
                <div className="code-bar__list" role="tablist" aria-label="代码产物列表">
                  {codes.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`code-chip${index === codeIndex ? " is-active" : ""}`}
                      onClick={() => {
                        setCodeIndex(index);
                        setCodeTab("code");
                      }}
                      title={item.title}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
                <div className="code-bar__tabs" role="group" aria-label="代码或预览">
                  <button
                    type="button"
                    className={`code-tab${codeTab === "code" ? " is-active" : ""}`}
                    onClick={() => setCodeTab("code")}
                  >
                    <IconCode size={11} /> 代码
                  </button>
                  <button
                    type="button"
                    className={`code-tab${codeTab === "preview" ? " is-active" : ""}`}
                    onClick={() => setCodeTab("preview")}
                  >
                    <IconTerminal size={11} /> 预览
                  </button>
                  <button
                    type="button"
                    className="code-tab"
                    onClick={fullscreenPreview}
                    disabled={codeTab !== "preview"}
                    title="全屏预览"
                  >
                    <IconGrid size={11} /> 全屏
                  </button>
                  <button type="button" className="code-tab" onClick={downloadCode} title="下载代码（HTML/JS）">
                    <IconDownload size={11} /> 下载
                  </button>
                </div>
              </div>

              {codeTab === "code" ? (
                <pre className="code-block" tabIndex={0}>
                  <code>{activeCode?.text ?? "（该产物没有代码文本）"}</code>
                </pre>
              ) : (
                <div className="code-preview">
                  <div className="code-preview__notice" role="status">
                    <span className="tag tag-warn">沙箱</span>
                    <span>
                      iframe <code>sandbox="allow-scripts allow-same-origin"</code> · 只加载本地依赖 · 离线依赖{" "}
                      {vendor === "ok" ? (
                        <b className="is-ok">本地 {vendorUrl} 已就绪</b>
                      ) : vendor === "checking" ? (
                        "检测中…"
                      ) : vendor === "missing" ? (
                        <b className="is-missing">本地 three 依赖缺失（预览可能空白）</b>
                      ) : (
                        "待检测"
                      )}
                    </span>
                  </div>
                  {vendor === "missing" ? (
                    <div className="code-preview__missing" role="alert">
                      <IconAlert size={13} /> 未找到本地 three 依赖。请让 Lead 把{" "}
                      <code>three.module.js</code> 放到 <code>apps/web/public/vendor/</code>（构建脚本
                      prepare-web 会自动复制）。
                    </div>
                  ) : null}
                  {previewError ? (
                    <div className="code-preview__error" role="alert">
                      <span>
                        <IconAlert size={13} /> 预览未能正常渲染：{previewError}
                      </span>
                      <button type="button" className="btn btn-sm" onClick={downloadCode}>
                        <IconDownload size={11} /> 下载代码在本机运行
                      </button>
                    </div>
                  ) : null}
                  <div className="code-preview__stage" ref={previewRef}>
                    {activeCode?.text ? (
                      <iframe
                        className="code-preview__frame"
                        title={`${activeCode.title} 预览`}
                        sandbox="allow-scripts allow-same-origin"
                        srcDoc={buildPreviewDoc(activeCode.text, vendorUrl)}
                      />
                    ) : (
                      <div className="artifact-empty">没有可预览的代码。</div>
                    )}
                  </div>
                  <p className="code-preview__hint">
                    预览只使用本地依赖；如果代码里通过 CDN import three，会在离线环境失败。修改代码请回到「代码」页签。
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      <footer className="final-card__foot">
        <span>
          参与模型 <span className="mono">{participantCount}</span>
        </span>
        <span>
          耗时 <span className="mono">{duration != null ? formatDuration(duration) : streaming ? "计时中" : "—"}</span>
        </span>
        <span>
          答案≈<span className="mono">{formatTokens(Math.max(estimated, 0))}</span> tok
        </span>
        <span title={memoryInjected == null ? "服务端未回传注入记忆明细，按 0 展示" : undefined}>
          记忆注入 <span className="mono">{memoryCount}</span> 条
        </span>
        <span className="right">
          合计 <span className="mono">{totalTokens != null ? formatTokens(totalTokens) : "—"}</span> tok
          {usage?.inputTokens != null ? `（入 ${formatTokens(usage.inputTokens)} / 出 ${formatTokens(usage.outputTokens)}）` : ""}
        </span>
      </footer>

      {lightbox != null && images[lightbox] ? (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`查看图片 ${images[lightbox]!.title}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLightbox(null);
          }}
        >
          <button type="button" className="lightbox__close" onClick={() => setLightbox(null)} aria-label="关闭图片">
            <IconX size={18} />
          </button>
          {images.length > 1 ? (
            <>
              <button
                type="button"
                className="lightbox__nav lightbox__nav--prev"
                onClick={() => setLightbox((prev) => (prev == null ? prev : (prev - 1 + images.length) % images.length))}
                aria-label="上一张"
              >
                ‹
              </button>
              <button
                type="button"
                className="lightbox__nav lightbox__nav--next"
                onClick={() => setLightbox((prev) => (prev == null ? prev : (prev + 1) % images.length))}
                aria-label="下一张"
              >
                ›
              </button>
            </>
          ) : null}
          <figure className="lightbox__figure">
            {artifactUrl(runId, images[lightbox]!) ? (
              <img src={artifactUrl(runId, images[lightbox]!)} alt={images[lightbox]!.title} />
            ) : (
              <div className="artifact-empty">缺少图片地址</div>
            )}
            <figcaption>
              <span className="lightbox__caption">
                {images[lightbox]!.title}
                <span className="mono">
                  {lightbox + 1} / {images.length}
                </span>
              </span>
              <span className="lightbox__actions">
                <a
                  className="btn btn-sm"
                  href={artifactUrl(runId, images[lightbox]!) ?? "#"}
                  download={images[lightbox]!.title}
                  aria-label={`下载 ${images[lightbox]!.title}`}
                >
                  <IconDownload size={11} /> 下载
                </a>
                <button type="button" className="btn btn-sm" onClick={() => void handleCopyImage()}>
                  <IconCopy size={11} /> {imageCopied ? "已复制" : "复制图片"}
                </button>
                <a
                  className="btn btn-sm btn-ghost"
                  href={artifactUrl(runId, images[lightbox]!) ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <IconExternal size={11} /> 新窗口
                </a>
              </span>
            </figcaption>
          </figure>
        </div>
      ) : null}
    </section>
  );
}
