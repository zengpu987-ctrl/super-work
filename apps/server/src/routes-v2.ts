import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  normalizeEffort,
  outputMime,
  RELAY_PRESETS,
  type Artifact,
  type BillingSummary,
  type ContextRunSummary,
  type MemoryCreateRequest,
  type MemoryUpdateRequest,
  type ModelPrice,
  type RelayCreateRequest,
  type RelayModel,
  type RelayUpdateRequest,
  type RunEvent,
  type WorkflowCreateRequest,
  type WorkflowRunRequest,
} from "@super-work/core";
import type { MemoryStore } from "@super-work/memory";
import { adapterForCall } from "@super-work/providers";
import type { CredentialManager } from "./credentials.js";
import type { RelayStore } from "./relays.js";
import { detectWorkBuddyLocalAccounts } from "./relays.js";
import type { BillingService } from "./billing.js";
import type { WorkflowManager } from "./workflows.js";
import { buildContextSummary } from "./context.js";
import { mergeDiscoveredModels } from "./model-sync.js";
import type { RunManager } from "./runs.js";
import type { ModelRegistry } from "./registry.js";
import type { Storage } from "./storage.js";
import type { Paths } from "./config.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";

export interface RouteV2Deps {
  paths: Paths;
  storage: Storage;
  registry: ModelRegistry;
  creds: CredentialManager;
  putSettings: (next: import("@super-work/core").AppSettings) => import("@super-work/core").AppSettings;
  runs: RunManager;
  relays: RelayStore;
  billing: BillingService;
  workflows: WorkflowManager;
  memory: MemoryStore;
  log: Logger;
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: { code: "not_found", message } });
}

function bad(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "bad_request", message } });
}

function sseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export async function registerV2Routes(app: FastifyInstance, deps: RouteV2Deps): Promise<void> {
  const { relays, billing, workflows, memory, runs, storage, paths, log, creds, registry } = deps;

  /* ------------------------------- 中转站 ------------------------------- */

  app.get("/api/relays", async () => relays.list());
  app.get("/api/relays/presets", async () => RELAY_PRESETS);

  app.get("/api/relays/local/workbuddy", async () => ({
    accounts: detectWorkBuddyLocalAccounts(),
  }));

  app.post("/api/relays/local/workbuddy/import", async (req, reply) => {
    const body = (req.body ?? {}) as { uid?: string; region?: "cn" | "global" };
    try {
      const account = await relays.importWorkBuddy({ uid: body.uid, region: body.region });
      return { account };
    } catch (error) {
      return reply.code(400).send({ error: { code: "import_failed", message: safeErrorMessage(error) } });
    }
  });

  app.post("/api/relays", async (req, reply) => {
    const body = (req.body ?? {}) as RelayCreateRequest;
    if (!body.name?.trim() && !body.presetId) return bad(reply, "缺少名称或预设");
    try {
      const account = relays.create(body);
      let discovered: RelayModel[] | undefined;
      try {
        if (account.kind === "workbuddy") {
          const result = await relays.discover(account.id);
          discovered = result.models;
        } else if (body.baseUrl?.trim() && body.apiKey?.trim()) {
          const result = await relays.discover(account.id);
          discovered = result.models;
        }
      } catch (error) {
        log.warn("创建后发现模型失败", { id: account.id, message: safeErrorMessage(error) });
      }
      return { account: relays.get(account.id) ?? account, discovered };
    } catch (error) {
      return reply.code(400).send({ error: { code: "relay_create_failed", message: safeErrorMessage(error) } });
    }
  });

  app.put("/api/relays/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as RelayUpdateRequest;
    const account = relays.update(id, body);
    if (!account) return notFound(reply, "中转站不存在");
    return { account };
  });

  app.delete("/api/relays/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!relays.remove(id)) return notFound(reply, "中转站不存在");
    return { ok: true };
  });

  app.post("/api/relays/:id/discover", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await relays.discover(id);
    } catch (error) {
      return reply.code(400).send({ error: { code: "discover_failed", message: safeErrorMessage(error) } });
    }
  });

  app.post("/api/relays/:id/import-models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { models?: RelayModel[]; modelIds?: string[] };
    const account = relays.get(id);
    if (!account) return notFound(reply, "中转站不存在");
    let models: RelayModel[] = [];
    if (Array.isArray(body.models) && body.models.length > 0) {
      models = body.models.filter((m) => m && typeof m.id === "string").map((m) => ({ ...m, enabled: true }));
    } else if (Array.isArray(body.modelIds) && body.modelIds.length > 0) {
      const discovered = await relays.discover(id).catch(() => ({ models: [] as RelayModel[] }));
      const wanted = new Set(body.modelIds);
      models = discovered.models.filter((m) => wanted.has(m.id)).map((m) => ({ ...m, enabled: true }));
    } else {
      return bad(reply, "缺少 models 或 modelIds");
    }
    const updated = relays.importModels(id, models);
    return { account: updated };
  });

  /** 手动添加/覆盖模型（上游没有 /models、校验失败或私有模型时使用）。 */
  app.post("/api/relays/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { models?: RelayModel[] };
    if (!Array.isArray(body.models) || body.models.length === 0) return bad(reply, "缺少 models 数组");
    const account = relays.importModels(
      id,
      body.models
        .filter((m) => m && typeof m.id === "string" && m.id.trim() !== "")
        .map((m) => ({ ...m, id: m.id.trim(), name: m.name?.trim() || m.id.trim(), enabled: true })),
    );
    if (!account) return notFound(reply, "中转站不存在");
    return { account };
  });

  app.post("/api/relays/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const started = Date.now();
    try {
      const result = await relays.discover(id);
      return { ok: true, latencyMs: Date.now() - started, models: result.models.length, detail: result.detail };
    } catch (error) {
      return reply.code(400).send({ error: { code: "relay_test_failed", message: safeErrorMessage(error) } });
    }
  });

  /* ----------------------------- 模型目录同步 ----------------------------- */

  app.post("/api/models/refresh", async () => {
    const settings = creds.getSettings();
    const custom = { ...(settings.customModels ?? {}) };
    const updated: Array<{ provider: string; count: number; source: string }> = [];
    const errors: Array<{ provider: string; message: string }> = [];
    const providers = ["deepseek", "kimi", "openai", "anthropic", "zhipu", "qwen", "volcengine", "minimax", "gemini", "xai"] as const;

    for (const provider of providers) {
      const resolved = creds.resolve(provider);
      if (!resolved) continue;
      try {
        const credential = await creds.fresh(resolved);
        const adapter = adapterForCall(provider, credential);
        // 订阅通道（ChatGPT / Kimi 会员）有各自的实时目录接口，优先走它；
        // 其余平台仍走 /models 探测。listModels 只作为离线兜底。
        const load = adapter.discoverModels
          ? () => adapter.discoverModels!(credential)
          : () => adapter.listModels(credential);
        const models = await Promise.race([
          load(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("拉取超时（12s）")), 12_000)),
        ]);
        const via = resolved.row.mode === "api-key" ? ("api" as const) : ("subscription" as const);
        custom[provider] = mergeDiscoveredModels(custom[provider] ?? [], models, provider, via);
        updated.push({
          provider,
          count: models.length,
          source: adapter.discoverModels ? `${resolved.row.mode} · 实时目录` : resolved.row.mode,
        });
      } catch (error) {
        errors.push({ provider, message: safeErrorMessage(error) });
      }
    }

    // WorkBuddy / 中转站：重新拉一次上游目录
    for (const relay of relays.list()) {
      if (!relay.enabled) continue;
      try {
        const result = await relays.discover(relay.id);
        const merged = result.models.map((m) => ({ ...m, enabled: true }));
        relays.importModels(relay.id, merged);
        updated.push({ provider: relay.kind === "workbuddy" ? "workbuddy" : "relay", count: merged.length, source: relay.name });
      } catch (error) {
        errors.push({ provider: relay.name, message: safeErrorMessage(error) });
      }
    }

    deps.putSettings({ ...creds.getSettings(), customModels: custom });
    return {
      updated,
      errors,
      total: registry.modelOptions().length,
      note: "已合并上游最新模型；服务端会保存到设置里的 customModels",
    };
  });

  /* -------------------------------- 计费 -------------------------------- */

  app.get("/api/billing/summary", async (): Promise<BillingSummary> => billing.summary());
  app.get("/api/billing/prices", async (): Promise<ModelPrice[]> => billing.prices());

  app.put("/api/billing/prices", async (req, reply) => {
    const body = (req.body ?? {}) as { prices?: ModelPrice[] } | ModelPrice[];
    const prices = Array.isArray(body) ? body : body.prices;
    if (!Array.isArray(prices)) return bad(reply, "缺少 prices 数组");
    return billing.savePrices(prices);
  });

  app.post("/api/billing/import-dsh", async () => billing.importDshLedger());

  app.get("/api/billing/export.csv", async (_req, reply) => {
    const csv = billing.exportCsv();
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="super-work-billing.csv"')
      .send(`\uFEFF${csv}`);
  });

  /* ------------------------------ 上下文洞察 ------------------------------ */

  app.get("/api/runs/:id/context", async (req, reply): Promise<ContextRunSummary | FastifyReply> => {
    const { id } = req.params as { id: string };
    if (!runs.detail(id)) return notFound(reply, "运行不存在");
    const summary = buildContextSummary(storage, id);
    if (!summary) {
      return {
        runId: id,
        calls: [],
        peakPromptTokens: 0,
        totalPromptTokens: 0,
      };
    }
    return summary;
  });

  /* -------------------------------- 记忆 -------------------------------- */

  app.get("/api/memory/stats", async () => memory.stats());
  app.get("/api/memory/spaces", async () => memory.spaces());

  app.post("/api/memory/spaces", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; description?: string };
    if (!body.name?.trim()) return bad(reply, "缺少空间名称");
    return memory.createSpace(body.name.trim(), body.description?.trim() ?? "");
  });

  app.patch("/api/memory/spaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string; description?: string };
    const space = memory.updateSpace(id, body);
    if (!space) return notFound(reply, "记忆空间不存在");
    return space;
  });

  app.delete("/api/memory/spaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!memory.deleteSpace(id)) return notFound(reply, "记忆空间不存在");
    return { ok: true };
  });

  app.get("/api/memory/entries", async (req) => {
    const q = req.query as {
      spaceId?: string;
      kind?: string;
      enabled?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
    if (q.q && q.q.trim()) {
      const hits = memory.search(q.q.trim(), Math.min(50, Number(q.limit ?? 20) || 20));
      return hits.map((h) => ({ ...h.memory, score: h.score }));
    }
    return memory.list({
      spaceId: q.spaceId,
      kind: q.kind as never,
      enabled: q.enabled === undefined ? undefined : q.enabled === "true",
      limit: Math.min(200, Number(q.limit ?? 100) || 100),
      offset: Number(q.offset ?? 0) || 0,
    });
  });

  app.post("/api/memory/entries", async (req, reply) => {
    const body = (req.body ?? {}) as MemoryCreateRequest;
    if (!body.content?.trim()) return bad(reply, "缺少记忆内容");
    return memory.add({ ...body, content: body.content.trim() }, body.spaceId);
  });

  app.patch("/api/memory/entries/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as MemoryUpdateRequest;
    const entry = memory.update(id, body);
    if (!entry) return notFound(reply, "记忆不存在");
    return entry;
  });

  app.delete("/api/memory/entries/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!memory.remove(id)) return notFound(reply, "记忆不存在");
    return { ok: true };
  });

  app.post("/api/memory/search", async (req) => {
    const body = (req.body ?? {}) as { query?: string; limit?: number };
    if (!body.query?.trim()) return [];
    return memory.search(body.query.trim(), Math.min(100, body.limit ?? 10));
  });

  app.post("/api/memory/import-dsh", async (req, reply) => {
    const body = (req.body ?? {}) as { seed?: unknown; file?: string };
    try {
      if (body.seed && typeof body.seed === "object") {
        const imported = memory.importSeed(body.seed as never);
        return { imported };
      }
      const candidates = [
        body.file,
        path.join(paths.home, "import/dsh-memories.json"),
        path.join(process.env.HOME ?? ".", ".dsh/superman/memories.json"),
      ].filter(Boolean) as string[];
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const seed = JSON.parse(fs.readFileSync(file, "utf8"));
        const imported = memory.importSeed(seed);
        return { imported, file };
      }
      return bad(reply, "没有找到可导入的 DSH 记忆文件（可先导出为 JSON 再传入 seed）");
    } catch (error) {
      return reply.code(400).send({ error: { code: "memory_import_failed", message: safeErrorMessage(error) } });
    }
  });

  app.get("/api/memory/export", async (_req, reply) => {
    const seed = memory.exportSeed();
    return reply.header("Content-Type", "application/json").send(seed);
  });

  /* ------------------------------- 工作流 ------------------------------- */

  app.get("/api/workflows", async () => workflows.list());

  app.post("/api/workflows", async (req, reply) => {
    const body = (req.body ?? {}) as WorkflowCreateRequest;
    if (!body.name?.trim()) return bad(reply, "缺少工作流名称");
    if (!Array.isArray(body.steps) || body.steps.length === 0) return bad(reply, "至少需要一个步骤");
    return workflows.create({ ...body, name: body.name.trim() });
  });

  app.put("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<WorkflowCreateRequest>;
    const def = workflows.update(id, body);
    if (!def) return notFound(reply, "工作流不存在");
    return def;
  });

  app.delete("/api/workflows/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!workflows.remove(id)) return notFound(reply, "工作流不存在");
    return { ok: true };
  });

  app.post("/api/workflows/:id/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as WorkflowRunRequest;
    try {
      return workflows.run(id, body);
    } catch (error) {
      return reply.code(400).send({ error: { code: "workflow_run_failed", message: safeErrorMessage(error) } });
    }
  });

  app.get("/api/workflow-runs", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 30);
    return workflows.listRuns(Number.isFinite(limit) ? limit : 30);
  });

  app.get("/api/workflow-runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = workflows.getRun(id);
    if (!run) return notFound(reply, "工作流运行不存在");
    return run;
  });

  app.post("/api/workflow-runs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!workflows.getRun(id)) return notFound(reply, "工作流运行不存在");
    return { ok: workflows.cancel(id) };
  });

  app.get("/api/workflow-runs/:id/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const run = workflows.getRun(id);
    if (!run) return notFound(reply, "工作流运行不存在");
    sseHeaders(reply);
    const write = (eventName: string, payload: unknown, seq?: number) => {
      let frame = "";
      if (seq !== undefined) frame += `id: ${seq}\n`;
      frame += `event: ${eventName}\n`;
      frame += `data: ${JSON.stringify(payload)}\n\n`;
      reply.raw.write(frame);
    };
    write("snapshot", { type: "snapshot", run });
    const afterHeader = Number(req.headers["last-event-id"] ?? 0);
    const after = Number((req.query as { after?: string }).after ?? (Number.isFinite(afterHeader) ? afterHeader : 0)) || 0;
    for (const entry of workflows.replay(id, after)) {
      write("event", { type: "event", seq: entry.seq, event: entry.event }, entry.seq);
    }
    if (!workflows.isRunning(id)) {
      reply.raw.write(": end\n\n");
      reply.raw.end();
      return reply;
    }
    const unsubscribe = workflows.subscribe(id, (entry: { seq: number; event: RunEvent }) => {
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
    });
    return reply;
  });

  /* ---------------------------- 运行中热调强度 ---------------------------- */

  app.post("/api/runs/:id/effort", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { participantId?: string; effort?: string };
    const level = normalizeEffort(body.effort);
    if (!level) return bad(reply, "effort 必须是 low/medium/fast/max/ultra 之一");
    if (!body.participantId) return bad(reply, "缺少 participantId");
    const detail = runs.detail(id);
    if (!detail) return notFound(reply, "运行不存在");
    if (!detail.participants.some((p) => p.id === body.participantId)) return bad(reply, "参与者不存在");
    if (!runs.isRunning(id)) {
      return reply.code(409).send({ error: { code: "run_not_running", message: "运行已结束，无法调整强度" } });
    }
    const ok = runs.setEffort(id, body.participantId, level);
    if (!ok) {
      return reply.code(409).send({ error: { code: "effort_not_applied", message: "运行状态已变化，未应用" } });
    }
    return { ok: true, participantId: body.participantId, effort: level, note: "下一次调用生效" };
  });

  /* ------------------------- 运行中单独停止某个模型 ------------------------- */

  app.post("/api/runs/:id/participants/:participantId/stop", async (req, reply) => {
    const { id, participantId } = req.params as { id: string; participantId: string };
    const detail = runs.detail(id);
    if (!detail) return notFound(reply, "运行不存在");
    const known =
      detail.participants.some((p) => p.id === participantId) ||
      detail.results.some((r) => r.participantId === participantId);
    if (!known) return bad(reply, "参与者不存在");
    if (!runs.isRunning(id)) {
      return reply.code(409).send({ error: { code: "run_not_running", message: "运行已结束，无法单独停止模型" } });
    }
    const ok = runs.stopParticipant(id, participantId);
    if (!ok) {
      return reply.code(409).send({
        error: { code: "participant_not_stoppable", message: "该模型当前没有可停止的调用（可能已完成或已停止）" },
      });
    }
    return { ok: true, participantId, note: "已停止该模型，其余模型继续" };
  });

  /* ------------------------------- 产物文件 ------------------------------- */

  const MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
  };

  app.get("/api/artifacts/:runId/:file", async (req, reply) => {
    const { runId, file } = req.params as { runId: string; file: string };
    // 文件名允许中文 / 空格；只禁止目录分隔符与 ..，并强制 basename 等于自身
    if (!/^[A-Za-z0-9_.-]+$/.test(runId)) return bad(reply, "非法路径");
    if (!file || file.includes("..") || /[/\\\u0000]/.test(file) || path.basename(file) !== file) {
      return bad(reply, "非法路径");
    }
    const full = path.join(paths.home, "artifacts", runId, file);
    if (!fs.existsSync(full)) return notFound(reply, "产物不存在");
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] ?? outputMime(file);
    return reply.type(type).send(fs.readFileSync(full));
  });

  /* 供 web 快速拿到某次运行的产物（RunDetail 已包含，这里给单独入口便于轮询） */
  app.get("/api/runs/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = runs.detail(id);
    if (!detail) return notFound(reply, "运行不存在");
    return (detail.artifacts ?? []) as Artifact[];
  });
}
