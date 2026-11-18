/**
 * 模型文件产物落盘：文本类直接写；docx / xlsx / pptx / pdf 从正文转换。
 * 转换全部在本机完成（docx/xlsx/pptx 用纯 JS 库，pdf 用 macOS cupsfilter），不依赖外部服务。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureOutputName, outputExt, outputMime } from "@super-work/core";

export interface MaterializedFile {
  filename: string;
  bytes: Buffer;
  mime: string;
  converted: boolean;
}

export async function materializeOutputFile(title: string, text: string): Promise<MaterializedFile> {
  const filename = ensureOutputName(title);
  const ext = outputExt(filename);
  const mime = outputMime(filename);
  switch (ext) {
    case "docx":
      return { filename, bytes: await buildDocx(text), mime, converted: true };
    case "xlsx":
      return { filename, bytes: await buildXlsx(text), mime, converted: true };
    case "pptx":
      return { filename, bytes: await buildPptx(text), mime, converted: true };
    case "pdf":
      return { filename, bytes: buildPdf(text), mime, converted: true };
    default:
      return { filename, bytes: Buffer.from(text, "utf8"), mime, converted: false };
  }
}

/* ------------------------------- markdown ------------------------------- */

function stripInline(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "");
}

function stripMarkdown(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw.trim())) {
      inCode = !inCode;
      continue;
    }
    out.push(inCode ? raw : stripInline(raw));
  }
  return out.join("\n");
}

/* --------------------------------- docx --------------------------------- */

async function buildDocx(md: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const children: InstanceType<typeof Paragraph>[] = [];
  let inCode = false;
  let code: string[] = [];
  const flushCode = (): void => {
    if (code.length === 0) return;
    children.push(
      new Paragraph({
        children: [new TextRun({ text: code.join("\n"), font: "Menlo", size: 18 })],
        spacing: { after: 120 },
      }),
    );
    code = [];
  };

  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      children.push(
        new Paragraph({
          text: heading[2]!,
          heading:
            level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        }),
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      children.push(new Paragraph({ text: bullet[1]!, bullet: { level: 0 } }));
      continue;
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
    if (ordered) {
      children.push(new Paragraph({ text: ordered[2]!, bullet: { level: 0 } }));
      continue;
    }
    if (!raw.trim()) {
      children.push(new Paragraph(""));
      continue;
    }
    children.push(new Paragraph({ text: raw }));
  }
  flushCode();
  if (children.length === 0) children.push(new Paragraph(""));
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

/* --------------------------------- xlsx --------------------------------- */

function splitDelimited(line: string, delim: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delim && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseTable(text: string): string[][] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(data) ? data : [data];
      if (list.length > 0 && typeof list[0] === "object" && list[0] !== null) {
        const keys = [...new Set(list.flatMap((item) => Object.keys(item as Record<string, unknown>)))];
        return [
          keys,
          ...list.map((item) => keys.map((key) => String((item as Record<string, unknown>)[key] ?? ""))),
        ];
      }
    } catch {
      /* 不是 JSON，按分隔文本处理 */
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const delim = lines[0]?.includes("\t") ? "\t" : ",";
  return lines.map((line) => splitDelimited(line, delim));
}

async function buildXlsx(text: string): Promise<Buffer> {
  const mod = (await import("xlsx")) as unknown as {
    default?: unknown;
    utils: { aoa_to_sheet: (rows: string[][]) => unknown; book_new: () => unknown; book_append_sheet: (wb: unknown, ws: unknown, name: string) => void };
    write: (wb: unknown, opts: { type: "buffer"; bookType: "xlsx" }) => unknown;
  };
  const XLSX = (mod.default ?? mod) as typeof mod;
  const rows = parseTable(text);
  const sheet = XLSX.utils.aoa_to_sheet(rows.length > 0 ? rows : [[""]]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
}

/* --------------------------------- pptx --------------------------------- */

function splitSlides(md: string): Array<{ title: string; bullets: string[] }> {
  const slides: Array<{ title: string; bullets: string[] }> = [];
  let current: { title: string; bullets: string[] } = { title: "", bullets: [] };
  const push = (): void => {
    if (current.title || current.bullets.length > 0) slides.push(current);
    current = { title: "", bullets: [] };
  };
  for (const raw of md.split(/\r?\n/)) {
    if (/^#{1,2}\s+/.test(raw) || /^\s*---+\s*$/.test(raw)) {
      push();
      current.title = raw.replace(/^#{1,2}\s+/, "").replace(/^\s*---+\s*$/, "").trim() || "Slide";
      continue;
    }
    if (!raw.trim()) continue;
    if (/^```/.test(raw.trim())) continue;
    current.bullets.push(stripInline(raw));
  }
  push();
  if (slides.length === 0) slides.push({ title: "输出", bullets: [stripMarkdown(md).slice(0, 2000)] });
  return slides.slice(0, 40).map((slide) => ({
    title: slide.title || "Slide",
    bullets: slide.bullets.filter(Boolean).slice(0, 8),
  }));
}

async function buildPptx(md: string): Promise<Buffer> {
  const mod = (await import("pptxgenjs")) as unknown as { default?: unknown };
  const Ctor = (mod.default ?? mod) as new () => {
    layout: string;
    addSlide: () => {
      addText: (
        text: unknown,
        options: Record<string, unknown>,
      ) => void;
    };
    write: (opts: { outputType: "nodebuffer" }) => Promise<unknown>;
  };
  const pptx = new Ctor();
  pptx.layout = "LAYOUT_16x9";
  for (const slide of splitSlides(md)) {
    const page = pptx.addSlide();
    page.addText(slide.title, { x: 0.6, y: 0.35, w: 8.8, h: 0.9, fontSize: 26, bold: true, color: "1F2937" });
    if (slide.bullets.length > 0) {
      page.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true, fontSize: 15, color: "374151" } })),
        { x: 0.8, y: 1.45, w: 8.4, h: 4.7, valign: "top" },
      );
    }
  }
  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(buffer as Uint8Array);
}

/* ---------------------------------- pdf --------------------------------- */

function buildPdf(md: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-pdf-"));
  const file = path.join(dir, "doc.txt");
  fs.writeFileSync(file, stripMarkdown(md), "utf8");
  try {
    const bin = ["/usr/sbin/cupsfilter", "/usr/bin/cupsfilter"].find((candidate) => fs.existsSync(candidate));
    if (!bin) {
      throw new Error("当前系统没有 cupsfilter，无法生成 PDF；可改用 .docx / .html 输出");
    }
    const out = execFileSync(bin, ["-i", "text/plain", "-m", "application/pdf", file], {
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("PDF 转换没有返回有效文件");
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
