/**
 * @super-work/plugins —— DSH 插件扫描与桥接（v0.0.3）。
 * 只读 DSH profile 的 package.json / node_modules manifest；桥接测试用 spawn 执行短命令。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginBridgeSpec, PluginInfo, PluginKind, PluginStatus, PluginTestResult } from "@super-work/core";

export const DEFAULT_DSH_PROFILE = path.join(os.homedir(), ".dsh/profiles/desktop");

interface Classification {
  kind: PluginKind;
  status: PluginStatus;
  capability?: string;
  bridge?: PluginBridgeSpec;
  note?: string;
}

function which(command: string): string | undefined {
  const r = spawnSync("/usr/bin/which", [command], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out ? out.split("\n")[0] : undefined;
}

function ffmpegBridge(): PluginBridgeSpec | undefined {
  const p = which("ffmpeg");
  return p ? { command: p, testArgs: ["-version"], note: "系统 ffmpeg" } : undefined;
}

function wolframBridge(): PluginBridgeSpec | undefined {
  const p = which("wolframscript");
  return p ? { command: p, testArgs: ["-version"], note: "本机 Wolfram Engine" } : undefined;
}

function pythonBridge(): PluginBridgeSpec | undefined {
  const p = which("python3");
  return p ? { command: p, testArgs: ["--version"], note: "本机 Python 3" } : undefined;
}

/** 已知 DSH 插件的能力映射；未列出的按 ui-only 处理。 */
export const PLUGIN_CLASSIFICATION: Record<string, Classification> = {
  "dsh-mnemon": { kind: "native", status: "migrated", capability: "记忆系统（空间/条目/召回）" },
  "dsh-hindsight-memory": { kind: "native", status: "migrated", capability: "记忆召回（FTS + 注入）" },
  "dsh-context": { kind: "native", status: "migrated", capability: "上下文洞察（每次调用组成）" },
  "dsh-tokenledger": { kind: "native", status: "migrated", capability: "计费（用量/成本/CSV/DSH 账本导入）" },
  "dsh-connect-workbuddy": { kind: "native", status: "migrated", capability: "WorkBuddy 中转站（账号/模型/生图）" },
  "dsh-kimi-subscription": { kind: "native", status: "migrated", capability: "Kimi 会员订阅通道" },
  "dsh-deepseek-web": { kind: "native", status: "migrated", capability: "DeepSeek 网页登录态复用" },
  "dsh-image-gen": { kind: "bridge", status: "pending", capability: "生图（Super Work 已用 WorkBuddy 图像模型替代）" },
  "dsh-media-gen": { kind: "bridge", status: "pending", capability: "视频/媒体生成（待接）" },
  "dsh-ffmpeg": {
    kind: "bridge",
    status: "bridge-ready",
    capability: "音视频剪辑/转码",
    bridge: ffmpegBridge(),
    note: "调用系统 ffmpeg",
  },
  "dsh-hyperframes": { kind: "bridge", status: "pending", capability: "HTML 动效视频渲染（需 Node 渲染管线）" },
  "dsh-remotion": { kind: "bridge", status: "pending", capability: "React 视频渲染（需 Node 渲染管线）" },
  "dsh-arxiv": { kind: "bridge", status: "pending", capability: "arXiv 检索", bridge: pythonBridge(), note: "Python 环境已就绪，论文检索 API 待接" },
  "dsh-wolfram": {
    kind: "bridge",
    status: "bridge-ready",
    capability: "Wolfram 计算（MCP）",
    bridge: wolframBridge(),
    note: "通过本机 wolframscript 探测",
  },
  "dsh-github-router": { kind: "bridge", status: "pending", capability: "GitHub 只读路由（可用 GitHub API 直连替代）" },
  "dsh-sci-plot": { kind: "bridge", status: "pending", capability: "科研绘图（需接 matplotlib/plot 服务）" },
  "dsh-vision-complete": { kind: "bridge", status: "pending", capability: "识图/OCR（可用 WorkBuddy 视觉模型接入）" },
  "dsh-superman-ocr": { kind: "bridge", status: "pending", capability: "OCR（可用 WorkBuddy 视觉模型接入）" },
  "dsh-superman": { kind: "native", status: "migrated", capability: "文件/文献归档（记忆库附件已覆盖）" },
  "dsh-find-plugin": { kind: "native", status: "migrated", capability: "插件中心（查看/测试/启停）" },
  "dsh-tools-settings": { kind: "ui-only", status: "pending", capability: "工具设置面板（已由设置页覆盖）" },
  "dsh-theme-market": { kind: "ui-only", status: "pending", capability: "主题市场（Super Work 自有主题）" },
  "dsh-better-sidebar": { kind: "ui-only", status: "pending", capability: "侧栏增强（DSH 专属 UI）" },
  "dsh-claude-style": { kind: "ui-only", status: "pending", capability: "Claude 风格皮肤（DSH 专属 UI）" },
  "dsh-wallpaper-bg": { kind: "ui-only", status: "pending", capability: "动态壁纸（DSH 专属 UI）" },
  "dsh-pet-indesktop": { kind: "ui-only", status: "pending", capability: "桌面宠物（DSH 专属 UI）" },
  "dsh-cosmos-launch": { kind: "ui-only", status: "pending", capability: "启动动画（DSH 专属 UI）" },
  "dshmarket": { kind: "ui-only", status: "pending", capability: "插件市场（DSH 专属）" },
  "dsh-github-forum": { kind: "ui-only", status: "pending", capability: "GitHub 论坛面板（DSH 专属 UI）" },
  "dsh-im": { kind: "unsupported", status: "pending", capability: "IM 网关（DSH 宿主集成）" },
  "@xmanrui/dsh-im": { kind: "unsupported", status: "pending", capability: "IM 网关（DSH 宿主集成）" },
  "dsh-wechat-daily": { kind: "unsupported", status: "pending", capability: "微信日报（依赖 DSH 会话数据）" },
  "dsh-deep-connect": { kind: "unsupported", status: "pending", capability: "跨机接力（DSH 宿主会话 API）" },
  "@local/dsh-deep-connect": { kind: "unsupported", status: "pending", capability: "跨机接力（DSH 宿主会话 API）" },
  "@liustack/modlens": { kind: "bridge", status: "pending", capability: "视觉读取（可替换为 WorkBuddy 视觉模型）" },
};

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface DepEntry {
  name: string;
  spec: string;
}

