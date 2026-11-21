/** 插件动作执行器：把 DSH 插件能力落成 Super Work 里可运行的动作。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { adapterForCall, describeImageWithWorkbuddy } from "@super-work/providers";
import type { Credential } from "@super-work/core";
import type {
  PluginAction,
  PluginActionResponse,
  PluginInfo,
} from "@super-work/core";
import type { Paths } from "./config.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";
import type { UploadStore } from "./v3.js";

export interface PluginActionDeps {
  paths: Paths;
  uploads: UploadStore;
  log: Logger;
}

function run(command: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 8_000) });
    };
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      stderr += error.message;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(-2);
    }, timeoutMs);
    timer.unref?.();
  });
}

function loadWorkbuddyCredential(): Credential {
  const base = path.join(os.homedir(), ".dsh/workbuddy-vault");
  let file: string | undefined;
  for (const region of fs.readdirSync(base)) {
    const dir = path.join(base, region);
    try {
      const found = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
      if (found) file = path.join(dir, found);
    } catch {
      /* ignore */
    }
    if (file) break;
  }
  if (!file) throw new Error("没有找到 WorkBuddy 登录态，请先在设置 → 中转站导入 WorkBuddy");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    auth?: { accessToken?: string; domain?: string };
    account?: { uid?: string };
  };
  const access = raw.auth?.accessToken;
  if (!access) throw new Error("WorkBuddy 登录态缺少 accessToken");
  return {
    provider: "workbuddy",
    mode: "token",
    baseUrl: "https://copilot.tencent.com",
    pasted: {
      kind: "bearer",
      access,
      extraHeaders: {
        "X-User-Id": raw.account?.uid ?? "",
        "X-Domain": raw.auth?.domain ?? "www.codebuddy.cn",
      },
    },
  };
}

function parseArxiv(xml: string): Array<{ title: string; authors: string; summary: string; url: string; published: string }> {
  const entries = xml.split("<entry>").slice(1);
  return entries.map((entry) => {
    const grab = (tag: string): string => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return m ? m[1]!.replace(/\\s+/g, " ").trim() : "";
    };
    const authors = Array.from(entry.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1]!.trim()).join("、");
    return {
      title: grab("title"),
      authors,
      summary: grab("summary"),
      published: grab("published").slice(0, 10),
      url: /<id>([^<]+)<\/id>/.exec(entry)?.[1]?.trim() ?? "",
    };
  });
}

function resolveImageInput(input: string, deps: PluginActionDeps): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("data:")) return trimmed;
  if (trimmed.startsWith("up_")) {
    const upload = deps.uploads.get(trimmed);
    if (!upload?.path) throw new Error(`找不到上传附件 ${trimmed}`);
    const full = path.join(deps.paths.home, upload.path);
    const bytes = fs.readFileSync(full);
    return `data:${upload.mime || "image/png"};base64,${bytes.toString("base64")}`;
  }
  return trimmed;
}

let depsHome: () => string = () => os.homedir();
let uploadsRef: UploadStore | undefined;

