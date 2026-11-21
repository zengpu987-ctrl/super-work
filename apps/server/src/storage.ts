import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Credential, CredentialSource, ProviderId, RunEvent, RunMode, Usage } from "@super-work/core";
import type { Paths } from "./config.js";
import { decrypt, encrypt } from "./crypto.js";

export interface StoredCredential {
  id: string;
  provider: ProviderId;
  mode: Credential["mode"];
  source: CredentialSource;
  label: string;
  accountLabel?: string;
  createdAt: number;
  updatedAt: number;
  healthy: boolean;
  detail?: string;
}

interface CredentialRow {
  id: string;
  provider: ProviderId;
  mode: Credential["mode"];
  source: CredentialSource;
  label: string | null;
  account_label: string | null;
  payload: string;
  created_at: number;
  updated_at: number;
  healthy: number;
  detail: string | null;
}

export interface RunRow {
  id: string;
  command: string;
  mode: RunMode;
  status: "running" | "done" | "error";
  created_at: number;
  finished_at: number | null;
  final_text: string | null;
  error: string | null;
  options_json: string | null;
  participants_json: string | null;
  results_json: string | null;
  usage_json: string | null;
  artifacts_json: string | null;
  cost_json: string | null;
  coordination_json: string | null;
  guard_json: string | null;
  attachments_json: string | null;
  thread_id: string | null;
  round_index: number | null;
}

export interface RunRowShape {
  id: string;
  command: string;
  mode: RunMode;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  finalText: string;
  error?: string;
  optionsJson?: string;
  participantsJson?: string;
  resultsJson?: string;
  usage?: Usage;
  /** 多轮对话：所属工作（第一条运行的 id） */
  threadId?: string;
  /** 多轮对话：第几轮（从 1 开始） */
  round?: number;
}

export interface ThreadMetaRow {
  thread_id: string;
  archived: number;
  deleted_at: number | null;
  parent_thread_id: string | null;
  branched_from_run_id: string | null;
  memory: string | null;
  memory_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ThreadMetaPatch {
  archived?: boolean;
  deletedAt?: number | null;
  parentThreadId?: string | null;
  branchedFromRunId?: string | null;
  memory?: string | null;
}

export class Storage {
  readonly db: DatabaseSync;

  constructor(private paths: Paths) {
    fs.mkdirSync(path.dirname(paths.dbFile), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(paths.dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        source TEXT NOT NULL,
        label TEXT,
        account_label TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        healthy INTEGER NOT NULL DEFAULT 1,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_provider ON credentials(provider);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        final_text TEXT,
        error TEXT,
        options_json TEXT,
        participants_json TEXT,
        results_json TEXT,
        usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS run_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, seq);
      CREATE TABLE IF NOT EXISTS thread_meta (
        thread_id TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        parent_thread_id TEXT,
        branched_from_run_id TEXT,
        memory TEXT,
        memory_updated_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureColumn("runs", "artifacts_json", "TEXT");
    this.ensureColumn("runs", "cost_json", "TEXT");
    this.ensureColumn("runs", "coordination_json", "TEXT");
    this.ensureColumn("runs", "guard_json", "TEXT");
    this.ensureColumn("runs", "attachments_json", "TEXT");
    this.ensureColumn("runs", "thread_id", "TEXT");
    this.ensureColumn("runs", "round_index", "INTEGER");
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, round_index)");
    } catch {
      /* ignore */
    }
  }

  private ensureColumn(table: string, column: string, type: string): void {
    try {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    } catch {
      /* ignore */
    }
  }

  saveRunGuard(runId: string, guard: unknown, attachments?: unknown[]): void {
    this.db.prepare("UPDATE runs SET guard_json = ?, attachments_json = ? WHERE id = ?").run(
      JSON.stringify(guard ?? null),
      JSON.stringify(attachments ?? []),
      runId,
    );
  }

  saveRunCoordination(runId: string, coordination: unknown): void {
    this.db.prepare("UPDATE runs SET coordination_json = ? WHERE id = ?").run(JSON.stringify(coordination ?? null), runId);
  }

  saveRunArtifacts(runId: string, artifacts: unknown[]): void {
    this.db.prepare("UPDATE runs SET artifacts_json = ? WHERE id = ?").run(JSON.stringify(artifacts ?? []), runId);
  }

  saveRunCost(runId: string, cost: unknown): void {
    this.db.prepare("UPDATE runs SET cost_json = ? WHERE id = ?").run(JSON.stringify(cost ?? null), runId);
  }

  /** 供领域模块（中转站/工作流等）加密短文本用。 */
  encryptSecret(plain: string): string {
    return encrypt(this.paths, plain);
  }

