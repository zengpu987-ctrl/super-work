/** 模型输出的文件产物：扩展名 → mime、文件名清洗、可转换格式。 */

export const OUTPUT_MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  ini: "text/plain",
  log: "text/plain",
  py: "text/x-python",
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  scss: "text/x-scss",
  sql: "application/sql",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  java: "text/x-java-source",
  go: "text/x-go",
  rs: "text/x-rust",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  rb: "text/x-ruby",
  php: "text/x-php",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  r: "text/x-r",
  lua: "text/x-lua",
  vue: "text/plain",
  svelte: "text/plain",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  zip: "application/zip",
  ics: "text/calendar",
  rtf: "application/rtf",
  tex: "text/x-tex",
  bib: "text/plain",
  env: "text/plain",
};

/** 服务端会从纯文本 / Markdown / CSV 自动转换的格式。 */
export const CONVERTIBLE_OUTPUT_EXTS = ["docx", "xlsx", "pptx", "pdf"] as const;

const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 取小写扩展名（不含点）；没有扩展名返回空串。 */
export function outputExt(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : "";
}

/** 按扩展名给 mime；未知扩展名按纯文本处理。 */
export function outputMime(filename: string): string {
  return OUTPUT_MIME_BY_EXT[outputExt(filename)] ?? "text/plain";
}

/**
 * 清洗模型给的文件名：只保留文件名（去目录）、去掉非法字符、限制长度。
 * 中文与空格允许保留；前端下载与静态路由都按原名处理。
 */
export function sanitizeOutputName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = base.replace(UNSAFE_NAME, "_").replace(/\s+/g, " ").trim();
  const trimmed = cleaned.slice(0, 120).replace(/^\.+/, "");
  return trimmed || "output.txt";
}

/** 为没有扩展名的文件名补 .txt（模型偶尔会漏）。 */
export function ensureOutputName(name: string): string {
  const clean = sanitizeOutputName(name);
  return outputExt(clean) ? clean : `${clean}.txt`;
}
