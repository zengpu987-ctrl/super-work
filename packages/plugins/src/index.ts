/**
 * @super-work/plugins —— DSH 插件扫描与桥接（v0.0.3）。
 * 只读 DSH profile 的 package.json / node_modules manifest；桥接测试用 spawn 执行短命令。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  PluginAction,
  PluginBridgeSpec,
  PluginInfo,
  PluginKind,
  PluginStatus,
  PluginTestResult,
} from "@super-work/core";

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
  "dsh-image-gen": { kind: "bridge", status: "bridge-ready", capability: "生图（WorkBuddy 图像模型，已适配）" },
  "dsh-media-gen": { kind: "bridge", status: "bridge-ready", capability: "媒体合成（图片 → MP4，ffmpeg）" },
  "dsh-ffmpeg": {
    kind: "bridge",
    status: "bridge-ready",
    capability: "音视频剪辑/转码",
    bridge: ffmpegBridge(),
    note: "调用系统 ffmpeg",
  },
  "dsh-hyperframes": { kind: "bridge", status: "bridge-ready", capability: "动效 HTML 生成（完整渲染需 DSH）" },
  "dsh-remotion": { kind: "bridge", status: "bridge-ready", capability: "动效 HTML 生成（完整渲染需 DSH）" },
  "dsh-arxiv": { kind: "bridge", status: "bridge-ready", capability: "arXiv 检索（官方 API 已接）" },
  "dsh-wolfram": {
    kind: "bridge",
    status: "bridge-ready",
    capability: "Wolfram 计算（MCP）",
    bridge: wolframBridge(),
    note: "通过本机 wolframscript 探测",
  },
  "dsh-github-router": { kind: "bridge", status: "bridge-ready", capability: "GitHub 只读（API / raw，支持 token）" },
  "dsh-sci-plot": { kind: "bridge", status: "bridge-ready", capability: "科研绘图（matplotlib PNG）" },
  "dsh-vision-complete": { kind: "bridge", status: "bridge-ready", capability: "识图/OCR（WorkBuddy 视觉模型）" },
  "dsh-superman-ocr": { kind: "bridge", status: "bridge-ready", capability: "OCR（WorkBuddy 视觉模型）" },
  "dsh-superman": { kind: "native", status: "migrated", capability: "文件/文献归档（记忆库附件已覆盖）" },
  "dsh-find-plugin": { kind: "native", status: "migrated", capability: "插件中心（查看/测试/启停）" },
  "dsh-tools-settings": { kind: "ui-only", status: "adapted", capability: "工具设置（Super Work 设置页）" },
  "dsh-theme-market": { kind: "ui-only", status: "adapted", capability: "主题市场（玻璃/极光/森林）" },
  "dsh-better-sidebar": { kind: "ui-only", status: "adapted", capability: "侧栏增强（自适应布局）" },
  "dsh-claude-style": { kind: "ui-only", status: "adapted", capability: "阅读风格（科学衬线/无衬线）" },
  "dsh-wallpaper-bg": { kind: "ui-only", status: "adapted", capability: "动态壁纸（极光/森林背景）" },
  "dsh-pet-indesktop": { kind: "ui-only", status: "adapted", capability: "Jarvis 悬浮球（原生）" },
  "dsh-cosmos-launch": { kind: "ui-only", status: "adapted", capability: "入场动画（原生）" },
  "dshmarket": { kind: "ui-only", status: "linked", capability: "插件市场（npm 搜索入口）" },
  "dsh-github-forum": { kind: "ui-only", status: "linked", capability: "GitHub 讨论入口" },
  "dsh-im": { kind: "unsupported", status: "adapted", capability: "IM 通知（Webhook）" },
  "@xmanrui/dsh-im": { kind: "unsupported", status: "adapted", capability: "IM 通知（Webhook）" },
  "dsh-wechat-daily": { kind: "unsupported", status: "adapted", capability: "日报 Markdown 生成" },
  "dsh-deep-connect": { kind: "unsupported", status: "adapted", capability: "跨机接力（宿主适配说明）" },
  "@local/dsh-deep-connect": { kind: "unsupported", status: "adapted", capability: "跨机接力（宿主适配说明）" },
  "@liustack/modlens": { kind: "bridge", status: "bridge-ready", capability: "视觉读取（WorkBuddy 视觉模型）" },
};

/** 每个插件至少一个可运行/可打开的适配动作。 */
export const PLUGIN_ACTIONS: Record<string, PluginAction[]> = {
  "dsh-arxiv": [
    {
      id: "search",
      label: "检索 arXiv 论文",
      kind: "http",
      handler: "arxiv.search",
      description: "调用 arXiv 官方 API，返回标题/作者/摘要/链接。",
      fields: [
        { name: "query", label: "检索词", type: "text", placeholder: "例如: graph neural network", required: true },
        { name: "max", label: "返回条数", type: "number", defaultValue: "5" },
      ],
    },
  ],
  "dsh-github-router": [
    {
      id: "repo",
      label: "读取 GitHub 仓库文件",
      kind: "http",
      handler: "github.read",
      description: "读取公共仓库信息/文件；可填 token 提高限额。",
      fields: [
        { name: "owner", label: "owner", type: "text", placeholder: "octocat", required: true },
        { name: "repo", label: "repo", type: "text", placeholder: "Hello-World", required: true },
        { name: "path", label: "文件路径（可选）", type: "text", placeholder: "README.md" },
        { name: "token", label: "GitHub Token（可选）", type: "text", placeholder: "ghp_…" },
      ],
    },
  ],
  "dsh-vision-complete": [
    {
      id: "ocr",
      label: "识图 / OCR",
      kind: "native",
      handler: "vision.ocr",
      description: "用 WorkBuddy 视觉模型识别图片文字与画面内容。",
      fields: [
        { name: "imageUrl", label: "图片地址或上传 ID", type: "text", placeholder: "https://… 或 up_xxx", required: true },
        { name: "prompt", label: "识别要求", type: "text", defaultValue: "请提取图片中的全部文字，并简要描述画面。" },
      ],
    },
  ],
  "dsh-superman-ocr": [
    {
      id: "ocr",
      label: "OCR 识别",
      kind: "native",
      handler: "vision.ocr",
      description: "WorkBuddy 视觉模型 OCR（支持中英混排）。",
      fields: [
        { name: "imageUrl", label: "图片地址或上传 ID", type: "text", placeholder: "https://… 或 up_xxx", required: true },
      ],
    },
  ],
  "@liustack/modlens": [
    {
      id: "ocr",
      label: "视觉读取",
      kind: "native",
      handler: "vision.ocr",
      description: "替代 modlens：WorkBuddy 视觉模型读图/OCR。",
      fields: [
        { name: "imageUrl", label: "图片地址或上传 ID", type: "text", required: true },
        { name: "prompt", label: "读取要求", type: "text", defaultValue: "请描述这张图，并转录其中所有文字。" },
      ],
    },
  ],
  "dsh-image-gen": [
    {
      id: "generate",
      label: "生成图片",
      kind: "native",
      handler: "image.generate",
      description: "用 WorkBuddy 图像模型生成图片（消耗积分）。",
      fields: [
        { name: "prompt", label: "画面描述", type: "textarea", required: true, placeholder: "描述要生成的画面…" },
        { name: "size", label: "尺寸", type: "select", defaultValue: "1024x1024", options: [
          { value: "1024x1024", label: "1024×1024" },
          { value: "1024x768", label: "1024×768" },
          { value: "768x1024", label: "768×1024" },
        ] },
      ],
    },
  ],
  "dsh-media-gen": [
    {
      id: "slideshow",
      label: "图片转视频",
      kind: "native",
      handler: "video.slideshow",
      description: "把多张图片用 ffmpeg 合成为 MP4（Ken Burns 轻微推近）。",
      fields: [
        { name: "images", label: "图片地址（每行一个）", type: "textarea", required: true, placeholder: "https://… 或 /api/artifacts/…" },
        { name: "seconds", label: "每张秒数", type: "number", defaultValue: "3" },
      ],
    },
  ],
  "dsh-ffmpeg": [
    {
      id: "probe",
      label: "检测 ffmpeg",
      kind: "command",
      handler: "ffmpeg.probe",
      description: "检查版本与关键滤镜（zoompan/concat）。",
    },
  ],
  "dsh-wolfram": [
    {
      id: "eval",
      label: "科学计算",
      kind: "native",
      handler: "wolfram.eval",
      description: "优先 wolframscript；未安装时用 SymPy 计算（等价科学计算）。",
      fields: [{ name: "expr", label: "表达式（SymPy 语法）", type: "text", defaultValue: "integrate(sin(x), (x, 0, pi))", required: true }],
    },
  ],
  "dsh-sci-plot": [
    {
      id: "plot",
      label: "绘制数据图",
      kind: "native",
      handler: "plot.csv",
      description: "把 CSV（x,y 两列）用 matplotlib 画成 PNG。",
      fields: [
        { name: "csv", label: "CSV 数据", type: "textarea", required: true, defaultValue: "x,y\n0,1\n1,2.5\n2,4\n3,5.2\n" },
        { name: "title", label: "标题", type: "text", defaultValue: "sci-plot" },
      ],
    },
  ],
  "dsh-hyperframes": [
    {
      id: "motion",
      label: "生成动效 HTML",
      kind: "native",
      handler: "motion.html",
      description: "用内置动效模板生成可播放的 HTML 动画（HyperFrames 风格的平替）。",
      fields: [
        { name: "title", label: "标题", type: "text", defaultValue: "Super Work" },
        { name: "subtitle", label: "副标题", type: "text", defaultValue: "多模型联合工作台" },
        { name: "accent", label: "主色", type: "text", defaultValue: "#82c5ab" },
      ],
    },
    { id: "guide", label: "能力说明", kind: "native", handler: "native.guide", description: "完整 HyperFrames 渲染需 DSH 渲染栈。" },
  ],
  "dsh-remotion": [
    {
      id: "motion",
      label: "生成动效 HTML",
      kind: "native",
      handler: "motion.html",
      description: "用内置动效模板生成可播放的 HTML 动画（Remotion 风格的平替）。",
      fields: [
        { name: "title", label: "标题", type: "text", defaultValue: "Super Work" },
        { name: "subtitle", label: "副标题", type: "text", defaultValue: "多模型联合工作台" },
        { name: "accent", label: "主色", type: "text", defaultValue: "#82c5ab" },
      ],
    },
    { id: "guide", label: "能力说明", kind: "native", handler: "native.guide", description: "完整 Remotion 渲染需 Node 渲染栈。" },
  ],
  "dsh-theme-market": [
    {
      id: "appearance",
      label: "切换主题",
      kind: "native",
      handler: "native.appearance",
      description: "Super Work 原生主题（玻璃 / 极光 / 森林）。",
      fields: [{ name: "theme", label: "主题", type: "select", defaultValue: "glass", options: [
        { value: "glass", label: "玻璃（默认）" },
        { value: "aurora", label: "极光" },
        { value: "forest", label: "森林" },
      ] }],
    },
  ],
  "dsh-wallpaper-bg": [
    {
      id: "wallpaper",
      label: "更换背景",
      kind: "native",
      handler: "native.appearance",
      description: "切换 Super Work 背景（极光/玻璃/森林）。",
      fields: [{ name: "theme", label: "背景", type: "select", defaultValue: "aurora", options: [
        { value: "glass", label: "玻璃" },
        { value: "aurora", label: "极光" },
        { value: "forest", label: "森林" },
      ] }],
    },
  ],
  "dsh-claude-style": [
    {
      id: "serif",
      label: "衬线阅读风格",
      kind: "native",
      handler: "native.appearance",
      description: "切换答案正文字体（STIX 科学衬线 / 无衬线）。",
      fields: [{ name: "font", label: "字体", type: "select", defaultValue: "serif", options: [
        { value: "serif", label: "科学衬线" },
        { value: "sans", label: "无衬线" },
      ] }],
    },
  ],
  "dsh-cosmos-launch": [
    {
      id: "launch",
      label: "播放入场动画",
      kind: "native",
      handler: "native.launch",
      description: "重播 Super Work 启动动效。",
    },
  ],
  "dsh-pet-indesktop": [
    {
      id: "orb",
      label: "Jarvis 悬浮球",
      kind: "native",
      handler: "native.pet",
      description: "开关右下角 Jarvis 悬浮球（Super Work 原生）。",
      fields: [{ name: "on", label: "显示", type: "select", defaultValue: "on", options: [
        { value: "on", label: "显示" },
        { value: "off", label: "隐藏" },
      ] }],
    },
  ],
  "dsh-better-sidebar": [
    {
      id: "layout",
      label: "侧栏布局",
      kind: "native",
      handler: "native.appearance",
      description: "切换侧栏停靠方式（由窗口宽度自适应）。",
      fields: [{ name: "layout", label: "布局", type: "select", defaultValue: "auto", options: [
        { value: "auto", label: "自适应（默认）" },
      ] }],
    },
  ],
  "dsh-tools-settings": [
    {
      id: "open",
      label: "打开设置",
      kind: "native",
      handler: "native.settings",
      description: "Super Work 设置页已覆盖工具设置。",
    },
  ],
  "dshmarket": [
    {
      id: "open",
      label: "打开插件市场",
      kind: "link",
      url: "https://www.npmjs.com/search?q=dsh-plugin",
    },
  ],
  "dsh-github-forum": [
    {
      id: "open",
      label: "打开 GitHub 讨论",
      kind: "link",
      url: "https://github.com/search?q=dsh+plugin&type=repositories",
    },
  ],
  "dsh-im": [
    {
      id: "webhook",
      label: "Webhook 通知",
      kind: "native",
      handler: "webhook.notify",
      description: "把消息推送到任意 IM Webhook（飞书/钉钉/Slack/自定义）。",
      fields: [
        { name: "url", label: "Webhook URL", type: "text", placeholder: "https://…", required: true },
        { name: "message", label: "消息内容", type: "textarea", defaultValue: "Super Work 任务已完成" },
      ],
    },
    { id: "guide", label: "能力说明", kind: "native", handler: "native.guide", description: "DSH 会话内通知需宿主 API。" },
  ],
  "@xmanrui/dsh-im": [
    {
      id: "webhook",
      label: "Webhook 通知",
      kind: "native",
      handler: "webhook.notify",
      description: "把消息推送到任意 IM Webhook。",
      fields: [
        { name: "url", label: "Webhook URL", type: "text", placeholder: "https://…", required: true },
        { name: "message", label: "消息内容", type: "textarea", defaultValue: "Super Work 任务已完成" },
      ],
    },
  ],
  "dsh-wechat-daily": [
    {
      id: "report",
      label: "生成日报 Markdown",
      kind: "native",
      handler: "report.markdown",
      description: "生成标准日报 Markdown 文件（可粘贴到微信/飞书）。",
      fields: [
        { name: "date", label: "日期", type: "text", defaultValue: new Date().toISOString().slice(0, 10) },
        { name: "highlights", label: "今日要点（每行一条）", type: "textarea", defaultValue: "完成 Super Work 插件适配\n验证全部插件动作" },
      ],
    },
  ],
  "dsh-deep-connect": [
    {
      id: "guide",
      label: "跨机接力适配",
      kind: "native",
      handler: "native.guide",
      description: "跨机接力依赖 DSH 会话 API；需要单独桥接服务。",
    },
  ],
  "@local/dsh-deep-connect": [
    {
      id: "guide",
      label: "跨机接力适配",
      kind: "native",
      handler: "native.guide",
      description: "跨机接力依赖 DSH 会话 API；需要单独桥接服务。",
    },
  ],
};

function actionsFor(name: string, cls: Classification): PluginAction[] {
  const exact = PLUGIN_ACTIONS[name];
  if (exact) return exact;
  const short = name.replace(/^(@[^/]+\/)/, "");
  const byShort = PLUGIN_ACTIONS[short];
  if (byShort) return byShort;
  if (cls.kind === "native") {
    return [{ id: "open", label: "打开能力", kind: "native", handler: "native.guide", description: cls.capability }];
  }
  return [{ id: "guide", label: "能力说明", kind: "native", handler: "native.guide", description: cls.capability }];
}

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
    const actions = actionsFor(dep.name, cls);
    const hasLink = actions.some((action) => action.kind === "link");
    const status: PluginStatus =
      cls.kind === "native"
        ? "migrated"
        : cls.kind === "bridge"
          ? "bridge-ready"
          : hasLink
            ? "linked"
            : "adapted";
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
      actions,
      adaptation: status === "adapted" ? "已适配为 Super Work 原生能力" : status === "linked" ? "提供跳转入口" : undefined,
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
