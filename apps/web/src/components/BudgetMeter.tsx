/** 工具条预算条：今日已用 / 上限、80% 黄、100% 红、省钱模式开关。 */
import type { BudgetSettings } from "@super-work/core";
import type { BudgetUsageView } from "../lib/api";
import { formatNumber } from "../lib/format";
import { IconAlert, IconLoader, IconWallet } from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface BudgetMeterProps {
  usage: BudgetUsageView | null;
  budgets?: BudgetSettings;
  cheapMode: boolean;
  loading: boolean;
  failed: boolean;
  running: boolean;
  onToggleCheapMode: (value: boolean) => void;
  onOpenBudget: () => void;
}

function currencySign(currency: "CNY" | "USD" | undefined): string {
  return currency === "USD" ? "$" : "¥";
}

function money(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value > 0 && value < 0.01) return "<0.01";
  return value.toFixed(value >= 100 ? 0 : 2);
}

export function BudgetMeter({
  usage,
  budgets,
  cheapMode,
  loading,
  failed,
  running,
  onToggleCheapMode,
  onOpenBudget,
}: BudgetMeterProps) {
  const safeBudgets: BudgetSettings = budgets ?? { currency: "CNY" };
  const costLimit =
    safeBudgets.dailyCostLimit && safeBudgets.dailyCostLimit > 0 ? safeBudgets.dailyCostLimit : undefined;
  const tokenLimit =
    safeBudgets.dailyTokenLimit && safeBudgets.dailyTokenLimit > 0 ? safeBudgets.dailyTokenLimit : undefined;
  const usedCost = usage?.cost ?? 0;
  const usedTokens = usage?.tokens ?? 0;
  const ratios = [
    costLimit ? usedCost / costLimit : undefined,
    tokenLimit ? usedTokens / tokenLimit : undefined,
  ].filter((value): value is number => value != null && Number.isFinite(value));
  const ratio = ratios.length > 0 ? Math.max(...ratios) : undefined;
  const percent = ratio == null ? (usage?.percent ?? 0) : Math.round(ratio * 100);
  const tone = percent >= 100 ? "danger" : percent >= (safeBudgets.warnAtPercent ?? 80) ? "warn" : "ok";
  const hasLimit = costLimit != null || tokenLimit != null;
  const blocked = usage?.blocked === true || percent >= 100;

  const primary = costLimit
    ? `${currencySign(safeBudgets.currency)}${money(usedCost)} / ${money(costLimit)}`
    : tokenLimit
      ? `${formatNumber(usedTokens)} / ${formatNumber(tokenLimit)} token`
      : "未设上限";
  const secondary = costLimit && tokenLimit ? `token ${formatNumber(usedTokens)}` : tokenLimit ? "今日 token" : "";

  return (
    <div className={`budget-meter is-${tone}${blocked ? " is-blocked" : ""}`} aria-label="今日预算">
      <button
        type="button"
        className="budget-meter__main"
        onClick={onOpenBudget}
        title={`今日已用 ${formatNumber(usedTokens)} token · ${currencySign(usage?.currency ?? safeBudgets.currency)}${money(
          usedCost,
        )}${hasLimit ? `，上限 ${percent}%` : "，未设置上限"}`}
        aria-label="打开预算设置"
      >
        <span className="budget-meter__icon" aria-hidden="true">
          {loading ? <IconLoader size={12} className="spin" /> : <IconWallet size={12} />}
        </span>
        <span className="budget-meter__text">
          <span className="budget-meter__label">
            今日预算
            {failed ? (
              <span className="budget-meter__failed" title="预算接口未就绪，显示为本地估算">
                <IconAlert size={9} /> 接口未就绪
              </span>
            ) : null}
            {blocked ? <b className="budget-meter__blocked">已超限</b> : null}
          </span>
          <span className="budget-meter__numbers mono">
            {primary}
            {hasLimit ? <em>{percent}%</em> : null}
            {secondary ? <em className="is-muted">{secondary}</em> : null}
          </span>
        </span>
        <span className="budget-meter__track" aria-hidden="true">
          <span
            className="budget-meter__fill"
            style={{ width: `${Math.min(100, Math.max(hasLimit ? 2 : 0, percent))}%` }}
          />
        </span>
      </button>

      <span className="paddle-inline">
        <PaddleSwitch
          size="sm"
          checked={cheapMode}
          onChange={(next) => onToggleCheapMode(next)}
          disabled={running}
          ariaLabel="省钱模式"
          title={
            running
              ? "运行中不能切换省钱模式"
              : cheapMode
                ? "省钱模式已开启：默认档位 low、关闭互评、压缩上下文"
                : "开启省钱模式：默认档位 low、关闭互评、压缩上下文"
          }
        />
        <span>省钱</span>
      </span>
    </div>
  );
}
