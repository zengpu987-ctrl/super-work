import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  PROVIDERS,
  PROVIDER_BY_ID,
  PROVIDER_PURCHASE,
  type AppSettings,
  type AuthStartRequest,
  type ConnectRequest,
  type CreateRunRequest,
  type DiagnosticsResponse,
  type ModelsResponse,
  type ProviderStatus,
} from "@super-work/core";
import type { CredentialManager } from "./credentials.js";
import type { ModelRegistry } from "./registry.js";
import type { RunManager } from "./runs.js";
import type { AuthFlowManager } from "./auth/flows.js";
import type { Storage } from "./storage.js";
import type { Logger } from "./log.js";
import { detectSystemProxy, type Paths } from "./config.js";
import { validateV3Settings } from "./routes-v3.js";
import { RunRequestError } from "./runs.js";
import { activeProxy } from "./config.js";

export interface RouteDeps {
  paths: Paths;
  storage: Storage;
  creds: CredentialManager;
  registry: ModelRegistry;
  runs: RunManager;
  flows: AuthFlowManager;
  getSettings: () => AppSettings;
  putSettings: (next: AppSettings) => AppSettings;
  log: Logger;
  version: string;
  startedAt: number;
}

function badRequest(reply: FastifyReply, message: string, detail?: string) {
  return reply.code(400).send({ error: { code: "bad_request", message, detail } });
}

