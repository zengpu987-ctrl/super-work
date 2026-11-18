/**
 * @super-work/memory —— Super Work 记忆库（v0.0.2）。
 *
 * 存储：Node 内置 `node:sqlite`（无第三方依赖）。
 * 检索：FTS5（`unicode61`）——把 CJK 逐字切开建索引，查询时用「逐字短语」
 *       命中；同时始终合并 LIKE 兜底，最后按「相关度 + importance」排序。
 *       若当前 SQLite 不支持 FTS5，自动退化为纯 LIKE。
 *
 * 契约见 docs/DESIGN-v0.0.2.md §5 / packages/core/src/memory.ts。
 * 语义约定（本包实现并测试）：
 * - 默认空间 id=`default`、名称=`默认空间`，不可删除（返回 false）。
 * - `init()` 默认**不**写内置示例记忆（避免挡住 server 首次启动导入 DSH 种子）；
 *   需要示例数据时显式调用 `init({ builtins: true })` 或 `initBuiltins()`。
 * - `deleteSpace(id)` 默认把该空间的记忆迁移到默认空间；传 `{ mode: "cascade" }` 一并删除。
 * - `search()` 只返回 `enabled=1` 的条目，且**不会**自动 `markUsed`。
 * - `importSeed()` 按「content 归一化（去首尾空白 + 折叠空白）」的 sha256 去重，Space 名不存在则创建。
 * - `stats().byKind` 统计全部条目（含禁用），与 `total` 口径一致。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_KIND_LABEL } from "@super-work/core";
import type {
  DshMemorySeed,
  MemoryCreateRequest,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemorySpace,
  MemoryStats,
  MemoryUpdateRequest,
} from "@super-work/core";

export type {
  DshMemorySeed,
  MemoryCreateRequest,
  MemoryEntry,
  MemoryHit,
  MemoryKind,
  MemorySpace,
  MemoryStats,
  MemoryUpdateRequest,
} from "@super-work/core";

/** 默认空间 id（server 与测试都用它）。 */
export const DEFAULT_SPACE_ID = "default";
/** 默认空间名称。 */
export const DEFAULT_SPACE_NAME = "默认空间";
/** buildMemoryContext 默认注入上限（字符数）。 */
export const MEMORY_CONTEXT_LIMIT = 1200;

/** 内置示例记忆：首次 init 时写入（可关闭），之后可作为用户删除/改写。 */
export const BUILTIN_MEMORIES: ReadonlyArray<
  Required<Pick<MemoryCreateRequest, "kind" | "content" | "tags" | "importance">>
> = [
  {
    kind: "preference",
    content: "回答与界面文案统一使用简体中文，专业术语保留英文原名（如 FTS5、token）。",
    tags: ["偏好", "语言"],
    importance: 4,
  },
  {
    kind: "decision",
    content: "只调用用户在本次运行中明确勾选的模型；未选中的角色一次也不调用。",
    tags: ["决策", "编排"],
    importance: 5,
  },
  {
    kind: "fact",
    content: "Super Work 的构建命令是 pnpm build，测试命令是 pnpm test，全量构建是 pnpm build:all。",
    tags: ["事实", "命令"],
    importance: 3,
  },
];

const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "preference", "decision", "insight"];
const SOURCES = ["user", "auto", "import"] as const;
type MemorySource = (typeof SOURCES)[number];

type Row = Record<string, unknown>;

/** createSpace/updateSpace 的补丁（core 未单列类型）。 */
export interface MemorySpacePatch {
  name?: string;
  description?: string;
}

/** deleteSpace 的可选语义。 */
export interface DeleteSpaceOptions {
  /** migrate（默认）：记忆迁移到默认空间；cascade：记忆一并删除。 */
  mode?: "migrate" | "cascade";
}

export interface MemoryStoreOptions {
  /** 测试/降级用：false 时强制只用 LIKE（不建 FTS 表）。 */
  fts?: boolean;
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
}

