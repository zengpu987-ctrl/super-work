/**
 * 答案输出渲染：Markdown + KaTeX 数学 + 代码块工具栏 + 媒体/文件链接规范化。
 * 安全：marked → DOMPurify（html + svg + mathMl profile）。
 */
import { marked } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";

const EXT_BY_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  typescript: "ts",
  jsx: "jsx",
  mjs: "mjs",
  cjs: "cjs",
  python: "py",
  py: "py",
  bash: "sh",
  sh: "sh",
  zsh: "sh",
  shell: "sh",
  json: "json",
  jsonl: "jsonl",
  yaml: "yml",
  yml: "yml",
  toml: "toml",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  xml: "xml",
  svg: "svg",
  md: "md",
  markdown: "md",
  csv: "csv",
  tex: "tex",
  latex: "tex",
  go: "go",
  rust: "rs",
  java: "java",
  kotlin: "kt",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  cs: "cs",
  ruby: "rb",
  php: "php",
  r: "r",
  lua: "lua",
  diff: "diff",
  plaintext: "txt",
  text: "txt",
  console: "txt",
  output: "txt",
  shellscript: "sh",
};

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac"]);
const FILE_EXT = new Set([
  "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "zip", "csv", "tsv", "md", "txt",
  "json", "tex", "rtf", "ics", "ipynb", "py", "ts", "js", "html", "yml", "yaml", "xml",
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extOfUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const match = /\.([A-Za-z0-9]{2,5})$/.exec(clean);
  return match ? match[1]!.toLowerCase() : "";
}

function parseFence(info: string): { lang: string; ext: string; filename?: string } {
  const first = (info ?? "").trim().split(/\s+/)[0] ?? "";
  const lang = first.toLowerCase();
  const attrs = info ?? "";
  const named = /(?:filename|title|name)=("([^"]+)"|'([^']+)'|([^\s]+))/.exec(attrs);
  const filename = named ? (named[2] ?? named[3] ?? named[4]) : undefined;
  const ext = EXT_BY_LANG[lang] ?? (lang ? lang.replace(/[^a-z0-9]/g, "") : "txt");
  return { lang: first || "text", ext: ext || "txt", filename };
}

const MATH_SLOT = (n: number): string => `<span class="md-math-slot" data-math="${n}"></span>`;
const CODE_SLOT = (n: number): string => `<div class="md-code-slot" data-code="${n}"></div>`;

interface CodeBlock {
  lang: string;
  ext: string;
  filename: string;
  code: string;
  html: string;
}

interface MathBlock {
  display: boolean;
  html: string;
}

function renderCode(info: string, code: string, index: number): CodeBlock {
  const { lang, ext, filename } = parseFence(info);
  const name = filename || `snippet-${index + 1}.${ext}`;
  const escaped = escapeHtml(code);
  return {
    lang,
    ext,
    filename: name,
    code,
    html: `<div class="md-code" data-lang="${escapeHtml(lang)}" data-filename="${escapeHtml(name)}"><div class="md-code__head"><span class="md-code__lang">${escapeHtml(lang)}</span><span class="md-code__name">${escapeHtml(name)}</span><span class="md-code__actions"><button type="button" class="md-code__btn" data-code-copy>复制</button><button type="button" class="md-code__btn" data-code-download>下载</button></span></div><pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre></div>`,
  };
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode: display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: "html",
    });
  } catch {
    return `<code class="md-math-fallback">${escapeHtml(tex)}</code>`;
  }
}

export interface RenderMarkdownOptions {
  /** 流式过程中允许容错（未闭合代码块按普通文本处理） */
  streaming?: boolean;
}

