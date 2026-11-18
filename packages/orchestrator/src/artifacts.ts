/**
 * 模型文件输出的解析：
 * 约定模型用带文件名的代码块交付成品：
 *   ```file name="报告.docx" type="..."
 *   <正文>
 *   ```
 * 也接受 filename=/path=、`file:名字.ext`、语言标记后跟文件名等写法。
 * 解析后正文从回答里剔除，替换为「[已生成文件：xxx]」，由 server 落盘并转换格式。
 */
import { ensureOutputName, outputExt, outputMime } from "@super-work/core";

export interface ExtractedFile {
  title: string;
  mime: string;
  ext: string;
  content: string;
}

export interface ExtractResult {
  text: string;
  files: ExtractedFile[];
}

const FENCE = /^```(.*)$/;
const CLOSE = /^```\s*$/;

function parseFenceInfo(info: string): string | null {
  const raw = info.trim();
  if (!raw) return null;
  // name="x.ext" | filename='x.ext' | path=x.ext
  const attr = /(?:^|\s)(?:name|filename|path)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(raw);
  let name = attr?.[1] ?? attr?.[2] ?? attr?.[3];
  if (!name) {
    // "file report.md" / "file:report.md" / "docx 报告.docx"
    const rest = raw.replace(/^file\s*[:：]?\s*/i, "");
    const token = /(?:^|\s)([^\s"']+\.[A-Za-z0-9]{1,8})(?:\s|$)/.exec(rest);
    name = token?.[1];
  }
  if (!name) return null;
  const cleaned = ensureOutputName(name);
  return outputExt(cleaned) ? cleaned : null;
}

export function extractFileArtifacts(input: string): ExtractResult {
  if (!input.includes("```")) return { text: input, files: [] };
  const lines = input.split("\n");
  const output: string[] = [];
  const files: ExtractedFile[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (!fence) {
      output.push(line);
      index += 1;
      continue;
    }
    const info = fence[1] ?? "";
    const title = parseFenceInfo(info);
    if (!title) {
      // 普通代码块：原样保留（内部行不做文件解析）
      output.push(line);
      index += 1;
      while (index < lines.length && !CLOSE.test(lines[index]!)) {
        output.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        output.push(lines[index]!);
        index += 1;
      }
      continue;
    }

    // 文件块：收集到闭合围栏（模型偶尔漏写闭合，则吃到文末）
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !CLOSE.test(lines[index]!)) {
      body.push(lines[index]!);
      index += 1;
    }
    if (index < lines.length) index += 1;
    const content = body.join("\n");
    if (!content.trim()) continue;

    files.push({
      title,
      mime: outputMime(title),
      ext: outputExt(title),
      content,
    });
    output.push("");
    output.push(`[已生成文件：${title}]`);
    output.push("");
  }

  // 连续空行收敛
  const text = output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, files };
}
