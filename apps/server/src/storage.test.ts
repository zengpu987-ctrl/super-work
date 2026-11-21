import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Paths } from "./config.js";
import { Storage } from "./storage.js";

function tempStorage(): { storage: Storage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "super-work-thread-"));
  const storage = new Storage({ home: dir, dbFile: path.join(dir, "test.db") } as unknown as Paths);
  return { storage, dir };
}

test("多轮对话：thread_id/round_index 落库并按轮次升序读取", () => {
  const { storage, dir } = tempStorage();
  try {
    const base = {
      command: "第一轮",
      mode: "parallel" as const,
      status: "running" as const,
      createdAt: 1_000,
      finalText: "",
    };
    storage.insertRun({ ...base, id: "run_a", threadId: "run_a", round: 1 });
    storage.insertRun({ ...base, id: "run_b", threadId: "run_a", round: 2 });
    storage.insertRun({ ...base, id: "run_c", threadId: "run_a", round: 3 });

    const rows = storage.getThreadRunRows("run_a");
    assert.deepEqual(rows.map((row) => row.id), ["run_a", "run_b", "run_c"]);
    assert.deepEqual(rows.map((row) => row.round_index), [1, 2, 3]);
    assert.equal(storage.getThreadRunRows("run_missing").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("多轮对话：v0.0.2 历史运行（无 thread_id）可被归入自己的工作", () => {
  const { storage, dir } = tempStorage();
  try {
    storage.insertRun({
      id: "run_old",
      command: "旧运行",
      mode: "parallel",
      status: "done",
      createdAt: 1_000,
      finalText: "旧答案",
    });
    const before = storage.getThreadRunRows("run_old");
    assert.equal(before.length, 1);
    assert.equal(before[0]?.thread_id ?? null, null);

    storage.setRunThread("run_old", "run_old", 1);
    storage.insertRun({
      id: "run_new",
      command: "继续",
      mode: "parallel",
      status: "running",
      createdAt: 2_000,
      finalText: "",
      threadId: "run_old",
      round: 2,
    });
    const rows = storage.getThreadRunRows("run_old");
    assert.deepEqual(rows.map((row) => row.id), ["run_old", "run_new"]);
    assert.equal(rows[0]?.thread_id, "run_old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("thread_meta：归档、记忆与分支来源可持久化", () => {
  const { storage, dir } = tempStorage();
  try {
    storage.insertRun({
      id: "run_meta",
      command: "记忆测试",
      mode: "chat",
      status: "done",
      createdAt: 1_000,
      finalText: "答案",
      threadId: "run_meta",
      round: 1,
    });
    storage.ensureThreadMeta("run_meta", 1_000);
    storage.updateThreadMeta("run_meta", { archived: true, memory: "保持简洁" });
    storage.updateThreadMeta("run_meta", {
      parentThreadId: "run_parent",
      branchedFromRunId: "run_parent_1",
    });
    const meta = storage.getThreadMeta("run_meta");
    assert.equal(meta?.archived, 1);
    assert.equal(meta?.memory, "保持简洁");
    assert.equal(meta?.parent_thread_id, "run_parent");
    assert.equal(meta?.branched_from_run_id, "run_parent_1");
    assert.ok(meta?.memory_updated_at && meta.memory_updated_at > 0);

    storage.updateThreadMeta("run_meta", { deletedAt: 2_000 });
    assert.equal(storage.getThreadMeta("run_meta")?.deleted_at, 2_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("copyRunRow：分支运行保留正文、轮次与新产物路径", () => {
  const { storage, dir } = tempStorage();
  try {
    storage.insertRun({
      id: "run_origin",
      command: "原始命令",
      mode: "parallel",
      status: "done",
      createdAt: 1_000,
      finalText: "原始答案",
      threadId: "run_origin",
      round: 2,
    });
    storage.db
      .prepare("UPDATE runs SET artifacts_json = ? WHERE id = ?")
      .run(JSON.stringify([{ id: "a", kind: "file", title: "x.md", path: "/api/artifacts/run_origin/x.md", createdAt: 1 }]), "run_origin");
    const row = storage.getRunRow("run_origin")!;
    storage.copyRunRow(row, "run_branch", "run_branch_thread", JSON.stringify([{ id: "a", kind: "file", title: "x.md", path: "/api/artifacts/run_branch/x.md", createdAt: 1 }]));
    const copy = storage.getRunRow("run_branch");
    assert.equal(copy?.command, "原始命令");
    assert.equal(copy?.final_text, "原始答案");
    assert.equal(copy?.thread_id, "run_branch_thread");
    assert.equal(copy?.round_index, 2);
    assert.match(copy?.artifacts_json ?? "", /run_branch\/x\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