function providerStatus(deps: RouteDeps, providerId: string): ProviderStatus {
  const meta = PROVIDER_BY_ID[providerId as keyof typeof PROVIDER_BY_ID];
  const settings = deps.getSettings();
  if (meta.id === "relay" || meta.id === "workbuddy") {
    const models = deps.registry.allCatalogModels().filter((m) => m.provider === meta.id);
    const summary = deps.registry.summary().find((x) => x.provider === meta.id);
    return {
      id: meta.id,
      name: meta.name,
      short: meta.short,
      color: meta.color,
      kind: meta.kind,
      models,
      authModes: meta.authModes,
      subscription: meta.subscription,
      purchase: PROVIDER_PURCHASE[meta.id],
      note: meta.note,
      connections: deps.registry.relayConnections(meta.id as "relay" | "workbuddy"),
      connected: (summary?.connections ?? 0) > 0,
      localAccounts: [],
    };
  }
  const connections = deps.creds.statuses(meta.id);
  const custom = settings.customModels?.[meta.id] ?? [];
  const seen = new Set(meta.models.map((m) => m.id));
  return {
    id: meta.id,
    name: meta.name,
    short: meta.short,
    color: meta.color,
    kind: meta.kind,
    models: [...meta.models, ...custom.filter((m) => !seen.has(m.id)).map((m) => ({ ...m, provider: meta.id }))],
    authModes: meta.authModes,
    subscription: meta.subscription,
    purchase: PROVIDER_PURCHASE[meta.id],
    note: meta.note,
    connections,
    connected: connections.length > 0,
    localAccounts: deps.creds.localAccounts(meta.id),
  };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { paths, creds, registry, runs, flows, log } = deps;

  app.get("/api/health", async () => {
    let webBuild: number | undefined;
    try {
      webBuild = fs.statSync(path.join(paths.webDist, "index.html")).mtimeMs;
    } catch {
      /* 开发模式或未构建前端时没有 index.html */
    }
    return { ok: true, version: deps.version, webBuild };
  });

  app.get("/api/diagnostics", async (): Promise<DiagnosticsResponse> => {
    const statuses = PROVIDERS.map((p) => creds.statuses(p.id));
    const connected = statuses.filter((s) => s.length > 0).length;
    return {
      version: deps.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      dataDir: paths.home,
      proxy: activeProxy(),
      providersConnected: connected,
      providersTotal: PROVIDERS.length,
      runs: deps.storage.countRuns(),
    };
  });

  app.get("/api/proxy/detect", async () => detectSystemProxy());

  /* ------------------------------- settings ------------------------------- */

  app.get("/api/settings", async () => deps.getSettings());

  app.put("/api/settings", async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppSettings>;
    if (body === null || typeof body !== "object") return badRequest(reply, "请求体必须是对象");
    try {
      const merged = { ...deps.getSettings(), ...body } as AppSettings;
      if (!validateV3Settings(merged, reply)) return reply;
      const next = deps.putSettings(merged);
      return next;
    } catch (error) {
      return badRequest(reply, (error as Error).message);
    }
  });

  /* ------------------------------ providers ------------------------------- */

  app.get("/api/providers", async () => {
    return PROVIDERS.map((p) => providerStatus(deps, p.id));
  });

  app.post("/api/providers/:id/connect", async (req, reply) => {
    const providerId = (req.params as { id: string }).id;
    if (!PROVIDER_BY_ID[providerId as keyof typeof PROVIDER_BY_ID]) return badRequest(reply, "未知的模型平台");
    const body = (req.body ?? {}) as ConnectRequest;
    if (!body.mode) return badRequest(reply, "缺少 mode");
    try {
      const result = await creds.connect(providerId as never, body);
      return { status: result.status, warning: result.warning };
    } catch (error) {
      return reply.code(400).send({
        error: { code: "connect_failed", message: (error as Error).message },
      });
    }
  });

  app.delete("/api/providers/:id/connections/:cid", async (req, reply) => {
    const { cid } = req.params as { id: string; cid: string };
    const ok = creds.disconnect(cid);
    if (!ok) return reply.code(404).send({ error: { code: "not_found", message: "连接不存在" } });
    return { ok: true };
  });

  app.post("/api/providers/:id/import-local", async (req, reply) => {
    const providerId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { localAccountId?: string };
    if (!body.localAccountId) return badRequest(reply, "缺少 localAccountId");
    try {
      const status = await creds.importLocal(providerId as never, body.localAccountId);
      return { status };
    } catch (error) {
      return reply.code(400).send({ error: { code: "import_failed", message: (error as Error).message } });
    }
  });

  /* ------------------------------- auth flows ------------------------------ */

  app.post("/api/providers/:id/auth/start", async (req, reply) => {
    const providerId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as AuthStartRequest;
    if (!PROVIDER_BY_ID[providerId as keyof typeof PROVIDER_BY_ID]) return badRequest(reply, "未知的模型平台");
    if (!body.mode) return badRequest(reply, "缺少 mode");
    try {
      const start = await flows.start(providerId as never, body.mode);
      return start;
    } catch (error) {
      return reply.code(400).send({ error: { code: "auth_start_failed", message: (error as Error).message } });
    }
  });

  app.get("/api/providers/:id/auth/:flowId", async (req, reply) => {
    const { id, flowId } = req.params as { id: string; flowId: string };
    const state = flows.poll(id as never, flowId);
    if (state.status === "error" && state.message === "登录流程不存在或已过期") {
      return reply.code(404).send({ error: { code: "flow_not_found", message: state.message } });
    }
    return state;
  });

  app.post("/api/providers/:id/auth/:flowId/cancel", async (req) => {
    const { id, flowId } = req.params as { id: string; flowId: string };
    flows.cancel(id as never, flowId);
    return { ok: true };
  });

  /* -------------------------------- models -------------------------------- */

  app.get("/api/models", async (): Promise<ModelsResponse> => {
    return { models: registry.modelOptions(), generatedAt: Date.now() };
  });

  /* --------------------------------- runs --------------------------------- */

  app.post("/api/runs", async (req, reply) => {
    const body = (req.body ?? {}) as CreateRunRequest;
    try {
      const { id, detail } = runs.create(body);
      return reply.code(201).send({ id, run: detail });
    } catch (error) {
      if (error instanceof RunRequestError) {
        const status = error.code === "budget_exceeded" || error.code === "budget_confirm" ? 409 : 400;
        return reply.code(status).send({
          error: { code: error.code, message: error.message, detail: error.detail },
        });
      }
      return badRequest(reply, (error as Error).message);
    }
  });

  app.get("/api/runs", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 30);
    return runs.list(Number.isFinite(limit) ? limit : 30);
  });

  app.get("/api/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = runs.detail(id);
    if (!detail) return reply.code(404).send({ error: { code: "not_found", message: "运行不存在" } });
    return detail;
  });

  /* ------------------------------- threads -------------------------------- */

  app.get("/api/threads", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 30);
    return runs.listThreads(Number.isFinite(limit) ? limit : 30);
  });

  app.get("/api/threads/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = runs.threadDetail(id);
    if (!detail) return reply.code(404).send({ error: { code: "not_found", message: "工作不存在" } });
    return detail;
  });

  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!runs.detail(id)) return reply.code(404).send({ error: { code: "not_found", message: "运行不存在" } });
    const ok = runs.cancel(id);
    return { ok, message: ok ? "已请求取消" : "运行已结束" };
  });

  app.get("/api/runs/:id/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const detail = runs.detail(id);
    if (!detail) return reply.code(404).send({ error: { code: "not_found", message: "运行不存在" } });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const write = (eventName: string, payload: unknown, seq?: number) => {
      let frame = "";
      if (seq !== undefined) frame += `id: ${seq}\n`;
      frame += `event: ${eventName}\n`;
      frame += `data: ${JSON.stringify(payload)}\n\n`;
      reply.raw.write(frame);
    };

    write("snapshot", { type: "snapshot", run: detail });

    const query = req.query as { after?: string };
    const headerSeq = Number(req.headers["last-event-id"] ?? 0);
    const after = Number(query.after ?? (Number.isFinite(headerSeq) ? headerSeq : 0)) || 0;

    for (const entry of runs.replay(id, after)) {
      write("event", { type: "event", seq: entry.seq, event: entry.event }, entry.seq);
    }

    if (!runs.isRunning(id)) {
      reply.raw.write(": end\n\n");
      reply.raw.end();
      return;
    }

    const unsubscribe = runs.subscribe(id, (entry) => {
      write("event", { type: "event", seq: entry.seq, event: entry.event }, entry.seq);
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      log.debug("SSE 连接关闭", { id });
    });
    return reply;
  });

  /* -------------------------------- static -------------------------------- */

  if (fs.existsSync(paths.webDist)) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, {
      root: paths.webDist,
      prefix: "/",
      index: ["index.html"],
      wildcard: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "接口不存在" } });
      }
      const index = path.join(paths.webDist, "index.html");
      if (fs.existsSync(index)) return reply.type("text/html").send(fs.readFileSync(index, "utf8"));
      return reply.code(404).send("Super Work 前端尚未构建：pnpm build:web");
    });
  } else {
    app.get("/", async (_req, reply) => {
      reply.type("text/html; charset=utf-8");
      return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Super Work</title>
        <body style="font-family:system-ui;background:#0a0b10;color:#e6e8ef;padding:48px">
        <h1>Super Work 服务已启动</h1>
        <p>前端还没有构建。开发模式请运行 <code>pnpm dev</code>（Vite: 5178），或运行 <code>pnpm build:web</code> 后刷新。</p>
        <p>接口自检：<a style="color:#9ab" href="/api/health">/api/health</a></p></body></html>`;
    });
  }
}
