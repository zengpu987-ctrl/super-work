import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PROVIDER_BY_ID,
  type BillingModelRow,
  type BillingSummary,
  type BillingWindow,
  type CostBreakdown,
  type ModelPrice,
  type ProviderId,
  type RunDetail,
} from "@super-work/core";
import type { Storage } from "./storage.js";
import type { Logger } from "./log.js";

export const DEFAULT_PRICES: ModelPrice[] = [
  { provider: "deepseek", model: "deepseek-v4-pro", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "deepseek", model: "deepseek-v4.1-flash", currency: "CNY", inputPerMTokens: 1, outputPerMTokens: 4 },
  { provider: "deepseek-account", model: "deepseek-flash", currency: "CNY", inputPerMTokens: 0.5, outputPerMTokens: 2 },
  { provider: "deepseek-account", model: "deepseek-v4-pro", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "deepseek", model: "deepseek-flash", currency: "CNY", inputPerMTokens: 0.5, outputPerMTokens: 2 },
  { provider: "kimi", model: "kimi-k3.1-pro", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "kimi", model: "k3.1-pro", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "kimi", model: "kimi-k2.7-code", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "openai", model: "gpt-6.1-terra", currency: "CNY", inputPerMTokens: 60, outputPerMTokens: 240 },
  { provider: "openai", model: "gpt-6.1-sol", currency: "CNY", inputPerMTokens: 40, outputPerMTokens: 160 },
  { provider: "anthropic", model: "claude-opus-5-5", currency: "CNY", inputPerMTokens: 60, outputPerMTokens: 240 },
  { provider: "anthropic", model: "claude-sonnet-5-5", currency: "CNY", inputPerMTokens: 24, outputPerMTokens: 96 },
  { provider: "zhipu", model: "glm-5.3", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "qwen", model: "qwen4-max", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "qwen", model: "qwen3.8-max", currency: "CNY", inputPerMTokens: 2, outputPerMTokens: 8 },
  { provider: "volcengine", model: "doubao-seed-evolving", currency: "CNY", inputPerMTokens: 1, outputPerMTokens: 4 },
  { provider: "minimax", model: "MiniMax-M3", currency: "CNY", inputPerMTokens: 2, outputPerMTokens: 8 },
  { provider: "gemini", model: "gemini-3.1-pro", currency: "CNY", inputPerMTokens: 8, outputPerMTokens: 48 },
  { provider: "xai", model: "grok-4.7", currency: "CNY", inputPerMTokens: 20, outputPerMTokens: 80 },
  { provider: "workbuddy", model: "*", currency: "CNY", inputPerMTokens: 4, outputPerMTokens: 16 },
  { provider: "relay", model: "*", currency: "CNY", inputPerMTokens: 8, outputPerMTokens: 32 },
];

interface PriceRow {
  provider: ProviderId;
  model: string;
  currency: string;
  input_per_m: number;
  output_per_m: number;
  cached_input_per_m: number | null;
  credit_multiplier: number | null;
  updated_at: number;
}

