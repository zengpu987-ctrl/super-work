import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SETTINGS,
  applyProxy,
  detectSystemProxy,
  ensureHome,
  loadSettings,
  normalizeSettings,
  resolvePaths,
  saveSettings,
  type Paths,
} from "./config.js";
import { Storage } from "./storage.js";
import { CredentialManager } from "./credentials.js";
import { RelayStore } from "./relays.js";
import { BillingService } from "./billing.js";
import { ModelRegistry } from "./registry.js";
import { RunManager } from "./runs.js";
import { WorkflowManager } from "./workflows.js";
import { AuthFlowManager } from "./auth/flows.js";
import { registerRoutes } from "./routes.js";
import { registerV2Routes } from "./routes-v2.js";
import { MemoryStore } from "@super-work/memory";
import { UploadStore, PluginService } from "./v3.js";
import { registerV3Routes, validateV3Settings } from "./routes-v3.js";
import { createLogger } from "./log.js";
import type { AppSettings } from "@super-work/core";

const VERSION = "1.0.0 Pro";

function banner(url: string, connected: number, total: number, dataDir: string, proxy?: string): string {
  return [
    "",
    "  ███████╗██╗   ██╗██████╗ ███████╗██████╗     ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗",
    "  ██╔════╝██║   ██║██╔══██╗██╔════╝██╔══██╗    ██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝",
    "  ███████╗██║   ██║██████╔╝█████╗  ██████╔╝    ██║ █╗ ██║██║   ██║██████╔╝█████╔╝ ",
    "  ╚════██║██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗    ██║███╗██║██║   ██║██╔══██╗██╔═██╗ ",
    "  ███████║╚██████╔╝██║     ███████╗██║  ██║    ╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗",
    "  ╚══════╝ ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝     ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
    "",
    `  v${VERSION} · 多模型联合工作台`,
    "",
    `  打开：${url}`,
    `  已连接：${connected}/${total} 家模型平台`,
    `  数据目录：${dataDir}`,
    `  代理：${proxy ?? "未启用"}`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureHome(paths);

  let settings: AppSettings = loadSettings(paths);

  // 没有显式配置代理时，跟随系统代理（本机直连 OpenAI 会被地域拦截）。
  if (!settings.proxy) {
    const detected = await detectSystemProxy();
    if (detected.source === "system" && detected.suggestion) {
      settings = { ...settings, proxy: detected.suggestion };
      applyProxy(settings.proxy);
      console.log(`[proxy] 自动跟随系统代理：${settings.proxy}`);
    }
  } else {
    applyProxy(settings.proxy);
  }

  const log = createLogger("super-work");
  const storage = new Storage(paths);
  const creds = new CredentialManager(storage, settings, log);
  const relays = new RelayStore(storage, log.child("relay"));
  const billing = new BillingService(storage, log.child("billing"));
  const uploads = new UploadStore(storage, paths, log.child("uploads"));
  const pluginService = new PluginService(storage, log.child("plugins"));
  const memory = new MemoryStore(paths.memoryDb);
  memory.init();
  // 首次启动：导入从 DSH 记忆快照整理的种子（只做一次，用户可删改）
  try {
    if (memory.stats().total === 0) {
      const seedFile = path.join(paths.repoRoot, "apps/server/seed/dsh-memories.json");
      if (fs.existsSync(seedFile)) {
        const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
        const imported = memory.importSeed(seed);
        log.info("已导入 DSH 记忆种子", { imported });
      }
    }
  } catch (error) {
    log.warn("导入 DSH 记忆种子失败", { message: (error as Error).message });
  }
  const registry = new ModelRegistry(creds, relays, log);
  const runs = new RunManager(registry, storage, settings, log, { billing, memory, paths, uploads });
  const workflows = new WorkflowManager(storage, registry, log.child("workflow"));
  const flows = new AuthFlowManager({
    saveCredential: (credential) => creds.saveCredential(credential),
    log: log.child("auth"),
  });

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  const putSettings = (next: AppSettings): AppSettings => {
    const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...next });
    const saved = saveSettings(paths, normalized);
    applyProxy(saved.proxy);
    creds.setSettings(saved);
    runs.setSettings(saved);
    settings = saved;
    log.info("设置已保存", { proxy: saved.proxy ?? null, allowLocalReuse: saved.allowLocalReuse });
    return saved;
  };

  await registerV3Routes(app, {
    paths,
    storage,
    billing,
    creds,
    uploads,
    plugins: pluginService,
    getSettings: () => settings,
    putSettings,
    log,
  });

  await registerV2Routes(app, {
    paths,
    storage,
    registry,
    runs,
    relays,
    creds,
    putSettings,
    billing,
    workflows,
    memory,
    log,
  });

  await registerRoutes(app, {
    paths,
    storage,
    creds,
    registry,
    runs,
    flows,
    getSettings: () => settings,
    putSettings,
    log,
    version: VERSION,
    startedAt: Date.now(),
  });

  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number };
    const status = err.statusCode ?? 500;
    if (status >= 500) log.error("请求处理异常", { message: err.message });
    reply.code(status).send({
      error: {
        code: status >= 500 ? "internal_error" : "bad_request",
        message: err.message || "服务器内部错误",
      },
    });
  });

  const basePort = Number(process.env.SUPER_WORK_PORT ?? 7788);
  let port = basePort;
  let listening = false;
  for (let attempt = 0; attempt < 12 && !listening; attempt += 1) {
    try {
      await app.listen({ port, host: "127.0.0.1" });
      listening = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw error;
    }
  }
  if (!listening) throw new Error(`无法监听端口（从 ${basePort} 起尝试 12 个）`);

  const url = `http://127.0.0.1:${port}`;
  const connected = registry.summary().filter((s) => s.connections > 0).length;
  console.log(banner(url, connected, registry.summary().length, paths.home, settings.proxy));
  if (!fs.existsSync(paths.webDist)) {
    console.log("  提示：前端未构建。开发请另开终端运行 `pnpm dev`（Vite: http://127.0.0.1:5178）。\n");
  }

  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Super Work 启动失败：", error);
  process.exit(1);
});
