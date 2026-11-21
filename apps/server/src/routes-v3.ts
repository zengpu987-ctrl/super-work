import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  COORD_ROLE_BY_ID,
  normalizeEffort,
  type BudgetStatusResponse,
  type BillingSummary,
  type PluginBridgeSpec,
  type PluginInfo,
} from "@super-work/core";
import { applyKeywords, type PluginService, type UploadStore } from "./v3.js";
import { executePluginAction } from "./pluginActions.js";
import type { BillingService } from "./billing.js";
import type { CredentialManager } from "./credentials.js";
import type { Storage } from "./storage.js";
import type { Paths } from "./config.js";
import type { Logger } from "./log.js";
import { safeErrorMessage } from "./log.js";

export interface RoutesV3Deps {
  paths: Paths;
  storage: Storage;
  billing: BillingService;
  creds: CredentialManager;
  uploads: UploadStore;
  plugins: PluginService;
  getSettings: () => import("@super-work/core").AppSettings;
  putSettings: (next: import("@super-work/core").AppSettings) => import("@super-work/core").AppSettings;
  log: Logger;
}

function bad(reply: FastifyReply, message: string, code = "bad_request") {
  return reply.code(400).send({ error: { code, message } });
}

export async function registerV3Routes(app: FastifyInstance, deps: RoutesV3Deps): Promise<void> {
  const { uploads, plugins, billing, creds, paths } = deps;

  /* -------------------------------- 上传 -------------------------------- */

  app.post("/api/uploads", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; mime?: string; size?: number; dataBase64?: string };
    if (!body.dataBase64) return bad(reply, "缺少文件内容", "upload_failed");
    try {
      const saved = await uploads.save({
        name: body.name,
        mime: body.mime,
        size: body.size,
        dataBase64: body.dataBase64,
      });
      return saved;
    } catch (error) {
      return bad(reply, safeErrorMessage(error), "upload_failed");
    }
  });

  app.get("/api/uploads/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = uploads.get(id);
    if (!found) return reply.code(404).send({ error: { code: "not_found", message: "附件不存在" } });
    return found;
  });

  /* -------------------------------- 预算 -------------------------------- */

  app.get("/api/budgets/usage", async (): Promise<BudgetStatusResponse> => {
    const settings = deps.getSettings();
    const budgets = settings.budgets;
    const summary: BillingSummary = billing.summary();
    const today = summary.today;
    const limits = {
      dailyTokenLimit: budgets?.dailyTokenLimit,
      dailyCostLimit: budgets?.dailyCostLimit,
      perRunTokenLimit: budgets?.perRunTokenLimit,
      perRunCostLimit: budgets?.perRunCostLimit,
      warnAtPercent: budgets?.warnAtPercent ?? 80,
    };
    const percentParts: number[] = [];
    if (limits.dailyCostLimit && limits.dailyCostLimit > 0) {
      percentParts.push(Math.round((today.cost / limits.dailyCostLimit) * 100));
    }
    if (limits.dailyTokenLimit && limits.dailyTokenLimit > 0) {
      percentParts.push(Math.round((today.totalTokens / limits.dailyTokenLimit) * 100));
    }
    const percent = percentParts.length ? Math.max(...percentParts) : undefined;
    const blocked =
      Boolean(limits.dailyTokenLimit && today.totalTokens >= limits.dailyTokenLimit) ||
      Boolean(limits.dailyCostLimit && today.cost >= limits.dailyCostLimit);
    return {
      today: { tokens: today.totalTokens, cost: today.cost, currency: today.currency },
      limits,
      percent,
      cheapMode: Boolean(budgets?.cheapMode),
      blocked,
      message: blocked
        ? "今日预算已用尽，新运行会被拦截；可在设置 → 预算里调高上限"
        : percent !== undefined && percent >= limits.warnAtPercent
          ? `今日预算已用 ${percent}%`
          : undefined,
    };
  });

  /* -------------------------------- 关键词 -------------------------------- */

  app.post("/api/keywords/test", async (req) => {
    const body = (req.body ?? {}) as { command?: string };
    const command = (body.command ?? "").trim();
    const settings = deps.getSettings();
    const applied = applyKeywords(command, settings.keywords);
    const effects: string[] = [];
    if (applied.mode) effects.push(`模式 → ${applied.mode}`);
    if (applied.effort) effects.push(`默认强度 → ${applied.effort}`);
    if (applied.memory !== undefined) effects.push(`记忆 → ${applied.memory ? "开启" : "关闭"}`);
    if (applied.cheapMode !== undefined) effects.push(`省钱模式 → ${applied.cheapMode ? "开启" : "关闭"}`);
    if (applied.judge) effects.push(`裁判 → ${applied.judge.provider}/${applied.judge.model}`);
    for (const role of applied.roles) {
      effects.push(`追加角色 ${role.role}（${role.participants.length} 个模型）`);
    }
    return { matched: applied.hits, effects };
  });

  /* -------------------------------- 插件 -------------------------------- */

  app.get("/api/plugins", async (_req, reply): Promise<PluginInfo[]> => {
    try {
      return await plugins.list(deps.getSettings(), false);
    } catch (error) {
      deps.log.warn("插件列表不可用", { message: safeErrorMessage(error) });
      return deps.getSettings().plugins ?? [];
    }
  });

  app.put("/api/plugins/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean; bridge?: PluginBridgeSpec };
    if (body.bridge) {
      if (!body.bridge.command?.trim()) return bad(reply, "桥接命令不能为空");
      if (!Array.isArray(body.bridge.testArgs)) return bad(reply, "testArgs 必须是数组");
      if (body.bridge.testArgs.some((a) => typeof a !== "string")) return bad(reply, "testArgs 只能是字符串");
    }
    const settings = deps.getSettings();
    const list = await plugins.list(settings, false);
    const target = list.find((p) => p.id === id);
    if (!target) return reply.code(404).send({ error: { code: "not_found", message: "插件不存在" } });
    const next: PluginInfo = {
      ...target,
      enabled: body.enabled ?? target.enabled,
      bridge: body.bridge ?? target.bridge,
    };
    const saved = (settings.plugins ?? []).filter((p) => p.id !== id);
    saved.push(next);
    deps.putSettings({ ...settings, plugins: saved });
    return next;
  });

  app.post("/api/plugins/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const settings = deps.getSettings();
      const { result, plugin } = await plugins.test(id, settings);
      if (plugin) {
        const saved = (settings.plugins ?? []).filter((p) => p.id !== id);
        saved.push(plugin);
        deps.putSettings({ ...deps.getSettings(), plugins: saved });
      }
      return { result, plugin };
    } catch (error) {
      return reply.code(400).send({ error: { code: "plugin_test_failed", message: safeErrorMessage(error) } });
    }
  });

  app.post("/api/plugins/:id/action", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { actionId?: string; inputs?: Record<string, string> };
    if (!body.actionId) return bad(reply, "缺少 actionId");
    const settings = deps.getSettings();
    const list = await plugins.list(settings, false);
    const plugin = list.find((item) => item.id === id);
    if (!plugin) return reply.code(404).send({ error: { code: "not_found", message: "插件不存在" } });
    const action = (plugin.actions ?? []).find((item) => item.id === body.actionId);
    if (!action) return bad(reply, `插件 ${plugin.name} 没有动作 ${body.actionId}`);
    const inputs = Object.fromEntries(
      Object.entries(body.inputs ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]),
    );
    const result = await executePluginAction(plugin, action, inputs, {
      paths: deps.paths,
      uploads,
      log: deps.log,
    });
    return { plugin, action, result };
  });

  app.get("/api/plugins/files/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.includes("..")) return bad(reply, "非法文件名");
    const full = path.join(deps.paths.home, "plugin-output", name);
    if (!fs.existsSync(full)) return reply.code(404).send({ error: { code: "not_found", message: "插件产物不存在" } });
    const ext = path.extname(name).toLowerCase();
    const type =
      ext === ".mp4"
        ? "video/mp4"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".png"
            ? "image/png"
            : ext === ".jpg"
              ? "image/jpeg"
              : ext === ".html"
                ? "text/html; charset=utf-8"
                : ext === ".md"
                  ? "text/markdown; charset=utf-8"
                  : "application/octet-stream";
    return reply.type(type).send(fs.readFileSync(full));
  });

  app.get("/api/plugins/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const saved = (deps.getSettings().plugins ?? []).find((p) => p.id === id);
    if (!saved) return reply.code(404).send({ error: { code: "not_found", message: "还没有该插件的测试记录" } });
    return { plugin: saved, lastTest: saved.lastTest };
  });

  /* --------------------------- 附件本地文件 --------------------------- */

  app.get("/api/uploads/:id/raw", async (req, reply) => {
    const { id } = req.params as { id: string };
    const found = uploads.get(id);
    if (!found?.path) return reply.code(404).send({ error: { code: "not_found", message: "附件不存在" } });
    const full = path.join(paths.home, found.path);
    if (!full.startsWith(path.join(paths.home, "uploads"))) {
      return reply.code(403).send({ error: { code: "forbidden", message: "非法路径" } });
    }
    if (!fs.existsSync(full)) return reply.code(404).send({ error: { code: "not_found", message: "附件文件缺失" } });
    return reply.type(found.mime || "application/octet-stream").send(fs.readFileSync(full));
  });
}

