/**
 * 记忆库测试（node:test）：node:sqlite + FTS5（CJK 按字切分）+ LIKE 兜底。
 * 覆盖：建表/默认空间、CRUD、中文搜索、禁用不召回、排序、markUsed、stats、
 * 空间删除语义、importSeed 去重、exportSeed 往返、文件库持久化、buildMemoryContext 截断。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DshMemorySeed } from "@super-work/core";
import {
  BUILTIN_MEMORIES,
  DEFAULT_SPACE_ID,
  DEFAULT_SPACE_NAME,
  MemoryStore,
  buildMemoryContext,
} from "./index.js";

function newStore(options: { builtins?: boolean; fts?: boolean } = {}): MemoryStore {
  const store = new MemoryStore(":memory:", { fts: options.fts });
  store.init({ builtins: options.builtins ?? false });
  return store;
}

test("init：建表 + 默认空间（默认不播种，可显式开启；可重入）", () => {
  const store = new MemoryStore(":memory:");
  store.init();

  const spaces = store.spaces();
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]?.id, DEFAULT_SPACE_ID);
  assert.equal(spaces[0]?.name, DEFAULT_SPACE_NAME);
  assert.equal(store.list().length, 0, "默认不写内置示例，避免挡住 server 首次导入 DSH 种子");

  const seededCount = store.initBuiltins();
  assert.equal(seededCount, BUILTIN_MEMORIES.length);
  const seeded = store.list();
  assert.ok(seeded.length >= 3);
  assert.ok(seeded.every((entry) => entry.spaceId === DEFAULT_SPACE_ID));
  assert.equal(store.initBuiltins(), 0, "再次播种不重复写入");

  store.init();
  assert.equal(store.spaces().length, 1, "init 幂等");
  assert.equal(store.list().length, seeded.length);
  store.close();

  const explicit = new MemoryStore(":memory:");
  explicit.init({ builtins: true });
  assert.equal(explicit.list().length, BUILTIN_MEMORIES.length, "builtins=true 时播种");
  explicit.close();

  const quiet = new MemoryStore(":memory:");
  quiet.init({ builtins: false });
  assert.equal(quiet.list().length, 0, "builtins=false 不播种");
  quiet.close();
});

test("CRUD：空间、条目、更新、列表过滤与删除", () => {
  const store = newStore();

  const work = store.createSpace("工作", "工作相关记忆");
  assert.equal(work.name, "工作");
  assert.equal(work.description, "工作相关记忆");
  assert.throws(() => store.createSpace("工作"), /已存在/);
  assert.throws(() => store.createSpace("  "), /名称/);

  const entry = store.add({
    content: "  项目用 pnpm workspace  ",
    kind: "fact",
    importance: 9,
    tags: ["dev", " ", "dev"],
  });
  assert.equal(entry.content, "项目用 pnpm workspace", "内容去首尾空白");
  assert.equal(entry.importance, 5, "importance 夹到 1~5");
  assert.deepEqual(entry.tags, ["dev"], "tags 去空去重");
  assert.equal(entry.spaceId, DEFAULT_SPACE_ID);
  assert.equal(entry.source, "user");
  assert.equal(entry.enabled, true);
  assert.equal(entry.useCount, 0);
  assert.ok(entry.createdAt > 0);

  const inWork = store.add({ content: "工作记忆一条", spaceId: work.id });
  assert.equal(inWork.spaceId, work.id);
  const byParam = store.add({ content: "显式空间参数" }, work.id);
  assert.equal(byParam.spaceId, work.id, "spaceId 参数优先");
  assert.throws(() => store.add({ content: "   " }), /内容/);
  assert.throws(() => store.add({ content: "x" }, "missing-space"), /空间/);

  const updated = store.update(entry.id, {
    content: "项目用 pnpm",
    kind: "decision",
    importance: 2,
    tags: ["dev", "ts"],
    enabled: false,
    spaceId: work.id,
  });
  assert.equal(updated?.content, "项目用 pnpm");
  assert.equal(updated?.kind, "decision");
  assert.equal(updated?.importance, 2);
  assert.deepEqual(updated?.tags, ["dev", "ts"]);
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.spaceId, work.id);
  assert.equal(store.update("missing", { content: "x" }), undefined);
  assert.throws(() => store.update(inWork.id, { spaceId: "missing-space" }), /空间/);

  assert.equal(store.list().length, 3);
  assert.deepEqual(
    store.list({ spaceId: work.id }).map((item) => item.id).sort(),
    [entry.id, inWork.id, byParam.id].sort(),
  );
  assert.deepEqual(store.list({ enabled: false }).map((item) => item.id), [entry.id]);
  assert.deepEqual(store.list({ kind: "decision" }).map((item) => item.id), [entry.id]);
  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 2, offset: 2 }).length, 1);
  assert.equal(store.list()[0]?.id, byParam.id, "按创建时间倒序");

  assert.equal(store.spaces().find((space) => space.id === work.id)?.count, 3);

  const renamed = store.updateSpace(work.id, { name: "工作区", description: "新描述" });
  assert.equal(renamed?.name, "工作区");
  assert.equal(renamed?.description, "新描述");
  assert.equal(store.updateSpace("missing", { name: "x" }), undefined);
  assert.throws(() => store.updateSpace(work.id, { name: "默认空间" }), /已存在/);

  assert.equal(store.remove(inWork.id), true);
  assert.equal(store.remove(inWork.id), false);
  assert.equal(store.list().length, 2);
  store.close();
});

test("deleteSpace：迁移到默认空间 / 一并删除 / 默认空间不可删", () => {
  const store = newStore();

  const temp = store.createSpace("临时");
  const moved = store.add({ content: "迁移到默认空间的记忆" }, temp.id);
  assert.equal(store.deleteSpace(temp.id), true);
  assert.equal(store.spaces().some((space) => space.id === temp.id), false);
  assert.deepEqual(
    store.list({ spaceId: DEFAULT_SPACE_ID }).map((item) => item.id),
    [moved.id],
    "默认迁移语义：记忆进默认空间",
  );

  const blast = store.createSpace("爆破");
  const gone = store.add({ content: "一并删除的记忆" }, blast.id);
  assert.equal(store.deleteSpace(blast.id, { mode: "cascade" }), true);
  assert.equal(store.list().some((item) => item.id === gone.id), false, "cascade 一并删除");

  assert.equal(store.deleteSpace(DEFAULT_SPACE_ID), false, "默认空间不可删除");
  assert.equal(store.deleteSpace("missing"), false);
  store.close();
});

test("search：中文按字短语命中，英文命中，空查询不返回", () => {
  const store = newStore();
  const cjk = store.add({ content: "记忆系统支持中文检索", kind: "fact" });
  const workflow = store.add({ content: "工作流按并行组执行", kind: "fact" });
  const english = store.add({ content: "The memory store uses FTS5 index", kind: "fact" });

  assert.deepEqual(store.search("记忆").map((hit) => hit.memory.id), [cjk.id]);
  assert.deepEqual(store.search("中文检索").map((hit) => hit.memory.id), [cjk.id], "多字中文短语");
  assert.deepEqual(store.search("并行组").map((hit) => hit.memory.id), [workflow.id]);
  assert.deepEqual(store.search("FTS5").map((hit) => hit.memory.id), [english.id]);
  assert.deepEqual(store.search("index").map((hit) => hit.memory.id), [english.id]);
  assert.deepEqual(store.search("   "), []);
  assert.deepEqual(store.search("完全不存在的词"), []);
  assert.ok((store.search("记忆")[0]?.score ?? 0) > 0);
  assert.equal(store.search("记忆", 0).length, 0, "limit=0 不返回");

  store.update(cjk.id, { enabled: false });
  assert.deepEqual(store.search("记忆"), [], "禁用条目不再召回");
  assert.equal(store.list({ enabled: false }).length, 1);
  store.close();
});


test("search：长中文命令按片段召回（server 召回会传整句命令）", () => {
  const store = newStore();
  const target = store.add({ content: "用户偏好用中文写周报，每周五提交", kind: "preference" });
  store.add({ content: "与周报流程无关的杂项" });

  const hits = store.search("帮我用中文写一份这周的周报");
  assert.ok(
    hits.some((hit) => hit.memory.id === target.id),
    `长命令应能按片段召回，实际命中 ${hits.length} 条`,
  );
  store.close();
});

test("search：相关度 + importance 排序；命中不自动 markUsed", () => {
  const store = newStore();
  const low = store.add({ content: "记忆排序测试", importance: 2 });
  const high = store.add({ content: "记忆排序测试", importance: 5 });

  const hits = store.search("记忆排序");
  assert.deepEqual(hits.map((hit) => hit.memory.id), [high.id, low.id], "同相关度时 importance 高者在前");
  assert.ok(hits[0]!.score > hits[1]!.score);
  assert.equal(hits[0]!.memory.useCount, 0, "搜索不自动 markUsed");

  store.markUsed([high.id]);
  let after = store.list().find((entry) => entry.id === high.id);
  assert.equal(after?.useCount, 1);
  assert.ok((after?.lastUsedAt ?? 0) > 0);

  store.markUsed([high.id, "missing"]);
  after = store.list().find((entry) => entry.id === high.id);
  assert.equal(after?.useCount, 2);
  store.close();
});

test("stats：总数 / 启用数 / 按类型 / 空间计数 / lastUsedAt", () => {
  const store = newStore();
  store.add({ content: "事实一条", kind: "fact" });
  store.add({ content: "偏好一条", kind: "preference" });
  const off = store.add({ content: "决策一条", kind: "decision" });
  store.update(off.id, { enabled: false });
  store.markUsed([off.id]);

  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.enabled, 2);
  assert.deepEqual(stats.byKind, { fact: 1, preference: 1, decision: 1, insight: 0 });
  assert.equal(stats.spaces.length, 1);
  assert.equal(stats.spaces[0]?.count, 3);
  assert.ok((stats.lastUsedAt ?? 0) > 0);
  store.close();
});

test("importSeed：hash 去重、自动建空间、exportSeed 往返", () => {
  const store = newStore();
  const seed: DshMemorySeed = {
    version: 1,
    exportedAt: 1,
    memories: [
      { kind: "fact", content: "第一条种子记忆", tags: ["seed"], importance: 4 },
      { kind: "preference", content: "第二条种子记忆", space: "工作" },
    ],
  };

  assert.equal(store.importSeed(seed), 2);
  assert.ok(store.spaces().some((space) => space.name === "工作"), "space 名不存在则创建");
  assert.equal(store.list().every((entry) => entry.source === "import"), true);
  assert.equal(store.importSeed(seed), 0, "重复导入不新增");
  assert.equal(
    store.importSeed({ ...seed, memories: [{ kind: "fact", content: "  第一条种子记忆  " }] }),
    0,
    "内容归一化后 hash 相同",
  );

  const exported = store.exportSeed();
  assert.equal(exported.version, 1);
  assert.equal(exported.memories.length, 2);
  assert.ok(exported.exportedAt > 0);

  const target = new MemoryStore(":memory:");
  target.init({ builtins: false });
  assert.equal(target.importSeed(exported), 2, "导出后可完整导入到新库");
  assert.equal(target.importSeed(exported), 0);
  target.close();
  store.close();
});

test("buildMemoryContext：中文注入文本、kind 标注、空输入、~1200 字截断", () => {
  const store = newStore();
  store.add({ content: "用户偏好用中文回答", kind: "preference", importance: 5 });
  store.add({ content: "项目根目录是 /Users/zp/GZT/super-work", kind: "fact" });

  const hits = store.search("中文");
  const context = buildMemoryContext(hits);
  assert.ok(context.includes("相关记忆"), context);
  assert.ok(context.includes("[偏好]"), context);
  assert.ok(context.includes("用户偏好用中文回答"), context);
  assert.equal(buildMemoryContext([]), "");

  for (let index = 0; index < 40; index += 1) {
    store.add({ content: `第 ${index} 条：${"记忆内容".repeat(60)}` });
  }
  const many = store.search("记忆", 40);
  assert.ok(many.length >= 10, `期望多条命中，实际 ${many.length}`);

  const full = buildMemoryContext(many);
  assert.ok(full.length <= 1200, `默认上限 ~1200 字，实际 ${full.length}`);
  assert.ok(full.endsWith("…"), "超限时追加省略号");
  assert.ok(full.includes("[事实]"), "截断后仍带 kind 标注");

  const small = buildMemoryContext(many, 100);
  assert.ok(small.length <= 100, `自定义上限生效，实际 ${small.length}`);
  assert.equal(buildMemoryContext(many, 0), "");
  store.close();
});

test("FTS 不可用时的 LIKE 兜底：中文仍可搜、禁用仍不召回", () => {
  const store = newStore({ fts: false });
  const hit = store.add({ content: "没有 FTS 也能中文搜索" });
  const other = store.add({ content: "不相干的内容" });

  assert.deepEqual(store.search("中文搜索").map((item) => item.memory.id), [hit.id]);
  assert.deepEqual(store.search("完全不存在"), []);
  assert.equal(store.search("不相干").length, 1);
  assert.ok(other.id);

  store.update(hit.id, { enabled: false });
  assert.deepEqual(store.search("中文搜索"), [], "LIKE 兜底也只返回启用条目");
  store.close();
});

test("文件库持久化：关闭后重开，条目与搜索都在", () => {
  const dir = mkdtempSync(join(tmpdir(), "super-work-memory-"));
  try {
    const file = join(dir, "memory.db");
    const store = new MemoryStore(file);
    store.init({ builtins: false });
    const entry = store.add({ content: "持久化记忆", kind: "decision" });
    store.close();

    const reopened = new MemoryStore(file);
    reopened.init({ builtins: false });
    assert.deepEqual(reopened.list().map((item) => item.id), [entry.id]);
    assert.deepEqual(reopened.search("持久化").map((hit) => hit.memory.id), [entry.id]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