  decryptSecret(payload: string): string {
    return decrypt(this.paths, payload);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ credentials ------------------------------ */

  listCredentialRows(provider?: ProviderId): CredentialRow[] {
    const sql = provider
      ? "SELECT * FROM credentials WHERE provider = ? ORDER BY updated_at DESC"
      : "SELECT * FROM credentials ORDER BY updated_at DESC";
    const rows = provider
      ? (this.db.prepare(sql).all(provider) as unknown as CredentialRow[])
      : (this.db.prepare(sql).all() as unknown as CredentialRow[]);
    return rows;
  }

  getCredentialRow(id: string): CredentialRow | undefined {
    return this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as unknown as
      | CredentialRow
      | undefined;
  }

  insertCredential(input: {
    id: string;
    credential: Credential;
    source: CredentialSource;
    label: string;
    accountLabel?: string;
    healthy?: boolean;
    detail?: string;
  }): StoredCredential {
    const now = Date.now();
    const payload = encrypt(this.paths, JSON.stringify(input.credential));
    this.db
      .prepare(
        `INSERT INTO credentials (id, provider, mode, source, label, account_label, payload, created_at, updated_at, healthy, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.credential.provider,
        input.credential.mode,
        input.source,
        input.label,
        input.accountLabel ?? null,
        payload,
        now,
        now,
        input.healthy === false ? 0 : 1,
        input.detail ?? null,
      );
    return this.toStored(this.getCredentialRow(input.id)!);
  }

  updateCredentialPayload(id: string, credential: Credential, extra?: { healthy?: boolean; detail?: string }): void {
    const payload = encrypt(this.paths, JSON.stringify(credential));
    this.db
      .prepare("UPDATE credentials SET payload = ?, updated_at = ?, healthy = COALESCE(?, healthy), detail = COALESCE(?, detail) WHERE id = ?")
      .run(
        payload,
        Date.now(),
        extra?.healthy === undefined ? null : extra.healthy ? 1 : 0,
        extra?.detail ?? null,
        id,
      );
  }

  /**
   * 只更新健康状态 / 详情。
   *
   * 与 updateCredentialPayload 的区别：detail 传 undefined 会**清空**旧的错误详情
   * （重新导入并校验通过后，不能还留着上一次的「已过期」）。
   */
  setCredentialHealth(id: string, health: { healthy?: boolean; detail?: string }): void {
    this.db
      .prepare("UPDATE credentials SET healthy = COALESCE(?, healthy), detail = ?, updated_at = ? WHERE id = ?")
      .run(
        health.healthy === undefined ? null : health.healthy ? 1 : 0,
        health.detail ?? null,
        Date.now(),
        id,
      );
  }

  deleteCredential(id: string): boolean {
    const res = this.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  decryptedCredential(row: CredentialRow): Credential {
    const json = decrypt(this.paths, row.payload);
    const cred = JSON.parse(json) as Credential;
    return {
      ...cred,
      provider: row.provider,
      mode: row.mode,
      source: row.source,
    };
  }

  toStored(row: CredentialRow): StoredCredential {
    return {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      source: row.source,
      label: row.label ?? "",
      accountLabel: row.account_label ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      healthy: row.healthy === 1,
      detail: row.detail ?? undefined,
    };
  }

  /* --------------------------------- runs --------------------------------- */

  insertRun(shape: RunRowShape, extra?: { participantsJson?: string }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, command, mode, status, created_at, finished_at, final_text, error,
           options_json, participants_json, results_json, usage_json, thread_id, round_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        shape.id,
        shape.command,
        shape.mode,
        shape.status,
        shape.createdAt,
        shape.finishedAt ?? null,
        shape.finalText,
        shape.error ?? null,
        shape.optionsJson ?? null,
        extra?.participantsJson ?? shape.participantsJson ?? null,
        shape.resultsJson ?? null,
        shape.usage ? JSON.stringify(shape.usage) : null,
        shape.threadId ?? null,
        shape.round ?? null,
      );
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: "running" | "done" | "error";
      finishedAt: number;
      finalText: string;
      error: string;
      resultsJson: string;
      usage: Usage;
    }>,
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.finishedAt !== undefined) {
      sets.push("finished_at = ?");
      values.push(patch.finishedAt);
    }
    if (patch.finalText !== undefined) {
      sets.push("final_text = ?");
      values.push(patch.finalText);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      values.push(patch.error);
    }
    if (patch.resultsJson !== undefined) {
      sets.push("results_json = ?");
      values.push(patch.resultsJson);
    }
    if (patch.usage !== undefined) {
      sets.push("usage_json = ?");
      values.push(JSON.stringify(patch.usage));
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  getRunRow(id: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as RunRow | undefined;
  }

  listRunRows(limit: number): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, limit))) as unknown as RunRow[];
  }

  /** 一条工作（多轮对话）内的全部运行，按轮次升序；兼容 v0.0.2 没有 thread_id 的首轮。 */
  getThreadRunRows(threadId: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE thread_id = ? OR (thread_id IS NULL AND id = ?)
         ORDER BY COALESCE(round_index, 1) ASC, created_at ASC`,
      )
      .all(threadId, threadId) as unknown as RunRow[];
  }

  /** 把首轮（v0.0.2 历史运行）归入它自己所属的工作，并补齐轮次。 */
  setRunThread(runId: string, threadId: string, round: number): void {
    this.db
      .prepare("UPDATE runs SET thread_id = ?, round_index = ? WHERE id = ? AND (thread_id IS NULL OR round_index IS NULL)")
      .run(threadId, round, runId);
  }

  /* ------------------------------ thread metadata ------------------------- */

  getThreadMeta(threadId: string): ThreadMetaRow | undefined {
    return this.db.prepare("SELECT * FROM thread_meta WHERE thread_id = ?").get(threadId) as unknown as
      | ThreadMetaRow
      | undefined;
  }

  listThreadMetas(): ThreadMetaRow[] {
    return this.db.prepare("SELECT * FROM thread_meta").all() as unknown as ThreadMetaRow[];
  }

  ensureThreadMeta(threadId: string, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO thread_meta (thread_id, archived, deleted_at, parent_thread_id, branched_from_run_id, memory,
           memory_updated_at, created_at, updated_at)
         VALUES (?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`,
      )
      .run(threadId, at, at);
  }

  updateThreadMeta(threadId: string, patch: ThreadMetaPatch): void {
    this.ensureThreadMeta(threadId);
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [Date.now()];
    if (patch.archived !== undefined) {
      sets.push("archived = ?");
      values.push(patch.archived ? 1 : 0);
    }
    if (patch.deletedAt !== undefined) {
      sets.push("deleted_at = ?");
      values.push(patch.deletedAt);
    }
    if (patch.parentThreadId !== undefined) {
      sets.push("parent_thread_id = ?");
      values.push(patch.parentThreadId);
    }
    if (patch.branchedFromRunId !== undefined) {
      sets.push("branched_from_run_id = ?");
      values.push(patch.branchedFromRunId);
    }
    if (patch.memory !== undefined) {
      sets.push("memory = ?", "memory_updated_at = ?");
      values.push(patch.memory, patch.memory ? Date.now() : null);
    }
    values.push(threadId);
    this.db.prepare(`UPDATE thread_meta SET ${sets.join(", ")} WHERE thread_id = ?`).run(...values);
  }

  /** 复制一条运行到新工作（分支）；保留内容/结果/usage/产物等。 */
  copyRunRow(row: RunRow, newId: string, newThreadId: string, artifactsJson?: string | null): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, command, mode, status, created_at, finished_at, final_text, error,
           options_json, participants_json, results_json, usage_json, artifacts_json, cost_json,
           coordination_json, guard_json, attachments_json, thread_id, round_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId,
        row.command,
        row.mode,
        row.status,
        row.created_at,
        row.finished_at,
        row.final_text,
        row.error,
        row.options_json,
        row.participants_json,
        row.results_json,
        row.usage_json,
        artifactsJson === undefined ? row.artifacts_json : artifactsJson,
        row.cost_json,
        row.coordination_json,
        row.guard_json,
        row.attachments_json,
        newThreadId,
        row.round_index ?? 1,
      );
  }

  countRuns(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  appendEvent(runId: string, event: RunEvent): number {
    const at = "at" in event && typeof event.at === "number" ? event.at : Date.now();
    const res = this.db
      .prepare("INSERT INTO run_events (run_id, at, payload) VALUES (?, ?, ?)")
      .run(runId, at, JSON.stringify(event));
    return Number(res.lastInsertRowid);
  }

  eventsAfter(runId: string, afterSeq: number, limit = 5000): Array<{ seq: number; event: RunEvent }> {
    const rows = this.db
      .prepare("SELECT seq, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(runId, afterSeq, limit) as unknown as Array<{ seq: number; payload: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), event: JSON.parse(r.payload) as RunEvent }));
  }

  runRowToShape(row: RunRow): RunRowShape {
    let usage: Usage | undefined;
    if (row.usage_json) {
      try {
        usage = JSON.parse(row.usage_json) as Usage;
      } catch {
        usage = undefined;
      }
    }
    return {
      id: row.id,
      command: row.command,
      mode: row.mode,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at ?? undefined,
      finalText: row.final_text ?? "",
      error: row.error ?? undefined,
      optionsJson: row.options_json ?? undefined,
      participantsJson: row.participants_json ?? undefined,
      resultsJson: row.results_json ?? undefined,
      usage,
      threadId: row.thread_id ?? undefined,
      round: row.round_index ?? undefined,
    };
  }
}