function normalizeContent(content: unknown): string {
  return str(content).replace(/\s+/g, " ").trim();
}

/** 去重用的 content hash（归一化后 sha256）。 */
export function contentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content), "utf8").digest("hex");
}

function normalizeKind(value: unknown): MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind) ? (value as MemoryKind) : "fact";
}

function normalizeSource(value: unknown): MemorySource {
  return SOURCES.includes(value as MemorySource) ? (value as MemorySource) : "user";
}

function clampImportance(value: unknown): number {
  const parsed = Math.round(num(value, 3));
  return Math.min(5, Math.max(1, parsed));
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const text = str(tag).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return normalizeTags(raw);
  const text = str(raw).trim();
  if (!text) return [];
  try {
    return normalizeTags(JSON.parse(text));
  } catch {
    return [];
  }
}

/** 建 FTS 索引用的文本：把每个 CJK 字符用空格隔开，使其成为独立 token。 */
function toIndexText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += isCjk(code) ? ` ${char} ` : char;
  }
  return out.replace(/\s+/g, " ").trim();
}

interface QueryTokens {
  /** 交给 FTS5 的 token：CJK 连续串会成为「逐字空格」短语，英文按词。 */
  fts: string[];
  /** 放宽检索用：长 CJK 串拆成重叠二元组，便于整句命令按片段召回。 */
  relaxed: string[];
  /** 交给 LIKE 的原始片段。 */
  like: string[];
}

/** 整句命令兜底召回用的二元组长度阈值（不超过它的 CJK 串保持整串短语）。 */
const RELAXED_CJK_THRESHOLD = 4;

function tokenizeQuery(query: string): QueryTokens {
  const fts: string[] = [];
  const relaxed: string[] = [];
  const like: string[] = [];
  let cjkRun = "";
  let word = "";

  const flushCjk = (): void => {
    if (!cjkRun) return;
    const chars = [...cjkRun];
    fts.push(chars.join(" "));
    relaxed.push(chars.join(" "));
    like.push(cjkRun);
    if (chars.length > RELAXED_CJK_THRESHOLD) {
      // 长句（server 会用整条命令做召回）→ 补重叠二元组，OR 检索时才可能命中片段。
      for (let index = 0; index + 1 < chars.length; index += 1) {
        relaxed.push(`${chars[index]} ${chars[index + 1]}`);
      }
    }
    cjkRun = "";
  };
  const flushWord = (): void => {
    if (!word) return;
    fts.push(word);
    relaxed.push(word);
    like.push(word);
    word = "";
  };

  for (const char of query) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjk(code)) {
      flushWord();
      cjkRun += char;
    } else if (/[\p{L}\p{N}_]/u.test(char)) {
      flushCjk();
      word += char;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();

  const unique = (items: string[]): string[] => [...new Set(items.filter(Boolean))];
  return { fts: unique(fts), relaxed: unique(relaxed), like: unique(like) };
}

/** 把 token 拼成 FTS5 查询（全部加引号，避免特殊字符注入语法）。 */
function buildFtsQuery(tokens: string[], operator: "AND" | "OR"): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(` ${operator} `);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/** 截断到最多 limit 个字符（按码点，附省略号）。 */
function truncateChars(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit <= 1) return "…";
  return `${chars.slice(0, limit - 1).join("")}…`;
}

function rowToEntry(row: Row): MemoryEntry {
  const lastUsedAt = row.last_used_at == null ? undefined : num(row.last_used_at);
  return {
    id: str(row.id),
    spaceId: str(row.space_id),
    kind: normalizeKind(row.kind),
    content: str(row.content),
    tags: parseTags(row.tags),
    importance: clampImportance(row.importance),
    source: normalizeSource(row.source),
    enabled: num(row.enabled) === 1,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    lastUsedAt,
    useCount: num(row.use_count),
  };
}