/** Markdown → 安全 HTML。 */
export function renderMarkdown(input: string, options: RenderMarkdownOptions = {}): string {
  if (!input.trim()) return "";
  let text = input;

  // 1) 代码块先抽出来，避免公式/HTML 被错误处理
  const codes: CodeBlock[] = [];
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (whole, info: string, body: string) => {
    const index = codes.length;
    codes.push(renderCode(info, body.replace(/\n$/, ""), index));
    return `\n${CODE_SLOT(index)}\n`;
  });
  // 流式中未闭合的围栏：保留原文（marked 会当普通段落），不吞内容
  if (options.streaming && /```/.test(text)) {
    // 未闭合围栏不再特殊处理
  }

  // 2) 公式 → token（先块级，再行内）
  const maths: MathBlock[] = [];
  text = text.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (whole, a?: string, b?: string) => {
    const tex = a ?? b ?? "";
    const index = maths.length;
    maths.push({ display: true, html: renderMath(tex, true) });
    return MATH_SLOT(index);
  });
  text = text.replace(/(?<!\\)\$(?!\$)([^\n$]{1,400}?)(?<!\\)\$|\\\((.{1,400}?)\\\)/g, (whole, a?: string, b?: string) => {
    const tex = a ?? b ?? "";
    if (!/[\\^_=+\-*/<>√∫∑∏∂∇≈≠≤≥∞πθα-ωΑ-Ω]/.test(tex)) return whole;
    if (/^\s*[\d.,]+\s*$/.test(tex)) return whole;
    const index = maths.length;
    maths.push({ display: false, html: renderMath(tex, false) });
    return MATH_SLOT(index);
  });

  // 3) 渲染 Markdown（默认渲染器，随后用 DOM 补链接/媒体语义，避免自定义 renderer 的兼容问题）
  let html: string;
  try {
    html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  } catch (error) {
    console.warn("[markdown] marked 渲染失败，回退为纯文本", error);
    html = `<p>${escapeHtml(text)}</p>`;
  }

  // 4) 放回代码块与公式（HTML slot → 实际内容）
  html = html.replace(/<div class="md-code-slot" data-code="(\d+)"><\/div>/g, (_m, n: string) => codes[Number(n)]?.html ?? "");
  html = html.replace(/<span class="md-math-slot" data-math="(\d+)"><\/span>/g, (_m, n: string) => maths[Number(n)]?.html ?? "");

  // 5) 链接 / 图片 / 视频规范化（DOMParser 在浏览器里可用；SSR 不使用此模块）
  try {
    const doc = new DOMParser().parseFromString(`<div id="sw-root">${html}</div>`, "text/html");
    const root = doc.getElementById("sw-root");
    if (root) {
      // 裸 URL（模型常直接写 https://...mp4）→ 自动识别成媒体/文件链接
      const urlPattern = /https?:\/\/[^\s<>"']+\.(?:mp4|webm|mov|m4v|ogv|mp3|wav|m4a|aac|flac|pdf|docx|xlsx|pptx|zip|csv|md|txt|json|tex)(?=[\s，。、）)]|$)/gi;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const parentTag = node.parentElement?.tagName.toLowerCase();
        if (parentTag === "a" || parentTag === "code" || parentTag === "pre") continue;
        if (urlPattern.test(node.data)) textNodes.push(node);
        urlPattern.lastIndex = 0;
      }
      for (const node of textNodes) {
        const parts = node.data.split(urlPattern);
        const matches = node.data.match(urlPattern);
        if (!matches || matches.length === 0) continue;
        const frag = doc.createDocumentFragment();
        let rest = node.data;
        for (const url of matches) {
          const idx = rest.indexOf(url);
          if (idx < 0) continue;
          if (idx > 0) frag.append(doc.createTextNode(rest.slice(0, idx)));
          const anchor = doc.createElement("a");
          anchor.href = url;
          anchor.textContent = url;
          frag.append(anchor);
          rest = rest.slice(idx + url.length);
        }
        if (rest) frag.append(doc.createTextNode(rest));
        node.replaceWith(frag);
      }

      for (const anchor of Array.from(root.querySelectorAll("a"))) {
        const href = anchor.getAttribute("href") ?? "";
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
        const ext = extOfUrl(href);
        if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
          const media = doc.createElement("span");
          media.className = "md-media";
          const player = doc.createElement(VIDEO_EXT.has(ext) ? "video" : "audio");
          player.className = VIDEO_EXT.has(ext) ? "md-video" : "md-audio";
          player.setAttribute("controls", "");
          player.setAttribute("preload", "metadata");
          player.setAttribute("src", href);
          anchor.classList.add("md-file-link");
          anchor.setAttribute("data-ext", ext);
          const parent = anchor.parentNode;
          if (!parent) continue;
          parent.insertBefore(media, anchor);
          media.append(player, anchor);
        } else if (FILE_EXT.has(ext)) {
          anchor.classList.add("md-file-link");
          anchor.setAttribute("data-ext", ext);
        }
      }
      for (const img of Array.from(root.querySelectorAll("img"))) {
        const src = img.getAttribute("src") ?? "";
        img.setAttribute("loading", "lazy");
        const ext = extOfUrl(src);
        if (VIDEO_EXT.has(ext)) {
          const video = doc.createElement("video");
          video.className = "md-video";
          video.setAttribute("controls", "");
          video.setAttribute("preload", "metadata");
          video.setAttribute("src", src);
          img.replaceWith(video);
        } else if (AUDIO_EXT.has(ext)) {
          const audio = doc.createElement("audio");
          audio.className = "md-audio";
          audio.setAttribute("controls", "");
          audio.setAttribute("src", src);
          img.replaceWith(audio);
        } else {
          const figure = doc.createElement("figure");
          figure.className = "md-figure";
          const parent = img.parentNode;
          if (parent) {
            parent.insertBefore(figure, img);
            const caption = doc.createElement("figcaption");
            caption.textContent = img.getAttribute("alt") ?? "";
            figure.append(img, caption);
          }
        }
      }
      html = root.innerHTML;
    }
  } catch {
    /* DOMParser 不可用时保持原 HTML */
  }

  // 去掉只包着代码块的 <p>，避免非法嵌套
  html = html.replace(/<p>\s*(<div class="md-code"[\s\S]*?<\/div>)\s*<\/p>/g, "$1");

  // 6) 安全净化（KaTeX 的 MathML + span 保留）
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    ADD_TAGS: ["video", "audio", "figure", "figcaption", "math", "semantics", "mrow", "mi", "mo", "mn", "msup", "msub", "mfrac", "msqrt", "mtext", "mspace", "mover", "munder", "mtable", "mtr", "mtd", "menclose", "mpadded", "mphantom", "mstyle", "merror"],
    ADD_ATTR: ["target", "rel", "controls", "preload", "poster", "data-code-copy", "data-code-download", "data-filename", "data-lang", "data-ext", "loading"],
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
  return clean;
}

/** 从渲染结果里找代码块的纯文本（供复制/下载）。 */
export function codeTextFromBlock(block: Element): string {
  return block.querySelector("code")?.textContent ?? "";
}
