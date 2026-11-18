import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  COORD_ROLE_BY_ID,
  type AppSettings,
  type AttachmentMeta,
  type CoordinationAssignment,
  type KeywordAction,
  type KeywordHit,
  type KeywordRule,
  type PluginInfo,
  type PluginTestResult,
  type ProviderId,
  type UploadResponse,
} from "@super-work/core";
import { extractFile, makeImageThumb } from "@super-work/files";
import { scanDshPlugins, testPlugin } from "@super-work/plugins";
import type { Storage } from "./storage.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";
import type { Paths } from "./config.js";

/** 供 RunManager 只读的上传接口，避免循环依赖。 */
export interface UploadStoreLike {
  get(id: string): (AttachmentMeta & { text: string }) | undefined;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

export class UploadStore {
  private tableReady = false;

  constructor(
    private storage: Storage,
    private paths: Paths,
    private log: Logger,
  ) {
    this.storage.db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        chars INTEGER,
        text TEXT,
        preview TEXT,
        data_url TEXT,
        path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.tableReady = true;
  }

  private rowToMeta(row: {
    id: string;
    name: string;
    mime: string;
    kind: string;
    size: number;
    chars: number | null;
    preview: string | null;
    data_url: string | null;
    path: string | null;
    error: string | null;
    created_at: number;
  }): AttachmentMeta {
    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      kind: row.kind as AttachmentMeta["kind"],
      size: row.size,
      chars: row.chars ?? undefined,
      preview: row.preview ?? undefined,
      dataUrl: row.data_url ?? undefined,
      path: row.path ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }

  async save(input: { name?: string; mime?: string; size?: number; dataBase64?: string }): Promise<UploadResponse> {
    if (!this.tableReady) throw new Error("上传存储未初始化");
    const name = (input.name ?? "未命名").trim().slice(0, 200);
    const dataBase64 = input.dataBase64 ?? "";
    if (!dataBase64) throw new Error("缺少文件内容");
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length === 0) throw new Error("文件为空");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("文件超过 20MB 上限");

    const id = `up_${crypto.randomBytes(6).toString("hex")}`;
    const dir = path.join(this.paths.home, "uploads", id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeName = name.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 120) || "file";
    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, bytes, { mode: 0o600 });