/** settings 校验（PUT /api/settings 用）：范围与唯一性。 */
export function validateV3Settings(
  next: import("@super-work/core").AppSettings,
  reply: FastifyReply,
): boolean {
  const b = next.budgets;
  if (b) {
    const numeric = [b.dailyCostLimit, b.dailyTokenLimit, b.perRunCostLimit, b.perRunTokenLimit, b.perCallMaxTokens];
    if (numeric.some((n) => n !== undefined && (!Number.isFinite(n) || n < 0))) {
      bad(reply, "预算数值必须是非负数");
      return false;
    }
    if (b.perCallMaxTokens !== undefined && (b.perCallMaxTokens < 256 || b.perCallMaxTokens > 32768)) {
      bad(reply, "单次调用 token 上限需在 256~32768");
      return false;
    }
    if (b.warnAtPercent !== undefined && (b.warnAtPercent < 10 || b.warnAtPercent > 100)) {
      bad(reply, "预警百分比需在 10~100");
      return false;
    }
  }
  const p = next.performance;
  if (p) {
    if (p.concurrency !== undefined && (p.concurrency < 1 || p.concurrency > 8)) {
      bad(reply, "并发数需在 1~8");
      return false;
    }
    if (p.timeoutMs !== undefined && (p.timeoutMs < 15_000 || p.timeoutMs > 300_000)) {
      bad(reply, "超时需在 15~300 秒");
      return false;
    }
    if (p.defaultMaxTokens !== undefined && (p.defaultMaxTokens < 256 || p.defaultMaxTokens > 32768)) {
      bad(reply, "默认 token 上限需在 256~32768");
      return false;
    }
  }
  const roles = next.customRoles;
  if (roles) {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const role of roles) {
      if (!role.id?.startsWith("custom_")) {
        bad(reply, "自定义角色 id 必须以 custom_ 开头");
        return false;
      }
      if (ids.has(role.id)) {
        bad(reply, `自定义角色 id 重复：${role.id}`);
        return false;
      }
      ids.add(role.id);
      const name = role.name?.trim();
      if (!name || name.length < 2 || name.length > 12) {
        bad(reply, "自定义角色名称需为 2~12 个字");
        return false;
      }
      if (names.has(name)) {
        bad(reply, `自定义角色名称重复：${name}`);
        return false;
      }
      names.add(name);
      if (role.kind !== "text" && role.kind !== "image") {
        bad(reply, "自定义角色类型只能是 text 或 image");
        return false;
      }
    }
  }
  const keywords = next.keywords;
  if (keywords) {
    for (const rule of keywords) {
      if (!rule.id || !rule.keyword?.trim()) {
        bad(reply, "关键词规则缺少 id 或关键词");
        return false;
      }
      if (rule.match === "regex") {
        try {
          new RegExp(rule.keyword);
        } catch {
          bad(reply, `关键词正则不合法：${rule.keyword}`);
          return false;
        }
      }
      if (rule.action?.type === "role") {
        const roleId = rule.action.role;
        const known =
          Boolean(COORD_ROLE_BY_ID[roleId as keyof typeof COORD_ROLE_BY_ID]) ||
          (next.customRoles ?? []).some((r) => r.id === roleId);
        if (!known) {
          bad(reply, `关键词规则指向未定义角色：${roleId}`);
          return false;
        }
      }
    }
  }
  const effort = next.budgets?.currency;
  if (effort && effort !== "CNY" && effort !== "USD") {
    bad(reply, "货币只支持 CNY/USD");
    return false;
  }
  return true;
}
