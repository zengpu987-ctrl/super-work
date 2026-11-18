/** 设置 → 性能：并发 1-8、超时 15-300s、默认 token、流式合并间隔。 */
import { useEffect, useState } from "react";
import type { AppSettings, PerformanceSettings } from "@super-work/core";
import { DEFAULT_PERFORMANCE_SETTINGS } from "../lib/v3";
import { IconCheck, IconGauge, IconInfo, IconRefresh } from "./Icons";

export interface PerformancePanelProps {
  settings: AppSettings;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
}

const DEFAULTS = DEFAULT_PERFORMANCE_SETTINGS;

export function PerformancePanel({ settings, onSave }: PerformancePanelProps) {
  const [perf, setPerf] = useState<PerformanceSettings>({ ...DEFAULTS, ...(settings.performance ?? {}) });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setPerf({ ...DEFAULTS, ...(settings.performance ?? {}) });
  }, [settings.performance]);

  const update = <K extends keyof PerformanceSettings>(key: K, value: PerformanceSettings[K]): void => {
    setPerf((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onSave({
        performance: {
          concurrency: Math.max(1, Math.min(8, Math.round(perf.concurrency ?? 3))),
          timeoutMs: Math.max(15_000, Math.min(300_000, Math.round(perf.timeoutMs ?? 90_000))),
          defaultMaxTokens: Math.max(256, Math.min(32768, Math.round(perf.defaultMaxTokens ?? 4096))),
          streamChunkThrottleMs: Math.max(0, Math.min(2_000, Math.round(perf.streamChunkThrottleMs ?? 120))),
        },
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-panel__head">
        <span className="settings-panel__icon">
          <IconGauge size={16} />
        </span>
        <div>
          <h3>性能调控</h3>
          <p>修改只影响新任务；运行中的任务使用创建时的快照。</p>
        </div>
      </div>

      <section className="settings-panel__section perf-list">
        <SliderField
          label="并发调用数"
          hint="同时发起的模型请求数（默认 3）。1 = 严格串行；8 = 最快但更容易触发上游限流。"
          value={perf.concurrency ?? 3}
          min={1}
          max={8}
          step={1}
          suffix={`${perf.concurrency ?? 3} 路`}
          onChange={(value) => update("concurrency", value)}
        />
        <SliderField
          label="单模型调用超时"
          hint="超过该时长会中断本次调用并标记失败，不阻塞其他模型。"
          value={Math.round((perf.timeoutMs ?? 90_000) / 1000)}
          min={15}
          max={300}
          step={5}
          suffix={`${Math.round((perf.timeoutMs ?? 90_000) / 1000)}s`}
          onChange={(value) => update("timeoutMs", value * 1000)}
        />
        <SliderField
          label="默认最大输出 token"
          hint="模型未单独声明时的输出上限，仍会与档位倍率、单次调用上限夹紧。"
          value={perf.defaultMaxTokens ?? 4096}
          min={256}
          max={32768}
          step={256}
          suffix={String(perf.defaultMaxTokens ?? 4096)}
          onChange={(value) => update("defaultMaxTokens", value)}
        />
        <SliderField
          label="流式合并间隔"
          hint="0 = 不合并（每条增量都渲染）；数值越大越省渲染，但文字会更“跳”。"
          value={perf.streamChunkThrottleMs ?? 120}
          min={0}
          max={1_000}
          step={20}
          suffix={`${perf.streamChunkThrottleMs ?? 120}ms`}
          onChange={(value) => update("streamChunkThrottleMs", value)}
        />
      </section>

      <div className="settings-panel__foot">
        <span className="settings-panel__note">
          <IconInfo size={11} /> 并发过高时，部分平台可能返回 429；失败只影响该模型，不拖垮整轮。
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setPerf({ ...DEFAULTS });
            setSavedAt(null);
          }}
        >
          <IconRefresh size={12} /> 恢复默认
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
          {savedAt ? <IconCheck size={13} /> : null}
          {saving ? "保存中…" : savedAt ? "已保存" : "保存性能设置"}
        </button>
      </div>
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}

function SliderField({ label, hint, value, min, max, step, suffix, onChange }: SliderFieldProps) {
  return (
    <div className="perf-field">
      <div className="perf-field__head">
        <span className="perf-field__label">{label}</span>
        <span className="perf-field__value mono">{suffix}</span>
      </div>
      <div className="perf-field__controls">
        <input
          className="perf-field__slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
        />
        <input
          className="input perf-field__number"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
          }}
          aria-label={`${label}数值`}
        />
      </div>
      <p className="perf-field__hint">{hint}</p>
    </div>
  );
}