function readDeps(profileDir: string): DepEntry[] {
  const pkg = readJson(path.join(profileDir, "package.json"));
  const deps = (pkg?.dependencies ?? {}) as Record<string, string>;
  return Object.entries(deps).map(([name, spec]) => ({ name, spec: String(spec) }));
}

function classify(name: string): Classification {
  const base = PLUGIN_CLASSIFICATION[name];
  if (base) return base;
  const short = name.replace(/^(@[^/]+\/)/, "");
  const byShort = PLUGIN_CLASSIFICATION[short];
  if (byShort) return byShort;
  return { kind: "ui-only", status: "pending", capability: "未分类（DSH 专属或待评估）" };
}

export async function scanDshPlugins(opts: { dshProfileDir?: string } = {}): Promise<PluginInfo[]> {
  const profileDir = opts.dshProfileDir ?? DEFAULT_DSH_PROFILE;
  const deps = readDeps(profileDir);
  const out: PluginInfo[] = [];
  const seen = new Set<string>();
  for (const dep of deps) {
    if (seen.has(dep.name)) continue;
    seen.add(dep.name);
    const manifest = readJson(path.join(profileDir, "node_modules", dep.name, "package.json"));
    const version = typeof manifest?.version === "string" ? manifest.version : dep.spec;
    const description =
      (typeof manifest?.description === "string" && manifest.description) ||
      (typeof manifest?.name === "string" ? String(manifest.name) : "DSH 插件");
    const cls = classify(dep.name);
    const bridge = dep.name === "dsh-ffmpeg" ? ffmpegBridge() : dep.name === "dsh-wolfram" ? wolframBridge() : cls.bridge;
    const status: PluginStatus = cls.kind === "bridge" ? (bridge ? "bridge-ready" : "pending") : cls.status;
    out.push({
      id: dep.name,
      name: (typeof manifest?.name === "string" ? manifest.name : dep.name) as string,
      version: String(version),
      description: description.slice(0, 240),
      kind: cls.kind,
      status,
      source: "dsh",
      dshPackage: dep.name,
      capability: cls.capability,
      bridge: bridge ?? undefined,
      enabled: true,
    });
  }
  return out.sort((a, b) => {
    const rank = (s: PluginStatus) => (s === "bridge-ready" ? 0 : s === "migrated" ? 1 : s === "pending" ? 2 : 3);
    return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
  });
}

/** 执行一次桥接测试（不跑真实任务）：超时 10s、输出截断 4KB。 */
export function testPlugin(plugin: PluginInfo, timeoutMs = 10_000): Promise<PluginTestResult> {
  return new Promise((resolve) => {
    if (!plugin.bridge?.command) {
      resolve({ ok: false, message: "该插件没有可桥接的命令（DSH 专属或尚未接入）", latencyMs: 0 });
      return;
    }
    const started = Date.now();
    let settled = false;
    const done = (result: PluginTestResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(plugin.bridge.command, plugin.bridge.testArgs ?? [], {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      done({ ok: false, message: `无法启动桥接命令：${(error as Error).message}`, latencyMs: Date.now() - started });
      return;
    }
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 4096) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (error) => {
      done({ ok: false, message: `桥接命令错误：${error.message}`, latencyMs: Date.now() - started });
    });
    child.on("close", (code) => {
      const latencyMs = Date.now() - started;
      const trimmed = output.trim().slice(0, 4096);
      done({
        ok: code === 0,
        message: code === 0 ? "桥接命令可执行" : `桥接命令退出码 ${code}`,
        latencyMs,
        output: trimmed,
      });
    });
    setTimeout(() => {
      if (settled) return;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      done({ ok: false, message: `桥接测试超时（${timeoutMs}ms）`, latencyMs: Date.now() - started, output: output.slice(0, 4096) });
    }, timeoutMs + 200).unref?.();
  });
}
