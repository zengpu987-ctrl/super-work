import { useCallback, useEffect, useMemo, useState } from "react";
import type { BillingModelRow, BillingSummary, ModelPrice, ProviderId } from "@super-work/core";
import { api, BILLING_CSV_URL, errorMessage, isApiError } from "../lib/api";
import { formatNumber, formatTokens } from "../lib/format";
import { BrandIcon } from "./BrandIcon";
import {
  IconAlert,
  IconChart,
  IconCheck,
  IconDownload,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "./Icons";

export interface BillingPageProps {
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

const PROVIDERS: ProviderId[] = [
  "deepseek",
  "kimi",
  "openai",
  "anthropic",
  "zhipu",
  "qwen",
  "volcengine",
  "minimax",
  "gemini",
  "xai",
  "thirdparty",
  "workbuddy",
  "relay",
  "mock",
];

function money(value: number, currency: "CNY" | "USD"): string {
  const symbol = currency === "USD" ? "$" : "¥";
  if (value === 0) return `${symbol}0`;
  if (Math.abs(value) < 0.01) return `${symbol}${value.toFixed(4)}`;
  return `${symbol}${value.toFixed(2)}`;
}

function dayLabel(day: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return `${day.slice(5, 7)}-${day.slice(8, 10)}`;
  const date = new Date(day);
  if (!Number.isNaN(date.getTime())) {
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return day;
}

export function BillingPage({ pushToast }: BillingPageProps) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingPrices, setEditingPrices] = useState(false);
  const [draft, setDraft] = useState<ModelPrice[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sum, priceList] = await Promise.all([api.getBillingSummary(), api.getBillingPrices()]);
      setSummary(sum);
      setPrices(priceList);
      setDraft(priceList);
      setMissing(false);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        setMissing(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const importDsh = async (): Promise<void> => {
    setBusy("import");
    try {
      const res = await api.importDshBilling();
      pushToast(
        "success",
        "已导入 DSH 账本",
        res.imported != null ? `新增 ${res.imported} 行` : res.detail ?? "导入完成",
      );
      await load();
    } catch (err) {
      pushToast("error", "导入 DSH 失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const savePrices = async (): Promise<void> => {
    setBusy("save");
    try {
      const saved = await api.saveBillingPrices(
        draft.map((price) => ({
          ...price,
          model: price.model.trim(),
          inputPerMTokens: Number(price.inputPerMTokens) || 0,
          outputPerMTokens: Number(price.outputPerMTokens) || 0,
        })),
      );
      setPrices(saved);
      setDraft(saved);
      setEditingPrices(false);
      pushToast("success", "价格表已保存");
      await load();
    } catch (err) {
      pushToast("error", "保存价格表失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const daily = useMemo(() => {
    const rows = summary?.daily ?? [];
    const filled = [...rows].slice(-30);
    while (filled.length < 30) {
      const date = new Date();
      date.setDate(date.getDate() - (30 - filled.length - 1));
      filled.unshift({ day: date.toISOString().slice(0, 10), tokens: 0, cost: 0, runs: 0 });
    }
    return filled;
  }, [summary]);

  const maxTokens = Math.max(1, ...daily.map((item) => item.tokens));
  const byModel = useMemo(
    () =>
      [...(summary?.byModel ?? [])].sort((a, b) => {
        if (a.cost !== b.cost) return b.cost - a.cost;
        return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
      }),
    [summary],
  );

  if (loading) {
    return (
      <div className="resource-loading">
        <IconLoader size={16} className="spin" /> 正在读取计费数据…
      </div>
    );
  }

  if (missing) {
    return (
      <div className="resource-fallback">
        <span className="resource-fallback__icon">
          <IconChart size={20} />
        </span>
        <h3>计费接口未就绪</h3>
        <p>
          服务端实现 <code>GET /api/billing/summary</code> 与 <code>/api/billing/prices</code> 后，这里会显示今日 /
          本月 / 累计用量、30 天柱状图与按模型成本。
        </p>
        <div className="resource-fallback__actions">
          <button type="button" className="btn" onClick={() => void load()}>
            <IconRefresh size={12} /> 重新读取
          </button>
          <a className="btn" href={BILLING_CSV_URL} download>
            <IconDownload size={12} /> 仍要尝试导出 CSV
          </a>
        </div>
        <p className="resource-fallback__hint">优雅降级：不会白屏，也不影响工作台运行。</p>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="resource-fallback resource-fallback--error">
        <span className="resource-fallback__icon">
          <IconAlert size={20} />
        </span>
        <h3>计费数据读取失败</h3>
        <p>{error ?? "服务端返回了无法识别的数据。"}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          <IconRefresh size={12} /> 重试
        </button>
      </div>
    );
  }

  return (
    <div className="billing-page">
      <div className="resource-toolbar">
        <div className="resource-toolbar__stats">
          <span>
            数据生成于 <b>{new Date(summary.generatedAt).toLocaleString("zh-CN")}</b>
          </span>
          <span>·</span>
          <span>DSH 导入 {summary.importedRows} 行</span>
        </div>
        <div className="resource-toolbar__actions">
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            <IconRefresh size={12} /> 刷新
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void importDsh()}
            disabled={busy === "import"}
          >
            {busy === "import" ? <IconLoader size={12} className="spin" /> : <IconUpload size={12} />}
            导入 DSH
          </button>
          <a className="btn btn-sm" href={BILLING_CSV_URL} download>
            <IconDownload size={12} /> 导出 CSV
          </a>
        </div>
      </div>

      <div className="billing-cards">
        {(
          [
            ["今日", summary.today],
            ["本月", summary.month],
            ["累计", summary.all],
          ] as const
        ).map(([label, win]) => (
          <section className="billing-card" key={label}>
            <header>
              <span>{label}</span>
              <span className="mono">{win.runs} 次运行</span>
            </header>
            <div className="billing-card__value mono">{formatTokens(win.totalTokens)}</div>
            <div className="billing-card__sub">
              tokens · 入 {formatTokens(win.inputTokens)} / 出 {formatTokens(win.outputTokens)}
            </div>
            <div className="billing-card__foot">
              <span className="billing-card__cost mono">
                {win.hasUnpriced ? `${money(win.cost, win.currency)} 起` : money(win.cost, win.currency)}
              </span>
              {win.hasUnpriced ? <span className="tag tag-warn">含未定价模型</span> : <span className="tag">已定价</span>}
            </div>
          </section>
        ))}
        <section className="billing-card billing-card--import">
          <header>
            <span>DSH 账本</span>
            <span className="mono">导入</span>
          </header>
          <div className="billing-card__value mono">{formatNumber(summary.importedRows)}</div>
          <div className="billing-card__sub">行历史用量 · 点「导入 DSH」从 ~/.dsh 账本补齐</div>
          <div className="billing-card__foot">
            <span className="billing-card__cost">本地数据</span>
            <button type="button" className="btn btn-sm" onClick={() => void importDsh()} disabled={busy === "import"}>
              {busy === "import" ? <IconLoader size={12} className="spin" /> : <IconUpload size={12} />} 导入
            </button>
          </div>
        </section>
      </div>

      <section className="billing-chart" aria-label="最近 30 天用量">
        <header className="section-head">
          <h3>最近 30 天</h3>
          <span className="section-head__sub">按天 token 用量 · 柱高相对峰值</span>
        </header>
        {daily.every((item) => item.tokens === 0) ? (
          <div className="billing-chart__empty">
            最近 30 天还没有 token 用量。跑一次运行后这里会出现按天柱状图。
          </div>
        ) : null}
        <div className="bar-chart" role="img" aria-label={`最近 30 天 token 用量，峰值 ${formatNumber(maxTokens)}`}>
          {daily.map((item) => {
            const height = item.tokens > 0 ? Math.max(3, (item.tokens / maxTokens) * 100) : 1;
            return (
              <div className="bar-chart__col" key={item.day} title={`${item.day} · ${formatNumber(item.tokens)} tok · ${money(item.cost, summary.today.currency)} · ${item.runs} 次`}>
                <div className="bar-chart__bar" style={{ height: `${height}%` }}>
                  <span className="bar-chart__tip">
                    {dayLabel(item.day)} · {formatTokens(item.tokens)} tok
                  </span>
                </div>
                <span className="bar-chart__label mono">{dayLabel(item.day)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="billing-models" aria-label="按模型用量">
        <header className="section-head">
          <h3>按模型</h3>
          <span className="section-head__sub">{byModel.length} 个模型有调用记录</span>
        </header>
        {byModel.length === 0 ? (
          <div className="resource-empty">还没有调用记录。跑一次运行后这里会出现按模型明细。</div>
        ) : (
          <div className="data-table">
            <div className="data-table__head">
              <span>模型</span>
              <span>调用</span>
              <span>输入</span>
              <span>输出</span>
              <span>成本</span>
            </div>
            {byModel.map((row) => (
              <div className="data-table__row" key={`${row.provider}:${row.model}`}>
                <span className="data-table__model">
                  <span className="data-table__model-name">
                    <BrandIcon provider={row.provider} size={13} title={`${row.provider} 官方商标`} />
                    <b>{row.model}</b>
                  </span>
                  <em>{row.provider}</em>
                </span>
                <span className="mono">{formatNumber(row.calls)}</span>
                <span className="mono">{formatTokens(row.inputTokens)}</span>
                <span className="mono">{formatTokens(row.outputTokens)}</span>
                <span className="mono">
                  {row.priced ? money(row.cost, row.currency) : <span className="tag tag-warn">未定价</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="billing-prices" aria-label="价格表">
        <header className="section-head">
          <h3>价格表</h3>
          <div className="section-head__actions">
            {editingPrices ? (
              <>
                <button type="button" className="btn btn-sm" onClick={() => setDraft(prices)}>
                  重置
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void savePrices()}
                  disabled={busy === "save"}
                >
                  {busy === "save" ? <IconLoader size={12} className="spin" /> : <IconCheck size={12} />} 保存价格表
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => setEditingPrices(true)}>
                编辑价格
              </button>
            )}
          </div>
        </header>
        <p className="section-hint">
          价格单位：每百万 token。`*` 表示该 provider 下的兜底价格。未定价的模型不会显示 0 假装免费。
        </p>
        {draft.length === 0 ? (
          <div className="resource-empty">还没有价格配置。点「编辑价格」新增一条。</div>
        ) : (
          <div className={`price-table${editingPrices ? " is-editing" : ""}`}>
            <div className="price-table__head">
              <span>Provider</span>
              <span>模型</span>
              <span>币种</span>
              <span>输入 / 1M</span>
              <span>输出 / 1M</span>
              <span>缓存输入</span>
              <span />
            </div>
            {(editingPrices ? draft : prices).map((price, index) => (
              <div className="price-table__row" key={`${price.provider}:${price.model}:${index}`}>
                {editingPrices ? (
                  <select
                    className="select"
                    value={price.provider}
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) =>
                          i === index ? { ...item, provider: event.target.value as ProviderId } : item,
                        ),
                      )
                    }
                  >
                    {PROVIDERS.map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="mono">{price.provider}</span>
                )}
                {editingPrices ? (
                  <input
                    className="input"
                    value={price.model}
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) => (i === index ? { ...item, model: event.target.value } : item)),
                      )
                    }
                    placeholder="模型 ID 或 *"
                  />
                ) : (
                  <span className="mono">{price.model}</span>
                )}
                {editingPrices ? (
                  <select
                    className="select"
                    value={price.currency}
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) =>
                          i === index ? { ...item, currency: event.target.value as "CNY" | "USD" } : item,
                        ),
                      )
                    }
                  >
                    <option value="CNY">CNY</option>
                    <option value="USD">USD</option>
                  </select>
                ) : (
                  <span>{price.currency}</span>
                )}
                {editingPrices ? (
                  <input
                    className="input mono"
                    type="number"
                    min={0}
                    step="0.01"
                    value={price.inputPerMTokens}
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) =>
                          i === index ? { ...item, inputPerMTokens: Number(event.target.value) } : item,
                        ),
                      )
                    }
                  />
                ) : (
                  <span className="mono">{price.inputPerMTokens}</span>
                )}
                {editingPrices ? (
                  <input
                    className="input mono"
                    type="number"
                    min={0}
                    step="0.01"
                    value={price.outputPerMTokens}
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) =>
                          i === index ? { ...item, outputPerMTokens: Number(event.target.value) } : item,
                        ),
                      )
                    }
                  />
                ) : (
                  <span className="mono">{price.outputPerMTokens}</span>
                )}
                {editingPrices ? (
                  <input
                    className="input mono"
                    type="number"
                    min={0}
                    step="0.01"
                    value={price.cachedInputPerMTokens ?? ""}
                    placeholder="—"
                    onChange={(event) =>
                      setDraft((prev) =>
                        prev.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                cachedInputPerMTokens: event.target.value === "" ? undefined : Number(event.target.value),
                              }
                            : item,
                        ),
                      )
                    }
                  />
                ) : (
                  <span className="mono">{price.cachedInputPerMTokens ?? "—"}</span>
                )}
                {editingPrices ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setDraft((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="删除该价格"
                  >
                    <IconTrash size={12} />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
            {editingPrices ? (
              <button
                type="button"
                className="btn btn-sm price-table__add"
                onClick={() =>
                  setDraft((prev) => [
                    ...prev,
                    {
                      provider: "deepseek",
                      model: "*",
                      currency: "CNY",
                      inputPerMTokens: 0,
                      outputPerMTokens: 0,
                    },
                  ])
                }
              >
                <IconPlus size={11} /> 新增一行
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
