import crypto from "node:crypto";
import {
  BUILTIN_WORKFLOWS,
  PROVIDER_BY_ID,
  type Participant,
  type RunEvent,
  type Usage,
  type WorkflowCreateRequest,
  type WorkflowDef,
  type WorkflowRun,
  type WorkflowRunRequest,
  type WorkflowStep,
  type WorkflowStepRun,
} from "@super-work/core";
import { runWorkflow } from "@super-work/workflow";
import type { Storage } from "./storage.js";
import type { ModelRegistry } from "./registry.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  steps_json: string;
  builtin: number;
  created_at: number;
  updated_at: number;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  command: string;
  status: "running" | "done" | "error";
  steps_json: string | null;
  final_text: string | null;
  usage_json: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

interface LiveWorkflowRun {
  id: string;
  run: WorkflowRun;
  abort: AbortController;
  subscribers: Set<(entry: { seq: number; event: RunEvent }) => void>;
  done: boolean;
}

async function* stripDone(
  source: AsyncIterable<import("@super-work/core").ChatChunk>,
): AsyncIterable<{ type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "usage"; usage: Usage }> {
  for await (const chunk of source) {
    if (chunk.type === "done") continue;
    yield chunk;
  }
}

function asUsage(json: string | null): Usage | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Usage;
  } catch {
    return undefined;
  }
}

export class WorkflowManager {
  private live = new Map<string, LiveWorkflowRun>();

  constructor(
    private storage: Storage,
    private registry: ModelRegistry,
    private log: Logger,
  ) {
    this.storage.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_json TEXT,
        final_text TEXT,
        usage_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workflow_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_events ON workflow_events(run_id, seq);
    `);
    this.seedBuiltins();
  }

  private seedBuiltins(): void {
    const count = this.storage.db.prepare("SELECT COUNT(*) AS n FROM workflows").get() as { n: number };
    if (Number(count?.n ?? 0) > 0) return;
    for (const wf of BUILTIN_WORKFLOWS) {
      const id = `wf_builtin_${crypto.randomBytes(4).toString("hex")}`;
      const now = Date.now();
      this.storage.db
        .prepare("INSERT INTO workflows (id, name, description, steps_json, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
        .run(id, wf.name, wf.description, JSON.stringify(wf.steps), now, now);
    }
  }

  private rowToDef(row: WorkflowRow): WorkflowDef {
    let steps: WorkflowStep[] = [];
    try {
      steps = JSON.parse(row.steps_json) as WorkflowStep[];
    } catch {
      steps = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      steps,
      builtin: row.builtin === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): WorkflowDef[] {
    const rows = this.storage.db.prepare("SELECT * FROM workflows ORDER BY builtin DESC, created_at ASC").all() as unknown as WorkflowRow[];
    return rows.map((r) => this.rowToDef(r));
  }

  get(id: string): WorkflowDef | undefined {
    const row = this.storage.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as unknown as WorkflowRow | undefined;
    return row ? this.rowToDef(row) : undefined;
  }

  create(req: WorkflowCreateRequest): WorkflowDef {
    const id = `wf_${crypto.randomBytes(5).toString("hex")}`;
    const now = Date.now();
    this.storage.db
      .prepare("INSERT INTO workflows (id, name, description, steps_json, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(id, req.name, req.description ?? "", JSON.stringify(req.steps ?? []), now, now);
    return this.get(id)!;
  }

  update(id: string, req: Partial<WorkflowCreateRequest>): WorkflowDef | undefined {
    const row = this.storage.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as unknown as WorkflowRow | undefined;
    if (!row) return undefined;
    this.storage.db
      .prepare("UPDATE workflows SET name = ?, description = ?, steps_json = ?, updated_at = ? WHERE id = ?")
      .run(
        req.name ?? row.name,
        req.description ?? row.description,
        req.steps ? JSON.stringify(req.steps) : row.steps_json,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    const res = this.storage.db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  private toParticipant(step: WorkflowStep): Participant {
    const meta = step.model ? PROVIDER_BY_ID[step.model.provider] : undefined;
    const modelName = step.model ? this.registry.findModel(step.model.provider, step.model.model)?.name ?? step.model.model : "默认模型";
    return {
      id: `wf_${step.id}`,
      provider: step.model?.provider ?? "deepseek",
      model: step.model?.model ?? "deepseek-chat",
      label: step.name,
      role: step.role ?? step.name,
    };
  }

  run(workflowId: string, req: WorkflowRunRequest): { runId: string; run: WorkflowRun } {
    const def = this.get(workflowId);
    if (!def) throw new Error("工作流不存在");
    if (!req.command?.trim()) throw new Error("命令不能为空");
    const steps = req.stepIds ? def.steps.filter((s) => req.stepIds!.includes(s.id)) : def.steps;
    if (steps.length === 0) throw new Error("没有可执行的步骤");
    const missing = steps.filter((s) => !s.model);
    if (missing.length > 0) {
      throw new Error(`步骤「${missing[0]!.name}」还没有选择模型`);
    }
    const id = `wfr_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const now = Date.now();
    const run: WorkflowRun = {
      id,
      workflowId,
      workflowName: def.name,
      command: req.command,
      status: "running",
      steps: steps.map((s) => ({ stepId: s.id, name: s.name, status: "pending" as const, text: "" })),
      finalText: "",
      createdAt: now,
    };
    this.storage.db
      .prepare(
        "INSERT INTO workflow_runs (id, workflow_id, workflow_name, command, status, steps_json, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
      )
      .run(id, workflowId, def.name, req.command, JSON.stringify(run.steps), now);
    const state: LiveWorkflowRun = {
      id,
      run,
      abort: new AbortController(),
      subscribers: new Set(),
      done: false,
    };
    this.live.set(id, state);
    void this.execute(state, def, steps, req, steps.map((s) => this.toParticipant(s)));
    return { runId: id, run };
  }