interface DshRow {
  day: string;
  site: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

function emptyWindow(currency: "CNY" | "USD" = "CNY"): BillingWindow {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency, runs: 0, hasUnpriced: false };
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class BillingService {
  constructor(
    private storage: Storage,
    private log: Logger,
  ) {
    this.storage.db.exec(`
      CREATE TABLE IF NOT EXISTS prices (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        currency TEXT NOT NULL,
        input_per_m REAL NOT NULL,
        output_per_m REAL NOT NULL,
        cached_input_per_m REAL,
        credit_multiplier REAL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      );
      CREATE TABLE IF NOT EXISTS dsh_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        site TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        imported_at INTEGER NOT NULL
      );
    `);
    this.seedPrices();
  }

  private seedPrices(): void {
    const count = this.storage.db.prepare("SELECT COUNT(*) AS n FROM prices").get() as { n: number };
    if (Number(count?.n ?? 0) > 0) return;
    const now = Date.now();
    const insert = this.storage.db.prepare(
      `INSERT OR REPLACE INTO prices (provider, model, currency, input_per_m, output_per_m, cached_input_per_m, credit_multiplier, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of DEFAULT_PRICES) {
      insert.run(p.provider, p.model, p.currency, p.inputPerMTokens, p.outputPerMTokens, p.cachedInputPerMTokens ?? null, p.creditMultiplier ?? null, now);
    }
  }

  prices(): ModelPrice[] {
    const rows = this.storage.db.prepare("SELECT * FROM prices ORDER BY provider, model").all() as unknown as PriceRow[];
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      currency: r.currency as "CNY" | "USD",
      inputPerMTokens: r.input_per_m,
      outputPerMTokens: r.output_per_m,
      cachedInputPerMTokens: r.cached_input_per_m ?? undefined,
      creditMultiplier: r.credit_multiplier ?? undefined,
      updatedAt: r.updated_at,
    }));
  }

  savePrices(prices: ModelPrice[]): ModelPrice[] {
    const now = Date.now();
    const stmt = this.storage.db.prepare(
      `INSERT OR REPLACE INTO prices (provider, model, currency, input_per_m, output_per_m, cached_input_per_m, credit_multiplier, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of prices) {
      if (!p.provider || !p.model) continue;
      stmt.run(
        p.provider,
        p.model,
        p.currency ?? "CNY",
        Math.max(0, p.inputPerMTokens ?? 0),
        Math.max(0, p.outputPerMTokens ?? 0),
        p.cachedInputPerMTokens ?? null,
        p.creditMultiplier ?? null,
        now,
      );
    }
    return this.prices();
  }

  private priceFor(provider: ProviderId, model: string): ModelPrice | undefined {
    const rows = this.storage.db
      .prepare("SELECT * FROM prices WHERE provider = ? AND model IN (?, '*') ORDER BY model = ? DESC LIMIT 1")
      .all(provider, model, model) as unknown as PriceRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      provider: row.provider,
      model: row.model,
      currency: row.currency as "CNY" | "USD",
      inputPerMTokens: row.input_per_m,
      outputPerMTokens: row.output_per_m,
      cachedInputPerMTokens: row.cached_input_per_m ?? undefined,
      creditMultiplier: row.credit_multiplier ?? undefined,
    };
  }

  costFor(provider: ProviderId, model: string, inputTokens: number, outputTokens: number): CostBreakdown {
    const price = this.priceFor(provider, model);
    if (!price) {
      return {
        currency: "CNY",
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        priced: false,
      };
    }
    const inputCost = (inputTokens / 1_000_000) * price.inputPerMTokens;
    const outputCost = (outputTokens / 1_000_000) * price.outputPerMTokens;
    return {
      currency: price.currency,
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      priced: true,
      credit: price.creditMultiplier ? (inputTokens + outputTokens) * price.creditMultiplier : undefined,
    };
  }

  /** 一次运行的成本（按参与者的 usage 计）。 */
  runCost(detail: Pick<RunDetail, "results">): CostBreakdown | undefined {
    let total: CostBreakdown | undefined;
    for (const r of detail.results ?? []) {
      if (!r.usage) continue;
      const c = this.costFor(r.provider, r.model, r.usage.inputTokens ?? 0, r.usage.outputTokens ?? 0);
      if (!c.priced) continue;
      if (!total) total = { ...c, inputCost: 0, outputCost: 0, totalCost: 0, credit: 0 };
      total.inputCost += c.inputCost;
      total.outputCost += c.outputCost;
      total.totalCost += c.totalCost;
      if (c.credit) total.credit = (total.credit ?? 0) + c.credit;
    }
    return total;
  }

  importDshLedger(): { imported: number; detail: string } {
    const file = path.join(os.homedir(), ".dsh", "tokenledger.sqlite");
    if (!fs.existsSync(file)) return { imported: 0, detail: "没有找到 ~/.dsh/tokenledger.sqlite" };
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db
        .prepare("SELECT day, site, provider, model, inputTokens, outputTokens, requests FROM session_rollups")
        .all() as unknown as Array<{
        day: string;
        site: string;
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        requests: number;
      }>;
      if (rows.length === 0) return { imported: 0, detail: "DSH 账本当前没有数据（session_rollups 为空）" };
      const now = Date.now();
      const stmt = this.storage.db.prepare(
        `INSERT INTO dsh_ledger (day, site, provider, model, input_tokens, output_tokens, requests, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let imported = 0;
      for (const r of rows) {
        stmt.run(r.day, r.site ?? "", r.provider ?? "", r.model ?? "", r.inputTokens ?? 0, r.outputTokens ?? 0, r.requests ?? 0, now);
        imported += 1;
      }
      this.log.info("已导入 DSH 账本", { imported });
      return { imported, detail: `导入 ${imported} 行` };
    } catch (error) {
      return { imported: 0, detail: `读取 DSH 账本失败：${(error as Error).message}` };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  summary(limitRuns = 500): BillingSummary {
    const rows = this.storage.db
      .prepare("SELECT * FROM runs WHERE status != 'running' ORDER BY created_at DESC LIMIT ?")
      .all(limitRuns) as unknown as Array<{
      id: string;
      created_at: number;
      usage_json: string | null;
      results_json: string | null;
      status: string;
    }>;
    const now = Date.now();
    const dayStart = startOfDay(now);
    const monthStart = startOfMonth(now);
    const today = emptyWindow();
    const month = emptyWindow();
    const all = emptyWindow();
    const byModel = new Map<string, BillingModelRow>();
    const daily = new Map<string, { tokens: number; cost: number; runs: number }>();

    const addToWindow = (w: BillingWindow, input: number, output: number, cost: number, priced: boolean) => {
      w.inputTokens += input;
      w.outputTokens += output;
      w.totalTokens += input + output;
      w.cost += cost;
      if (!priced) w.hasUnpriced = true;
    };

    for (const run of rows) {
      let results: Array<{ provider: ProviderId; model: string; usage?: { inputTokens?: number; outputTokens?: number } }> = [];
      try {
        results = run.results_json ? JSON.parse(run.results_json) : [];
      } catch {
        results = [];
      }
      let runTokens = 0;
      let runInput = 0;
      let runOutput = 0;
      let runCost = 0;
      let runPriced = false;
      for (const r of results) {
        const input = r.usage?.inputTokens ?? 0;
        const output = r.usage?.outputTokens ?? 0;
        if (input + output === 0) continue;
        const cost = this.costFor(r.provider, r.model, input, output);
        const key = `${r.provider}::${r.model}`;
        const row = byModel.get(key) ?? {
          provider: r.provider,
          model: r.model,
          inputTokens: 0,
          outputTokens: 0,
          calls: 0,
          cost: 0,
          priced: cost.priced,
          currency: cost.currency,
          credit: 0,
        };
        row.inputTokens += input;
        row.outputTokens += output;
        row.calls += 1;
        row.cost += cost.totalCost;
        row.priced = row.priced || cost.priced;
        if (cost.credit) row.credit = (row.credit ?? 0) + cost.credit;
        byModel.set(key, row);
        runTokens += input + output;
        runInput += input;
        runOutput += output;
        runCost += cost.totalCost;
        runPriced = runPriced || cost.priced;
      }
      if (runTokens === 0) continue;
      const ts = run.created_at;
      if (ts >= monthStart) {
        month.runs += 1;
        addToWindow(month, runInput, runOutput, runCost, runPriced);
      }
      if (ts >= dayStart) {
        today.runs += 1;
        addToWindow(today, runInput, runOutput, runCost, runPriced);
      }
      all.runs += 1;
      addToWindow(all, runInput, runOutput, runCost, runPriced);
      const dayKey = new Date(ts).toISOString().slice(0, 10);
      const d = daily.get(dayKey) ?? { tokens: 0, cost: 0, runs: 0 };
      d.tokens += runTokens;
      d.cost += runCost;
      d.runs += 1;
      daily.set(dayKey, d);
    }

    // 合并导入的 DSH 账本（只算 token，不计入已有成本，避免双重计费）
    const dshRows = this.storage.db.prepare("SELECT * FROM dsh_ledger").all() as unknown as DshRow[];
    for (const r of dshRows) {
      const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
      if (tokens === 0) continue;
      today.inputTokens += r.day === new Date(dayStart).toISOString().slice(0, 10) ? r.input_tokens : 0;
      today.outputTokens += r.day === new Date(dayStart).toISOString().slice(0, 10) ? r.output_tokens : 0;
      month.inputTokens += r.day >= new Date(monthStart).toISOString().slice(0, 10) ? r.input_tokens : 0;
      month.outputTokens += r.day >= new Date(monthStart).toISOString().slice(0, 10) ? r.output_tokens : 0;
      all.inputTokens += r.input_tokens;
      all.outputTokens += r.output_tokens;
      all.totalTokens += tokens;
    }
    today.totalTokens = today.inputTokens + today.outputTokens;
    month.totalTokens = month.inputTokens + month.outputTokens;

    const dailyArr = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(dayStart - (29 - i) * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const hit = daily.get(key);
      return { day: key, tokens: hit?.tokens ?? 0, cost: hit?.cost ?? 0, runs: hit?.runs ?? 0 };
    });

    return {
      today,
      month,
      all,
      byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
      daily: dailyArr,
      importedRows: dshRows.length,
      generatedAt: Date.now(),
    };
  }

  exportCsv(limitRuns = 1000): string {
    const runs = this.storage.db
      .prepare("SELECT id, command, mode, status, created_at, finished_at, usage_json, results_json FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limitRuns) as unknown as Array<{
      id: string;
      command: string;
      mode: string;
      status: string;
      created_at: number;
      finished_at: number | null;
      usage_json: string | null;
      results_json: string | null;
    }>;
    const lines = ["run_id,created_at,mode,status,provider,model,input_tokens,output_tokens,cost_cny,currency"];
    const esc = (s: string) => `"${String(s).replace(/"/g, '""').replace(/\n/g, " ")}"`;
    for (const run of runs) {
      let results: Array<{ provider: ProviderId; model: string; usage?: { inputTokens?: number; outputTokens?: number } }> = [];
      try {
        results = run.results_json ? JSON.parse(run.results_json) : [];
      } catch {
        results = [];
      }
      const iso = new Date(run.created_at).toISOString();
      for (const r of results) {
        const cost = this.costFor(r.provider, r.model, r.usage?.inputTokens ?? 0, r.usage?.outputTokens ?? 0);
        lines.push(
          [
            run.id,
            iso,
            run.mode,
            run.status,
            esc(r.provider),
            esc(r.model),
            r.usage?.inputTokens ?? 0,
            r.usage?.outputTokens ?? 0,
            cost.priced ? cost.totalCost.toFixed(4) : "",
            cost.currency,
          ].join(","),
        );
      }
    }
    return lines.join("\n");
  }
}

export function modelContextWindow(provider: ProviderId, model: string): number | undefined {
  return PROVIDER_BY_ID[provider]?.models.find((m) => m.id === model)?.contextWindow;
}
