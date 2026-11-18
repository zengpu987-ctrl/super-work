import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";

export interface RichTextProps {
  text: string;
  streaming?: boolean;
  className?: string;
  /** 复制/下载成功提示（可选） */
  onNotify?: (message: string) => void;
}

function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
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
    return Promise.resolve(ok);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * 答案渲染：Markdown / 公式 / 代码块工具栏 / 视频与文件链接。
 * 交互统一事件委托，避免每个代码块挂独立监听。
 */
export function RichText({ text, streaming, className, onNotify }: RichTextProps) {
  const html = useMemo(() => renderMarkdown(text, { streaming }), [text, streaming]);
  const ref = useRef<HTMLDivElement>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const notify = useCallback(
    (message: string) => {
      onNotify?.(message);
    },
    [onNotify],
  );

  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const onClick = async (event: MouseEvent): Promise<void> => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const copyBtn = target.closest<HTMLElement>("[data-code-copy]");
      const downloadBtn = target.closest<HTMLElement>("[data-code-download]");
      if (!copyBtn && !downloadBtn) return;
      const block = target.closest(".md-code");
      const code = block?.querySelector("code")?.textContent ?? "";
      const fileName = block?.getAttribute("data-filename") || "snippet.txt";
      if (!code) return;
      if (copyBtn) {
        const ok = await copyToClipboard(code);
        setCopiedKey(fileName);
        notify(ok ? "代码已复制" : "复制失败，请手动选择");
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopiedKey(null), 1600);
        return;
      }
      if (downloadBtn) {
        const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 2000);
        notify(`已下载 ${fileName}`);
      }
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [notify]);

  if (!text.trim()) return null;

  return (
    <div ref={ref} className={`rich-text${className ? ` ${className}` : ""}`} data-copied={copiedKey ?? undefined}>
      {/* 内容由 marked 渲染并经 DOMPurify 净化 */}
      <div className="rich-text__body" dangerouslySetInnerHTML={{ __html: html }} />
      {streaming ? <span className="cursor" aria-hidden="true" /> : null}
    </div>
  );
}
