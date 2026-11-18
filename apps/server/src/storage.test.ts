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