function rowToSpace(row: Row): MemorySpace {
  const space: MemorySpace = {
    id: str(row.id),
    name: str(row.name),
    description: str(row.description),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
  if (row.memory_count != null) space.count = num(row.memory_count);
  return space;
}

/* ------------------------------------------------------------------ *
 * MemoryStore
 * ------------------------------------------------------------------ */

export class MemoryStore {
  private readonly dbFile: string;
  private readonly db: DatabaseSync;
  private readonly ftsRequested: boolean;
  private ftsEnabled = false;
  private ready = false;

  constructor(dbFile: string, options: MemoryStoreOptions = {}) {
    this.dbFile = dbFile;
    this.ftsRequested = options.fts !== false;
    if (dbFile !== ":memory:" && !dbFile.startsWith("file:")) {
      mkdirSync(dirname(resolve(dbFile)), { recursive: true });
    }
    this.db = new DatabaseSync(dbFile, { enableForeignKeyConstraints: true });
  }

  /**
   * 建表 + 默认空间。可重复调用（幂等）。
   * `builtins: true` 时同时播种内置示例记忆（默认关闭，server 首次启动靠 `stats().total === 0`
   * 判断是否导入 DSH 记忆种子，不能被示例数据挡住）。
   */
  init(options: { builtins?: boolean } = {}): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        importance INTEGER NOT NULL DEFAULT 3,
        source TEXT NOT NULL DEFAULT 'user',
        enabled INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_id);
      CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
      CREATE INDEX IF NOT EXISTS idx_memories_enabled ON memories(enabled);
    `);

    if (this.ftsRequested) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            memory_id UNINDEXED,
            content,
            tags,
            tokenize = 'unicode61'
          );
        `);
        this.ftsEnabled = true;
      } catch {
        // 当前 SQLite 不支持 FTS5：退化为纯 LIKE。
        this.ftsEnabled = false;
      }
    } else {
      this.ftsEnabled = false;
    }

    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id FROM memory_spaces WHERE id = ?")
      .get(DEFAULT_SPACE_ID);
    if (!existing) {
      try {
        this.db
          .prepare(
            "INSERT INTO memory_spaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, "默认记忆空间", now, now);
      } catch (error) {
        throw new Error(
          `默认记忆空间创建失败（数据库中可能已有同名空间）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.ready = true;
    if (this.ftsEnabled) this.rebuildFts();
    if (options.builtins === true) this.initBuiltins();
  }

  /** 播种内置示例记忆（按 content hash 去重），返回新增条数。 */
  initBuiltins(): number {
    this.ensureReady();
    return this.tx(() => {
      let added = 0;
      const insert = this.insertStatement();
      const exists = this.db.prepare("SELECT id FROM memories WHERE content_hash = ? LIMIT 1");
      const now = Date.now();
      for (const seed of BUILTIN_MEMORIES) {
        const content = normalizeContent(seed.content);
        const hash = contentHash(content);
        if (exists.get(hash)) continue;
        const id = randomUUID();
        insert.run(
          id,
          DEFAULT_SPACE_ID,
          seed.kind,
          content,
          JSON.stringify(normalizeTags(seed.tags)),
          clampImportance(seed.importance),
          "user",
          1,
          hash,
          now,
          now,
        );
        this.syncFts(id, content, normalizeTags(seed.tags));
        added += 1;
      }
      return added;
    });
  }

  /* ---------------------------- 空间 ---------------------------- */

  spaces(): MemorySpace[] {
    this.ensureReady();
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM memories m WHERE m.space_id = s.id) AS memory_count
         FROM memory_spaces s
         ORDER BY s.created_at ASC, s.rowid ASC`,
      )
      .all() as Row[];
    return rows.map(rowToSpace);
  }

  createSpace(name: string, description = ""): MemorySpace {
    this.ensureReady();
    const trimmed = str(name).trim();
    if (!trimmed) throw new Error("空间名称不能为空");
    if (this.findSpaceByName(trimmed)) throw new Error(`空间「${trimmed}」已存在`);
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO memory_spaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, trimmed, str(description).trim(), now, now);
    return { id, name: trimmed, description: str(description).trim(), createdAt: now, updatedAt: now, count: 0 };
  }

  updateSpace(id: string, patch: MemorySpacePatch): MemorySpace | undefined {
    this.ensureReady();
    const current = this.getSpace(id);
    if (!current) return undefined;
    let name = current.name;
    if (patch.name !== undefined) {
      const trimmed = str(patch.name).trim();
      if (!trimmed) throw new Error("空间名称不能为空");
      const sameName = this.findSpaceByName(trimmed);
      if (sameName && sameName.id !== id) throw new Error(`空间「${trimmed}」已存在`);
      name = trimmed;
    }
    const description = patch.description === undefined ? current.description : str(patch.description).trim();
    this.db
      .prepare("UPDATE memory_spaces SET name = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(name, description, Date.now(), id);
    return this.getSpace(id);
  }

  /**
   * 删除空间。默认 `migrate`：把该空间的记忆迁到默认空间；`cascade`：记忆一并删除。
   * 默认空间不可删除，返回 false 表示未删除。
   */
  deleteSpace(id: string, options: DeleteSpaceOptions = {}): boolean {
    this.ensureReady();
    if (id === DEFAULT_SPACE_ID) return false;
    if (!this.getSpace(id)) return false;
    const mode = options.mode === "cascade" ? "cascade" : "migrate";
    return this.tx(() => {
      if (mode === "cascade") {
        const ids = this.db.prepare("SELECT id FROM memories WHERE space_id = ?").all(id) as Row[];
        const delFts = this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
        for (const row of ids) if (this.ftsEnabled) delFts.run(str(row.id));
        this.db.prepare("DELETE FROM memories WHERE space_id = ?").run(id);
      } else {
        this.db
          .prepare("UPDATE memories SET space_id = ?, updated_at = ? WHERE space_id = ?")
          .run(DEFAULT_SPACE_ID, Date.now(), id);
      }
      const result = this.db.prepare("DELETE FROM memory_spaces WHERE id = ?").run(id);
      return num(result.changes) > 0;
    });
  }

  /* ---------------------------- 条目 ---------------------------- */

  add(input: MemoryCreateRequest, spaceId?: string): MemoryEntry {
    this.ensureReady();
    const content = normalizeContent(input?.content);
    if (!content) throw new Error("记忆内容不能为空");
    const targetSpace = spaceId ?? input?.spaceId ?? DEFAULT_SPACE_ID;
    if (!this.getSpace(targetSpace)) throw new Error(`空间不存在：${targetSpace}`);
    const kind = normalizeKind(input?.kind);
    const tags = normalizeTags(input?.tags);
    const importance = clampImportance(input?.importance);
    const source = normalizeSource(input?.source);
    const now = Date.now();
    const id = randomUUID();
    return this.tx(() => {
      this.insertStatement().run(
        id,
        targetSpace,
        kind,
        content,
        JSON.stringify(tags),
        importance,
        source,
        1,
        contentHash(content),
        now,
        now,
      );
      this.syncFts(id, content, tags);
      return this.getEntry(id)!;
    });
  }

  update(id: string, patch: MemoryUpdateRequest): MemoryEntry | undefined {
    this.ensureReady();
    const current = this.getEntry(id);
    if (!current) return undefined;

    let content = current.content;
    if (patch.content !== undefined) {
      content = normalizeContent(patch.content);
      if (!content) throw new Error("记忆内容不能为空");
    }
    const kind = patch.kind === undefined ? current.kind : normalizeKind(patch.kind);
    const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
    const importance = patch.importance === undefined ? current.importance : clampImportance(patch.importance);
    const enabled = patch.enabled === undefined ? current.enabled : Boolean(patch.enabled);
    let spaceId = current.spaceId;
    if (patch.spaceId !== undefined) {
      if (!this.getSpace(patch.spaceId)) throw new Error(`空间不存在：${patch.spaceId}`);
      spaceId = patch.spaceId;
    }
    const now = Date.now();
    return this.tx(() => {
      this.db
        .prepare(
          `UPDATE memories
              SET space_id = ?, kind = ?, content = ?, tags = ?, importance = ?, enabled = ?,
                  content_hash = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          spaceId,
          kind,
          content,
          JSON.stringify(tags),
          importance,
          enabled ? 1 : 0,
          contentHash(content),
          now,
          id,
        );
      this.syncFts(id, content, tags);
      return this.getEntry(id);
    });
  }

  remove(id: string): boolean {
    this.ensureReady();
    return this.tx(() => {
      if (this.ftsEnabled) this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return num(result.changes) > 0;
    });
  }

  list(options: {
    spaceId?: string;
    kind?: MemoryKind;
    enabled?: boolean;
    limit?: number;
    offset?: number;
  } = {}): MemoryEntry[] {
    this.ensureReady();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.spaceId !== undefined) {
      where.push("space_id = ?");
      params.push(options.spaceId);
    }
    if (options.kind !== undefined) {
      where.push("kind = ?");
      params.push(normalizeKind(options.kind));
    }
    if (options.enabled !== undefined) {
      where.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    let sql = "SELECT * FROM memories";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC, rowid DESC";
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(options.limit)));
      const offset = typeof options.offset === "number" ? Math.max(0, Math.floor(options.offset)) : 0;
      sql += " OFFSET ?";
      params.push(offset);
    } else if (typeof options.offset === "number" && options.offset > 0) {
      sql += " LIMIT -1 OFFSET ?";
      params.push(Math.floor(options.offset));
    }
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(rowToEntry);
  }

  /**
   * 检索：FTS5 逐字短语 + LIKE 兜底合并，按「相关度 + importance」排序。
   * 只返回 enabled=1；不会自动 markUsed。
   */
  search(query: string, limit = 10): MemoryHit[] {
    this.ensureReady();
    const trimmed = str(query).replace(/\s+/g, " ").trim();
    const max = Math.floor(limit);
    if (!trimmed || !(max > 0)) return [];

    const { fts: ftsTokens, relaxed, like: likeTokens } = tokenizeQuery(trimmed);
    const candidates = new Map<string, { entry: MemoryEntry; relevance: number }>();

    if (this.ftsEnabled && ftsTokens.length) {
      const rows = this.ftsSearch(ftsTokens, relaxed, max);
      rows.forEach((row, index) => {
        const entry = rowToEntry(row.row);
        const relevance = rows.length <= 1 ? 1 : 1 - 0.3 * (index / rows.length);
        candidates.set(entry.id, { entry, relevance });
      });
    }

    // LIKE 兜底：FTS 未命中 / 未启用 / 中文短词时仍能召回。
    const patterns = [...new Set([trimmed, ...likeTokens])].slice(0, 8);
    const fetchLimit = Math.max(max * 10, 50);
    const likeStatement = this.db.prepare(
      "SELECT * FROM memories WHERE enabled = 1 AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC, rowid DESC LIMIT ?",
    );
    for (const pattern of patterns) {
      const rows = likeStatement.all(likePattern(pattern), fetchLimit) as Row[];
      for (const row of rows) {
        const entry = rowToEntry(row);
        const existing = candidates.get(entry.id);
        if (existing) {
          existing.relevance = Math.max(existing.relevance, 0.55);
        } else {
          candidates.set(entry.id, { entry, relevance: 0.55 });
        }
      }
    }

    return [...candidates.values()]
      .map(({ entry, relevance }) => ({
        memory: entry,
        score:
          Math.round((relevance * 0.75 + (entry.importance / 5) * 0.25) * 10_000) / 10_000,
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.memory.importance - a.memory.importance ||
          b.memory.createdAt - a.memory.createdAt ||
          (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0),
      )
      .slice(0, max);
  }

  /** 记录一次召回使用：useCount + 1、lastUsedAt = now。 */
  markUsed(ids: string[]): void {
    this.ensureReady();
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map((id) => str(id)).filter(Boolean))];
    if (!unique.length) return;
    const now = Date.now();
    this.tx(() => {
      const update = this.db.prepare(
        "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      for (const id of unique) update.run(now, id);
    });
  }

  stats(): MemoryStats {
    this.ensureReady();
    const totals = this.db
      .prepare("SELECT COUNT(*) AS total, SUM(enabled) AS enabled, MAX(last_used_at) AS last_used FROM memories")
      .get() as Row | undefined;
    const byKindRows = this.db
      .prepare("SELECT kind, COUNT(*) AS count FROM memories GROUP BY kind")
      .all() as Row[];
    const byKind = { fact: 0, preference: 0, decision: 0, insight: 0 } as MemoryStats["byKind"];
    for (const row of byKindRows) {
      const kind = normalizeKind(row.kind);
      byKind[kind] = num(row.count);
    }
    const spaces = this.spaces();
    const stats: MemoryStats = {
      spaces,
      total: num(totals?.total),
      enabled: num(totals?.enabled),
      byKind,
    };
    if (totals?.last_used != null) stats.lastUsedAt = num(totals.last_used);
    return stats;
  }

  /**
   * 导入 DSH 记忆种子：按 content 归一化 hash 去重（全局），space 名不存在则创建。
   * 返回新增条数。
   */
  importSeed(seed: DshMemorySeed): number {
    this.ensureReady();
    if (!seed || !Array.isArray(seed.memories)) return 0;
    const now = Date.now();
    return this.tx(() => {
      const exists = this.db.prepare("SELECT id FROM memories WHERE content_hash = ? LIMIT 1");
      const insert = this.insertStatement();
      let added = 0;
      for (const item of seed.memories) {
        const content = normalizeContent(item?.content);
        if (!content) continue;
        const hash = contentHash(content);
        if (exists.get(hash)) continue;
        const spaceName = str(item.space).trim();
        let spaceId = DEFAULT_SPACE_ID;
        if (spaceName && spaceName !== DEFAULT_SPACE_NAME) {
          const existing = this.findSpaceByName(spaceName);
          spaceId = existing ? existing.id : this.createSpace(spaceName).id;
        }
        const kind = normalizeKind(item.kind);
        const tags = normalizeTags(item.tags);
        const id = randomUUID();
        insert.run(
          id,
          spaceId,
          kind,
          content,
          JSON.stringify(tags),
          clampImportance(item.importance),
          "import",
          1,
          hash,
          now,
          now,
        );
        this.syncFts(id, content, tags);
        added += 1;
      }
      return added;
    });
  }

  /** 导出记忆种子（默认空间的条目不带 space 名，其余带上空间名）。 */
  exportSeed(): DshMemorySeed {
    this.ensureReady();
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY created_at ASC, rowid ASC")
      .all() as Row[];
    const spacesById = new Map(this.spaces().map((space) => [space.id, space.name]));
    return {
      version: 1,
      exportedAt: Date.now(),
      memories: rows.map((row) => {
        const entry = rowToEntry(row);
        const item: DshMemorySeed["memories"][number] = {
          kind: entry.kind,
          content: entry.content,
          tags: entry.tags,
          importance: entry.importance,
        };
        if (entry.spaceId !== DEFAULT_SPACE_ID) {
          const spaceName = spacesById.get(entry.spaceId);
          if (spaceName) item.space = spaceName;
        }
        return item;
      }),
    };
  }

  close(): void {
    this.ready = false;
    this.db.close();
  }

  /** 是否实际启用了 FTS5（false = 纯 LIKE 兜底）。 */
  get ftsAvailable(): boolean {
    return this.ftsEnabled;
  }

  /* ---------------------------- 内部 ---------------------------- */

  private ensureReady(): void {
    if (!this.ready) throw new Error("MemoryStore 尚未初始化：请先调用 init()");
  }

  private insertStatement() {
    return this.db.prepare(
      `INSERT INTO memories
         (id, space_id, kind, content, tags, importance, source, enabled, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  private getEntry(id: string): MemoryEntry | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  private getSpace(id: string): MemorySpace | undefined {
    const row = this.db.prepare("SELECT * FROM memory_spaces WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToSpace(row) : undefined;
  }

  private findSpaceByName(name: string): MemorySpace | undefined {
    const row = this.db.prepare("SELECT * FROM memory_spaces WHERE name = ?").get(name) as
      | Row
      | undefined;
    return row ? rowToSpace(row) : undefined;
  }

  private syncFts(id: string, content: string, tags: string[]): void {
    if (!this.ftsEnabled) return;
    this.db.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(id);
    this.db
      .prepare("INSERT INTO memories_fts (memory_id, content, tags) VALUES (?, ?, ?)")
      .run(id, toIndexText(content), toIndexText(tags.join(" ")));
  }

  private rebuildFts(): void {
    if (!this.ftsEnabled) return;
    this.db.exec("DELETE FROM memories_fts");
    const rows = this.db.prepare("SELECT id, content, tags FROM memories").all() as Row[];
    const insert = this.db.prepare("INSERT INTO memories_fts (memory_id, content, tags) VALUES (?, ?, ?)");
    for (const row of rows) {
      insert.run(
        str(row.id),
        toIndexText(str(row.content)),
        toIndexText(parseTags(row.tags).join(" ")),
      );
    }
  }

  private ftsSearch(tokens: string[], relaxed: string[], max: number): Array<{ row: Row }> {
    const fetchLimit = Math.max(max * 10, 50);
    const sql = `
      SELECT m.*, bm25(memories_fts) AS fts_rank
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.memory_id
       WHERE memories_fts MATCH ?
         AND m.enabled = 1
       ORDER BY fts_rank ASC
       LIMIT ?
    `;
    const statement = this.db.prepare(sql);
    const attempts: string[] = [
      buildFtsQuery(tokens, "AND"),
      ...(relaxed.length && relaxed.length !== tokens.length
        ? [buildFtsQuery(relaxed, "OR")]
        : [buildFtsQuery(tokens, "OR")]),
    ];
    for (const attempt of new Set(attempts)) {
      try {
        const rows = statement.all(attempt, fetchLimit) as Row[];
        if (rows.length) return rows.map((row) => ({ row }));
      } catch {
        // 查询语法/分词问题：继续尝试下一个组合，最终由 LIKE 兜底。
      }
    }
    return [];
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 回滚失败时保留原始异常。
      }
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 注入 prompt 的记忆文本
 * ------------------------------------------------------------------ */

/**
 * 把召回结果拼成注入 prompt 的中文文本：每条带 kind 标注与内容，
 * 总长按字符截断（默认 ~1200 字），超限追加省略号。
 */
export function buildMemoryContext(hits: MemoryHit[], limit = MEMORY_CONTEXT_LIMIT): string {
  const max = Math.floor(limit);
  if (!Array.isArray(hits) || !hits.length || !(max > 0)) return "";
  const lines: string[] = [`## 相关记忆（${hits.length} 条，按相关度排序）`, ""];
  hits.forEach((hit, index) => {
    const memory = hit?.memory;
    if (!memory) return;
    const label = MEMORY_KIND_LABEL[memory.kind] ?? memory.kind;
    const content = normalizeContent(memory.content);
    if (!content) return;
    lines.push(`${index + 1}. [${label}] ${content}`);
  });
  const text = lines.join("\n").trimEnd();
  return truncateChars(text, max);
}