    const extracted = await extractFile({
      name,
      mime: input.mime ?? "application/octet-stream",
      data: bytes,
    });
    let dataUrl: string | undefined;
    let preview = extracted.text ? extracted.text.slice(0, 500) : undefined;
    if (extracted.kind === "image") {
      try {
        const thumb = await makeImageThumb(bytes, extracted.mime);
        dataUrl = thumb.dataUrl;
      } catch (error) {
        this.log.warn("图片缩略图生成失败", { message: safeErrorMessage(error) });
      }
    }
    const meta = {
      id,
      name,
      mime: extracted.mime,
      kind: extracted.kind,
      size: bytes.length,
      chars: extracted.chars || undefined,
      preview,
      dataUrl,
      path: path.relative(this.paths.home, filePath),
      error: extracted.error,
      createdAt: Date.now(),
    };
    this.storage.db
      .prepare(
        `INSERT INTO uploads (id,name,mime,kind,size,chars,text,preview,data_url,path,error,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        meta.id,
        meta.name,
        meta.mime,
        meta.kind,
        meta.size,
        meta.chars ?? null,
        extracted.text ?? "",
        preview ?? null,
        dataUrl ?? null,
        meta.path,
        meta.error ?? null,
        meta.createdAt,
      );
    return { attachment: { ...meta, text: extracted.text?.slice(0, MAX_TEXT_CHARS) } };
  }

  get(id: string): (AttachmentMeta & { text: string }) | undefined {
    const row = this.storage.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as
      | {
          id: string;
          name: string;
          mime: string;
          kind: string;
          size: number;
          chars: number | null;
          text: string | null;
          preview: string | null;
          data_url: string | null;
          path: string | null;
          error: string | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return { ...this.rowToMeta(row), text: row.text ?? "" };
  }
}

/* -------------------------------- 关键词 -------------------------------- */

function matchKeyword(rule: KeywordRule, command: string): boolean {
  const k = rule.keyword.trim();
  if (!k) return false;
  if (rule.match === "exact") return command.trim() === k;
  if (rule.match === "regex") {
    try {
      return new RegExp(k, "i").test(command);
    } catch {
      return false;
    }
  }
  return command.toLowerCase().includes(k.toLowerCase());
}

export interface KeywordApplication {
  hits: KeywordHit[];
  mode?: import("@super-work/core").RunMode;
  effort?: import("@super-work/core").EffortLevel;
  memory?: boolean;
  cheapMode?: boolean;
  judge?: import("@super-work/core").ParticipantSpec;
  roles: CoordinationAssignment[];
}

/** 按优先级应用关键词规则：每类动作取最高优先级的一条（同优先级取先出现）。 */
export function applyKeywords(command: string, rules: KeywordRule[] | undefined): KeywordApplication {
  const enabled = (rules ?? []).filter((r) => r.enabled && r.keyword.trim());
  const matched = enabled
    .filter((r) => matchKeyword(r, command))
    .sort((a, b) => b.priority - a.priority);
  const hits: KeywordHit[] = matched.map((r) => ({
    ruleId: r.id,
    keyword: r.keyword,
    action: r.action,
    priority: r.priority,
  }));
  const out: KeywordApplication = { hits, roles: [] };
  const seen = new Set<string>();
  for (const rule of matched) {
    const type = (rule.action as KeywordAction).type;
    if (seen.has(type) && type !== "role") continue;
    seen.add(type);
    switch (rule.action.type) {
      case "mode":
        out.mode = rule.action.mode;
        break;
      case "effort":
        out.effort = rule.action.effort;
        break;
      case "memory":
        out.memory = rule.action.enabled;
        break;
      case "cheapMode":
        out.cheapMode = rule.action.enabled;
        break;
      case "judge":
        out.judge = rule.action.judge;
        break;
      case "role":
        out.roles.push({ role: rule.action.role, participants: rule.action.participants });
        break;
    }
  }
  return out;
}

/* -------------------------------- 插件 -------------------------------- */

interface PluginCache {
  at: number;
  list: PluginInfo[];
}

export class PluginService {
  private cache?: PluginCache;

  constructor(
    private storage: Storage,
    private log: Logger,
  ) {}

  async list(settings: AppSettings, force = false): Promise<PluginInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) {
      return this.mergeSettings(this.cache.list, settings);
    }
    try {
      const scanned = await scanDshPlugins();
      this.cache = { at: Date.now(), list: scanned };
      return this.mergeSettings(scanned, settings);
    } catch (error) {
      this.log.warn("插件扫描失败", { message: safeErrorMessage(error) });
      return settings.plugins ?? [];
    }
  }

  private mergeSettings(list: PluginInfo[], settings: AppSettings): PluginInfo[] {
    const overrides = new Map((settings.plugins ?? []).map((p) => [p.id, p]));
    return list.map((p) => {
      const saved = overrides.get(p.id);
      return saved ? { ...p, enabled: saved.enabled, bridge: saved.bridge ?? p.bridge, lastTest: saved.lastTest } : p;
    });
  }

  async test(id: string, settings: AppSettings): Promise<{ result: PluginTestResult; plugin?: PluginInfo }> {
    const plugins = await this.list(settings, true);
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) throw new Error("插件不存在");
    if (!plugin.bridge?.command) throw new Error("该插件没有可桥接的命令");
    const result = await testPlugin(plugin);
    const next = {
      ...plugin,
      lastTest: { ok: result.ok, message: result.message, latencyMs: result.latencyMs, at: Date.now() },
    };
    const saved = (settings.plugins ?? []).filter((p) => p.id !== id);
    saved.push(next);
    this.storage.db.prepare("SELECT 1").get(); // keep storage referenced
    return { result, plugin: next };
  }
}

export function findCustomRole(settings: AppSettings, roleId: string) {
  return (settings.customRoles ?? []).find((r) => r.id === roleId);
}

export function isKnownRole(settings: AppSettings, roleId: string): boolean {
  return Boolean(COORD_ROLE_BY_ID[roleId as keyof typeof COORD_ROLE_BY_ID] || findCustomRole(settings, roleId));
}

/** 附件文本 → 注入 orchestrator 的上下文（限长，避免额外 token）。 */
export function composeAttachmentsContext(
  attachments: Array<{ name: string; kind: string; text?: string }>,
  maxChars = 12_000,
): string {
  if (attachments.length === 0) return "";
  const blocks: string[] = [];
  let budget = maxChars;
  for (const a of attachments) {
    const text = (a.text ?? "").trim();
    if (!text) continue;
    if (budget <= 0) break;
    const slice = text.slice(0, Math.min(budget, 4000));
    budget -= slice.length;
    blocks.push(`### 附件：${a.name}（${a.kind}）\n${slice}`);
  }
  return blocks.length ? `## 用户上传的附件内容\n${blocks.join("\n\n")}` : "";
}

export type UploadKind = AttachmentMeta["kind"];
export type UploadProvider = ProviderId;
