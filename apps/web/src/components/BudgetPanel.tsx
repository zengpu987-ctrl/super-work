/** 设置 → 预算：每日/单次成本与 token、单次调用上限、预警、确认阈值、省钱模式。 */
import { useEffect, useState } from "react";
import type { AppSettings, BudgetSettings } from "@super-work/core";
import type { BudgetUsageView } from "../lib/api";
import { formatNumber } from "../lib/format";
import { IconAlert, IconCheck, IconInfo, IconWallet } from "./Icons";

export interface BudgetPanelProps {
  settings: AppSettings;
  usage: BudgetUsageView | null;
  loading: boolean;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}

function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function numberText(value: number | undefined): string {
  return value == null ? "" : String(value);
}

export function BudgetPanel({ settings, usage, loading, onSave }: BudgetPanelProps) {
  const [budgets, setBudgets] = useState<BudgetSettings>(settings.budgets ?? { currency: "CNY" });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setBudgets(settings.budgets ?? { currency: "CNY" });
  }, [settings.budgets]);

  const update = <K extends keyof BudgetSettings>(key: K, value: BudgetSettings[K]): void => {
    setBudgets((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  };

  const costLimit = budgets.dailyCostLimit && budgets.dailyCostLimit > 0 ? budgets.dailyCostLimit : undefined;
  const tokenLimit = budgets.dailyTokenLimit && budgets.dailyTokenLimit > 0 ? budgets.dailyTokenLimit : undefined;
  const usedCost = usage?.cost ?? 0;
  const usedTokens = usage?.tokens ?? 0;
  const ratios = [
    costLimit ? usedCost / costLimit : undefined,
    tokenLimit ? usedTokens / tokenLimit : undefined,
  ].filter((value): value is number => value != null);
  const percent = ratios.length > 0 ? Math.round(Math.max(...ratios) * 1000) / 10 : usage?.percent ?? 0;
  const tone = percent >= 100 ? "danger" : percent >= (budgets.warnAtPercent ?? 80) ? "warn" : "ok";
  const currencySign = budgets.currency === "USD" ? "$" : "¥";

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next: BudgetSettings = {
        currency: budgets.currency,
        dailyCostLimit: budgets.dailyCostLimit,
        dailyTokenLimit: budgets.dailyTokenLimit,
        perRunCostLimit: budgets.perRunCostLimit,
        perRunTokenLimit: budgets.perRunTokenLimit,
        perCallMaxTokens: budgets.perCallMaxTokens,
        warnAtPercent: budgets.warnAtPercent ?? 80,
        confirmAboveCost: budgets.confirmAboveCost,
        cheapMode: budgets.cheapMode === true,
      };
      await onSave({ budgets: next });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-panel budget-panel">
      <div className="settings-panel__head">
        <span className="settings-panel__icon">
          <IconWallet size={16} />
        </span>
        <div>
          <h3>预算与防额外消耗</h3>
          <p>每次模型调用会按模型上限、档位、单次调用上限与默认 token 依次夹紧；超过单次运行预算会停止剩余调用。</p>
        </div>
      </div>

      <section className={`budget-usage is-${tone}`}>
        <div className="budget-usage__row">
          <span>今日已用</span>
          <b className="mono">
            {currencySign}
            {usedCost.toFixed(2)} · {formatNumber(usedTokens)} token
          </b>
          <span className="budget-usage__percent mono">{loading ? "读取中…" : `${percent}%`}</span>
        </div>
        <div className="budget-usage__track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
        </div>
        <p className="budget-usage__hint">
          {costLimit || tokenLimit ? (
            <>
              上限：{costLimit ? `${currencySign}${costLimit}` : "未设成本"} ·{" "}
              {tokenLimit ? `${formatNumber(tokenLimit)} token` : "未设 token"} · 80% 预警 / 100% 停止
              {usage?.message ? ` · ${usage.message}` : ""}
            </>
          ) : (
            <>还没有设置每日上限。建议先设置每日成本或 token 上限，再开启省钱模式。</>
          )}
        </p>
      </section>

      <section className="settings-panel__section">
        <h4>每日窗口</h4>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">币种</span>
            <select
              className="select"
              value={budgets.currency}
              onChange={(event) => update("currency", event.target.value as "CNY" | "USD")}
            >
              <option value="CNY">CNY ¥</option>
              <option value="USD">USD $</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">每日成本上限</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.1}
              value={numberText(budgets.dailyCostLimit)}
              placeholder="留空 = 不限"
              onChange={(event) => update("dailyCostLimit", toNumber(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field__label">每日 token 上限</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              value={numberText(budgets.dailyTokenLimit)}
              placeholder="留空 = 不限"
              onChange={(event) => update("dailyTokenLimit", toNumber(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="settings-panel__section">
        <h4>单次运行 / 单次调用</h4>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">单次运行成本上限</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.1}
              value={numberText(budgets.perRunCostLimit)}
              placeholder="留空 = 不限"
              onChange={(event) => update("perRunCostLimit", toNumber(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field__label">单次运行 token 上限</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1000}
              value={numberText(budgets.perRunTokenLimit)}
              placeholder="留空 = 不限"
              onChange={(event) => update("perRunTokenLimit", toNumber(event.target.value))}
            />
          </label>
          <label className="field">
            <span className="field__label">单次调用输出上限</span>
            <input
              className="input"
              type="number"
              min={256}
              max={32768}
              step={256}
              value={numberText(budgets.perCallMaxTokens)}
              placeholder="例如 4096"
              onChange={(event) =>
                update(
                  "perCallMaxTokens",
                  event.target.value === "" ? undefined : Math.max(1, Number(event.target.value)),
                )
              }
            />
            <span className="field__hint">会再与模型上限、档位倍率夹紧。</span>
          </label>
        </div>
      </section>

      <section className="settings-panel__section">
        <h4>预警与确认</h4>
        <div className="form-grid">
          <label className="field">
            <span className="field__label">预警百分比</span>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={numberText(budgets.warnAtPercent ?? 80)}
              onChange={(event) => update("warnAtPercent", toNumber(event.target.value))}
            />
            <span className="field__hint">达到该比例为黄色；100% 红色并停止。</span>
          </label>
          <label className="field">
            <span className="field__label">确认阈值（预估成本超过时弹确认）</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.1}
              value={numberText(budgets.confirmAboveCost)}
              placeholder="留空 = 不确认"
              onChange={(event) => update("confirmAboveCost", toNumber(event.target.value))}
            />
          </label>
        </div>

        <button
          type="button"
          className={`budget-cheap${budgets.cheapMode ? " is-on" : ""}`}
          role="switch"
          aria-checked={budgets.cheapMode === true}
          onClick={() => update("cheapMode", !budgets.cheapMode)}
        >
          <span className="budget-cheap__switch" aria-hidden="true">
            <span />
          </span>
          <span className="budget-cheap__main">
            <strong>省钱模式</strong>
            <span>默认档位降为 Low、关闭互评轮、附件与上下文更激进地压缩（约 8 轮）。</span>
          </span>
        </button>
      </section>

      <div className="settings-panel__foot">
        <span className="settings-panel__note">
          <IconInfo size={11} /> 确认阈值只生效一次：确认后的请求带 force=true，只放行当次。
        </span>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {savedAt ? <IconCheck size={13} /> : null}
          {saving ? "保存中…" : savedAt ? "已保存" : "保存预算"}
        </button>
      </div>
    </div>
  );
}
