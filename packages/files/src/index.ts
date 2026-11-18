/**
 * @super-work/files —— 附件解析（v0.0.3）。
 * 支持：纯文本/代码、PDF、DOCX、DOC（macOS textutil）、图片缩略图（sips）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AttachmentKind } from "@super-work/core";

const execFileAsync = promisify(execFile);
const MAX_TEXT_CHARS = 200_000;
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".sh", ".bash", ".zsh", ".sql",
  ".html", ".htm", ".css", ".scss", ".less", ".json", ".yaml", ".yml", ".toml", ".xml",
  ".ini", ".env",
]);
const TEXT_EXT = new Set([".txt", ".md", ".mdx", ".csv", ".log"]);

export interface ExtractInput {
  name: string;
  mime: string;
  data: Buffer;
}

export interface ExtractResult {
  kind: AttachmentKind;
  text: string;
  chars: number;
  mime: string;
  error?: string;
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

export function detectKind(name: string, mime: string): AttachmentKind {
  const ext = extOf(name);
  if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".tiff"].includes(ext)) {
    return "image";
  }
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (ext === ".docx" || mime.includes("wordprocessingml")) return "docx";
  if (ext === ".doc" || mime === "application/msword") return "doc";
  if (TEXT_EXT.has(ext)) return "text";
  if (CODE_EXT.has(ext)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

function truncate(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  return normalized.length > MAX_TEXT_CHARS ? normalized.slice(0, MAX_TEXT_CHARS) : normalized;
}

async function textutilConvert(file: string): Promise<string> {
  const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", file], {
    timeout: 20_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function extractFile(input: ExtractInput): Promise<ExtractResult> {
  const kind = detectKind(input.name, input.mime);
  const mime = input.mime || "application/octet-stream";
  try {
    if (kind === "image") {
      return { kind, text: "", chars: 0, mime };
    }
    if (kind === "pdf") {
      const mod = await import("pdf-parse");
      const pdfParse = (mod as unknown as { default?: (b: Uint8Array) => Promise<{ text?: string }> }).default
        ?? (mod as unknown as (b: Uint8Array) => Promise<{ text?: string }>);
      // pdf.js 会直接使用 Buffer.buffer（忽略 byteOffset）；必须传 Uint8Array 拷贝，否则会 random 报 bad XRef entry。
      const parsed = await pdfParse(new Uint8Array(input.data));
      const text = truncate(parsed.text ?? "");
      return { kind, text, chars: text.length, mime: "application/pdf" };
    }
    if (kind === "docx") {
      const mod = await import("mammoth");
      const mammoth = (mod as unknown as { default?: { extractRawText: (o: { buffer: Buffer }) => Promise<{ value?: string }> } })
        .default ?? (mod as unknown as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value?: string }> });
      const parsed = await mammoth.extractRawText({ buffer: input.data });
      const text = truncate(parsed.value ?? "");
      return {
        kind,
        text,
        chars: text.length,
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
    }
    if (kind === "doc") {
      const tmp = path.join(os.tmpdir(), `sw-doc-${randomUUID()}${path.extname(input.name) || ".doc"}`);
      fs.writeFileSync(tmp, input.data);
      try {
        const text = truncate(await textutilConvert(tmp));
        return { kind, text, chars: text.length, mime: "application/msword" };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    if (kind === "code" || kind === "text" || kind === "other") {
      const decoded = input.data.toString("utf8");
      const looksBinary = /[\u0000-\u0008\u000e-\u001f]/.test(decoded.slice(0, 2000));
      if (looksBinary && kind === "other") {
        return { kind: "other", text: "", chars: 0, mime, error: "无法识别的二进制文件" };
      }
      const text = truncate(decoded);
      return { kind: kind === "other" ? "text" : kind, text, chars: text.length, mime };
    }
    return { kind, text: "", chars: 0, mime, error: "暂不支持该文件类型" };
  } catch (error) {
    return {
      kind,
      text: "",
      chars: 0,
      mime,
      error: `解析失败：${(error as Error).message}`,
    };
  }
}

export async function makeImageThumb(
  data: Buffer,
  mime: string,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".jpg";
  const src = path.join(os.tmpdir(), `sw-img-${randomUUID()}${ext}`);
  const out = path.join(os.tmpdir(), `sw-thumb-${randomUUID()}.jpg`);
  fs.writeFileSync(src, data);
  try {
    await execFileAsync("sips", ["-Z", "512", "-s", "format", "jpeg", src, "--out", out], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const buf = fs.readFileSync(out);
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out], {
      timeout: 10_000,
    });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0);
    return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, width, height };
  } finally {
    fs.rmSync(src, { force: true });
    fs.rmSync(out, { force: true });
  }
}

export const MAX_EXTRACT_CHARS = MAX_TEXT_CHARS;