async function downloadTo(url: string, file: string): Promise<void> {
  if (url.startsWith("data:")) {
    const m = /^data:[^;]+;base64,(.*)$/.exec(url);
    if (!m) throw new Error("无法解析 data URL");
    fs.writeFileSync(file, Buffer.from(m[1]!, "base64"));
    return;
  }
  if (url.startsWith("/api/artifacts/")) {
    const rest = url.slice("/api/artifacts/".length);
    const [runId, ...parts] = rest.split("/");
    if (!runId || parts.length === 0) throw new Error("无法解析产物地址");
    const full = path.join(depsHome(), "artifacts", runId, parts.join("/"));
    fs.copyFileSync(full, file);
    return;
  }
  if (url.startsWith("/api/uploads/")) {
    const id = url.slice("/api/uploads/".length).split("/")[0];
    if (!id) throw new Error("无法解析上传地址");
    const record = uploadsRef?.get(id);
    if (record?.path) {
      fs.copyFileSync(path.join(depsHome(), record.path), file);
      return;
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载资源失败（HTTP ${res.status}）`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function savePluginOutput(home: string, name: string, content: string | Buffer): string {
  const dir = path.join(home, "plugin-output");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  return `/api/plugins/files/${encodeURIComponent(name)}`;
}

export async function executePluginAction(
  plugin: PluginInfo,
  action: PluginAction,
  inputs: Record<string, string>,
  deps: PluginActionDeps,
): Promise<PluginActionResponse> {
  depsHome = () => deps.paths.home;
  uploadsRef = deps.uploads;
  const started = Date.now();
  const text = (name: string): string => (inputs[name] ?? "").trim();
  try {
    switch (action.handler) {
      case "arxiv.search": {
        const query = text("query");
        if (!query) throw new Error("请填写检索词");
        const max = Math.max(1, Math.min(20, Number(text("max")) || 5));
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${max}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`arXiv 返回 HTTP ${res.status}`);
        const items = parseArxiv(await res.text());
        const markdown = items
          .map((item, index) => `${index + 1}. **${item.title}**\n${item.authors}\n${item.published} · ${item.url}\n${item.summary.slice(0, 240)}…`)
          .join("\n\n");
        return { ok: true, message: `找到 ${items.length} 篇论文`, text: markdown || "没有结果", data: items, latencyMs: Date.now() - started };
      }
      case "github.read": {
        const owner = text("owner");
        const repo = text("repo");
        if (!owner || !repo) throw new Error("请填写 owner 和 repo");
        const token = text("token");
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        const filePath = text("path");
        if (filePath) {
          const raw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filePath}`, {
            signal: AbortSignal.timeout(20_000),
          });
          if (!raw.ok) throw new Error(`读取文件失败（HTTP ${raw.status}）`);
          const content = await raw.text();
          return {
            ok: true,
            message: `${owner}/${repo}/${filePath} · ${content.length} 字符`,
            text: "```\n" + content.slice(0, 8000) + "\n```",
            latencyMs: Date.now() - started,
          };
        }
        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          const body = await res.text();
          const hint = res.status === 403 ? "（未登录的 GitHub API 限额已用尽；填 token 可提高限额）" : "";
          throw new Error(`GitHub API HTTP ${res.status}${hint}：${body.slice(0, 160)}`);
        }
        const data = (await res.json()) as { full_name?: string; description?: string; stars?: number; stargazers_count?: number; language?: string; html_url?: string };
        return {
          ok: true,
          message: `${data.full_name ?? `${owner}/${repo}`} · ⭐ ${data.stargazers_count ?? data.stars ?? 0}`,
          text: [
            `**${data.full_name ?? `${owner}/${repo}`}**`,
            data.description ?? "",
            `语言：${data.language ?? "—"}`,
            data.html_url ?? `https://github.com/${owner}/${repo}`,
          ].join("\n"),
          data,
          latencyMs: Date.now() - started,
        };
      }
      case "vision.ocr": {
        const input = text("imageUrl");
        if (!input) throw new Error("请填写图片地址或上传 ID");
        const dataUrl = resolveImageInput(input, deps);
        const cred = loadWorkbuddyCredential();
        const prompt = text("prompt") || "请提取图片中的全部文字，并简要描述画面。";
        let result = "";
        let lastError: unknown;
        for (const model of ["kimi-k3.1-pro", "glm-5.3", "hy4flash-free"]) {
          try {
            result = await describeImageWithWorkbuddy(cred, dataUrl, prompt, { model, maxTokens: 1200 });
            if (result.trim()) break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!result.trim()) throw lastError instanceof Error ? lastError : new Error("图片识别没有返回文本");
        return { ok: true, message: "识别完成", text: result, latencyMs: Date.now() - started };
      }
      case "image.generate": {
        const prompt = text("prompt");
        if (!prompt) throw new Error("请填写画面描述");
        const cred = loadWorkbuddyCredential();
        const adapter = adapterForCall("workbuddy", cred);
        if (!adapter.generateImage) throw new Error("当前 WorkBuddy 适配器不支持生图");
        const size = text("size") || "1024x1024";
        const result = await adapter.generateImage({ provider: "workbuddy", model: "hunyuan-image-alpha", prompt, size } as never, cred);
        const first = result.images[0];
        if (!first) throw new Error("生图没有返回图片");
        let imageUrl = first.b64 ? `data:image/png;base64,${first.b64}` : first.url;
        if (!imageUrl) throw new Error("生图结果缺少图片地址");
        return { ok: true, message: `已生成图片${result.credit ? `（${result.credit} 积分）` : ""}`, imageUrl, latencyMs: Date.now() - started };
      }
      case "plot.csv": {
        const csv = text("csv");
        if (!csv) throw new Error("请填写 CSV");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-plot-"));
        const csvFile = path.join(dir, "data.csv");
        const out = path.join(dir, "plot.png");
        fs.writeFileSync(csvFile, csv);
        const script = `import csv, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
xs=[]; ys=[]
with open(sys.argv[1], newline="") as f:
    for row in csv.DictReader(f):
        try:
            xs.append(float(row.get("x","")))
            ys.append(float(row.get("y","")))
        except Exception:
            pass
fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=160)
ax.plot(xs, ys, marker="o", linewidth=1.6, color="#5b8def")
ax.set_title(sys.argv[2] or "sci-plot")
ax.set_xlabel("x"); ax.set_ylabel("y"); ax.grid(alpha=.25)
fig.tight_layout(); fig.savefig(sys.argv[3])
print(f"plotted {len(xs)} points")`;
        const py = path.join(dir, "plot.py");
        fs.writeFileSync(py, script);
        const runResult = await run("python3", [py, csvFile, text("title") || "sci-plot", out], 60_000);
        if (runResult.code !== 0) throw new Error(`matplotlib 绘图失败：${runResult.stderr.slice(0, 300)}`);
        const bytes = fs.readFileSync(out);
        return {
          ok: true,
          message: runResult.stdout.trim() || "绘图完成",
          imageUrl: `data:image/png;base64,${bytes.toString("base64")}`,
          latencyMs: Date.now() - started,
        };
      }
      case "ffmpeg.probe": {
        const version = await run("ffmpeg", ["-version"], 10_000);
        const filters = await run("ffmpeg", ["-hide_banner", "-filters"], 10_000);
        const hasZoom = /zoompan/.test(filters.stdout);
        return {
          ok: version.code === 0,
          message: version.code === 0 ? `ffmpeg 可用${hasZoom ? "，支持 zoompan" : ""}` : "ffmpeg 不可用",
          text: version.stdout.split("\n").slice(0, 3).join("\n"),
          latencyMs: Date.now() - started,
        };
      }
      case "wolfram.eval": {
        const expr = text("expr");
        if (!expr) throw new Error("请填写表达式");
        const ws = await run("wolframscript", ["-code", expr], 30_000);
        if (ws.code === 0 && ws.stdout.trim()) {
          return { ok: true, message: "Wolfram 计算完成", text: ws.stdout.trim(), latencyMs: Date.now() - started };
        }
        const py = `import sys
from sympy import *
x, y, z, t, n, k = symbols("x y z t n k")
expr = sys.argv[1]
try:
    print(eval(expr, globals()))
except Exception as exc:
    print("ERROR:", exc)`;
        const result = await run("python3", ["-c", py, expr], 30_000);
        const out = result.stdout.trim();
        if (out.startsWith("ERROR:")) throw new Error(`SymPy：${out.slice(6).trim()}`);
        return {
          ok: true,
          message: "SymPy 计算完成（本机未安装 wolframscript）",
          text: out,
          latencyMs: Date.now() - started,
        };
      }
      case "video.slideshow": {
        const lines = text("images").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        if (lines.length === 0) throw new Error("请至少提供一张图片地址");
        const seconds = Math.max(1, Math.min(10, Number(text("seconds")) || 3));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-video-"));
        const listFile = path.join(dir, "list.txt");
        const listLines: string[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          const file = path.join(dir, `img-${i}.png`);
          await downloadTo(lines[i]!, file);
          listLines.push(`file '${file}'`, `duration ${seconds}`);
        }
        listLines.push(`file '${path.join(dir, `img-${lines.length - 1}.png`)}'`);
        fs.writeFileSync(listFile, listLines.join("\n"));
        const outFile = path.join(dir, "slideshow.mp4");
        const result = await run(
          "ffmpeg",
          ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p", "-r", "30", outFile],
          120_000,
        );
        if (result.code !== 0) throw new Error(`视频合成失败：${result.stderr.slice(0, 300)}`);
        const outDir = path.join(deps.paths.home, "plugin-output");
        fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
        const id = crypto.randomBytes(6).toString("hex");
        const name = `slideshow-${id}.mp4`;
        fs.copyFileSync(outFile, path.join(outDir, name));
        return {
          ok: true,
          message: `已生成视频（${lines.length} 张图 · 每张 ${seconds}s）`,
          fileUrl: `/api/plugins/files/${name}`,
          latencyMs: Date.now() - started,
        };
      }
      case "motion.html": {
        const title = text("title") || "Super Work";
        const subtitle = text("subtitle") || "";
        const accent = /^#[0-9a-f]{6}$/i.test(text("accent")) ? text("accent") : "#82c5ab";
        const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>
html,body{height:100%;margin:0;background:#050a0c;color:#eef3f0;font-family:-apple-system,"PingFang SC",sans-serif;overflow:hidden}
.stage{height:100%;display:grid;place-items:center;position:relative;background:radial-gradient(60% 50% at 50% 40%, ${accent}22, transparent 70%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(${accent}12 1px,transparent 1px),linear-gradient(90deg,${accent}12 1px,transparent 1px);background-size:32px 32px;mask-image:radial-gradient(60% 60% at 50% 50%,#000,transparent)}
h1{font-size:clamp(32px,7vw,96px);letter-spacing:-.03em;margin:0;background:linear-gradient(90deg,#fff,${accent});-webkit-background-clip:text;color:transparent;animation:in 1.2s cubic-bezier(.2,.8,.2,1) both}
p{color:#a9b8b3;margin:14px 0 0;font-size:clamp(12px,1.4vw,18px);animation:in 1.2s .25s cubic-bezier(.2,.8,.2,1) both}
.ring{position:absolute;width:min(60vh,60vw);aspect-ratio:1;border:1px solid ${accent}55;border-radius:50%;animation:spin 18s linear infinite}
.ring::after{content:"";position:absolute;inset:18%;border:1px dashed ${accent}33;border-radius:50%}
@keyframes in{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="stage"><div class="grid"></div><div class="ring"></div><div style="text-align:center;z-index:1"><h1>${title}</h1><p>${subtitle}</p></div></div></body></html>`;
        const name = `motion-${crypto.randomBytes(5).toString("hex")}.html`;
        const fileUrl = savePluginOutput(deps.paths.home, name, html);
        return { ok: true, message: "动效 HTML 已生成（可打开/下载）", fileUrl, text: "用浏览器打开可看到入场动画；下载后可嵌入或转成视频。", latencyMs: Date.now() - started };
      }
      case "webhook.notify": {
        const url = text("url");
        const message = text("message");
        if (!url || !/^https?:\/\//i.test(url)) throw new Error("请填写 http(s) Webhook URL");
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: message || "Super Work 通知", source: "super-work", at: new Date().toISOString() }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`Webhook 返回 HTTP ${res.status}`);
        return { ok: true, message: `Webhook 已发送（HTTP ${res.status}）`, text: message, latencyMs: Date.now() - started };
      }
      case "report.markdown": {
        const date = text("date") || new Date().toISOString().slice(0, 10);
        const items = text("highlights").split(/\n+/).map((line) => line.trim()).filter(Boolean);
        const md = [`# 日报 · ${date}`, "", "## 今日要点", ...items.map((item) => `- ${item}`), "", "## 明日计划", "- ", ""].join("\n");
        const name = `report-${date}.md`;
        const fileUrl = savePluginOutput(deps.paths.home, name, md);
        return { ok: true, message: "日报 Markdown 已生成", fileUrl, text: md, latencyMs: Date.now() - started };
      }
      case "native.appearance": {
        const theme = text("theme") || "glass";
        const font = text("font") || "serif";
        return {
          ok: true,
          message: `已切换外观：${theme}${text("font") ? ` / ${font}` : ""}`,
          native: "appearance",
          data: { theme, font, layout: text("layout") },
          latencyMs: Date.now() - started,
        };
      }
      case "native.pet": {
        return { ok: true, message: text("on") === "off" ? "Jarvis 悬浮球已关闭" : "Jarvis 悬浮球已开启", native: "pet", data: { on: text("on") !== "off" }, latencyMs: Date.now() - started };
      }
      case "native.launch": {
        return { ok: true, message: "入场动画已重播", native: "launch", latencyMs: Date.now() - started };
      }
      case "native.settings": {
        return { ok: true, message: "工具设置已并入 Super Work 设置页", native: "settings", latencyMs: Date.now() - started };
      }
      case "native.guide": {
        return {
          ok: true,
          message: action.label,
          text: `${action.description ?? plugin.adaptation ?? plugin.description}\n\n该能力在 Super Work 中以原生方式适配；如需 DSH 原插件宿主行为，可在 DSH 中打开对应插件。`,
          latencyMs: Date.now() - started,
        };
      }
      default:
        if (action.kind === "link" && action.url) {
          return { ok: true, message: "已生成跳转地址", text: action.url, data: { url: action.url }, latencyMs: Date.now() - started };
        }
        throw new Error(`未实现的插件动作：${action.handler ?? action.id}`);
    }
  } catch (error) {
    deps.log.warn("插件动作失败", { plugin: plugin.id, action: action.id, message: safeErrorMessage(error) });
    return { ok: false, message: safeErrorMessage(error), latencyMs: Date.now() - started };
  }
}