  private emit(state: LiveWorkflowRun, event: RunEvent): void {
    const res = this.storage.db
      .prepare("INSERT INTO workflow_events (run_id, at, payload) VALUES (?, ?, ?)")
      .run(state.id, "at" in event && typeof event.at === "number" ? event.at : Date.now(), JSON.stringify(event));
    const seq = Number(res.lastInsertRowid);
    for (const sub of state.subscribers) {
      try {
        sub({ seq, event });
      } catch {
        /* ignore */
      }
    }
  }

  private async execute(
    state: LiveWorkflowRun,
    def: WorkflowDef,
    steps: WorkflowStep[],
    req: WorkflowRunRequest,
    participants: Participant[],
  ): Promise<void> {
    try {
      const result = await runWorkflow(
        { ...def, steps },
        req.command,
        {
          callModel: (callReq) =>
            stripDone(
              this.registry.chat({
                provider: callReq.provider,
                model: callReq.model,
                relayId: callReq.relayId,
                system: callReq.system,
                messages: callReq.messages,
                maxTokens: callReq.maxTokens,
                temperature: callReq.temperature,
                reasoning: callReq.reasoning,
                signal: callReq.signal ?? state.abort.signal,
              }),
            ),
        },
        (event) => this.emit(state, event),
        { signal: state.abort.signal },
      );
      state.run.status = "done";
      state.run.steps = result.steps;
      state.run.finalText = result.finalText;
      state.run.usage = result.usage;
      state.run.finishedAt = Date.now();
      this.storage.db
        .prepare(
          "UPDATE workflow_runs SET status = 'done', steps_json = ?, final_text = ?, usage_json = ?, finished_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(result.steps), result.finalText, JSON.stringify(result.usage ?? {}), state.run.finishedAt, state.id);
      this.log.info("工作流执行完成", { id: state.id, workflow: def.name, ms: state.run.finishedAt - state.run.createdAt });
    } catch (error) {
      const aborted = state.abort.signal.aborted;
      state.run.status = "error";
      state.run.error = aborted ? "已取消" : safeErrorMessage(error);
      state.run.finishedAt = Date.now();
      this.storage.db
        .prepare("UPDATE workflow_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?")
        .run(state.run.error, state.run.finishedAt, state.id);
      this.emit(state, { type: "run.error", message: state.run.error, at: Date.now() });
      this.emit(state, { type: "run.done", runId: state.id, at: Date.now() });
    } finally {
      state.done = true;
      state.subscribers.clear();
    }
  }

  private rowToRun(row: WorkflowRunRow): WorkflowRun {
    let steps: WorkflowStepRun[] = [];
    try {
      steps = row.steps_json ? (JSON.parse(row.steps_json) as WorkflowStepRun[]) : [];
    } catch {
      steps = [];
    }
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      command: row.command,
      status: row.status,
      steps,
      finalText: row.final_text ?? "",
      usage: asUsage(row.usage_json),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      finishedAt: row.finished_at ?? undefined,
    };
  }

  getRun(id: string): WorkflowRun | undefined {
    const live = this.live.get(id);
    if (live) return live.run;
    const row = this.storage.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as unknown as WorkflowRunRow | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  listRuns(limit = 30): WorkflowRun[] {
    const rows = this.storage.db
      .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit))) as unknown as WorkflowRunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  cancel(id: string): boolean {
    const live = this.live.get(id);
    if (!live || live.done) return false;
    live.abort.abort();
    return true;
  }

  replay(id: string, afterSeq = 0): Array<{ seq: number; event: RunEvent }> {
    const rows = this.storage.db
      .prepare("SELECT seq, payload FROM workflow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
      .all(id, afterSeq) as unknown as Array<{ seq: number; payload: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), event: JSON.parse(r.payload) as RunEvent }));
  }

  subscribe(id: string, listener: (entry: { seq: number; event: RunEvent }) => void): () => void {
    const live = this.live.get(id);
    if (!live || live.done) return () => {};
    live.subscribers.add(listener);
    return () => live.subscribers.delete(listener);
  }

  isRunning(id: string): boolean {
    const live = this.live.get(id);
    return Boolean(live && !live.done);
  }
}
