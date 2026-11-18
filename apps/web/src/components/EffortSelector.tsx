/**
 * 每模型强度档位选择器（独立组件层，不依赖 App / useWorkbench）。
 *
 * 契约：`@super-work/core` 的 EffortLevel / EFFORT_*；请求体字段 `participant.effort`。
 * 运行中热调用 `POST /api/runs/:id/effort { participantId, effort }` 由接入方完成，
 * 本组件只负责"选择一个档位"与无障碍交互。
 *
 * 用法（编排行，96×24）：
 *   <EffortSelector value={spec.effort} onChange={(e) => updateEffort(key, e)} />
 * 用法（运行中卡片，带辅助文案）：
 *   <EffortSelector value={view.effort} size="md" helperText="运行中修改，下一次调用生效"
 *      onChange={(e) => changeEffortLive(participant.id, e)} />
 * 只读展示（历史 / chips）：
 *   <EffortBadge level={view.effort} withName />
 */
import { useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { EffortLevel } from "@super-work/core";
import {
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  effortOf,
  effortVars,
} from "../lib/effort";
import "../styles/effort.css";

export interface EffortSelectorProps {
  /** 当前档位；缺省按 core 的默认档 Medium。 */
  value?: EffortLevel;
  /** 选中即回调（点击 / 方向键 / Home / End 都会触发）。 */
  onChange: (effort: EffortLevel) => void;
  /** sm = 96×24（编排行内）；md = 更大触控尺寸（卡片内）。默认 sm。 */
  size?: "sm" | "md";
  /** 显示英文短标签 L/M/F/Mx/U（默认）或全称 Low/…/Ultra。 */
  labels?: "short" | "full";
  /** 只读/请求中禁用。 */
  disabled?: boolean;
  /** 可选可见前置文案，如「强度」。 */
  label?: string;
  /** 可选辅助文案（如「运行中修改，下次生效」）；组件不做运行态判断。 */
  helperText?: string;
  className?: string;
  ariaLabel?: string;
}

export function EffortSelector({
  value,
  onChange,
  size = "sm",
  labels = "short",
  disabled = false,
  label,
  helperText,
  className,
  ariaLabel,
}: EffortSelectorProps) {
  const current = value ?? DEFAULT_EFFORT;
  const currentDisplay = effortOf(current);
  const currentLevel = currentDisplay.level;
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const currentIndex = Math.max(
    0,
    EFFORT_OPTIONS.findIndex((option) => option.id === current),
  );

  const select = (effort: EffortLevel, index: number): void => {
    if (disabled) return;
    optionRefs.current[index]?.focus();
    if (effort !== current) onChange(effort);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    let target: EffortLevel | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      const index = (currentIndex + 1) % EFFORT_OPTIONS.length;
      target = EFFORT_OPTIONS[index]?.id ?? null;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      const index = (currentIndex - 1 + EFFORT_OPTIONS.length) % EFFORT_OPTIONS.length;
      target = EFFORT_OPTIONS[index]?.id ?? null;
    } else if (event.key === "Home") {
      target = EFFORT_OPTIONS[0]?.id ?? null;
    } else if (event.key === "End") {
      target = EFFORT_OPTIONS[EFFORT_OPTIONS.length - 1]?.id ?? null;
    } else {
      return;
    }
    if (!target) return;
    event.preventDefault();
    const index = EFFORT_OPTIONS.findIndex((option) => option.id === target);
    if (index >= 0) select(target, index);
  };

  const rootClass = [
    "effort",
    `effort--${size}`,
    `effort--${labels}`,
    disabled ? "is-disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} style={effortVars(current) as CSSProperties}>
      {label ? <span className="effort__label">{label}</span> : null}
      <div
        className="effort__options"
        role="radiogroup"
        aria-label={ariaLabel ?? (label ? `${label}档位` : "模型推理强度")}
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
      >
        {EFFORT_OPTIONS.map((option, index) => {
          const active = option.id === current;
          // 规格：选中格及左侧所有格填充（level <= 选中档）。
          const filled = option.level <= currentLevel;
          const text = labels === "full" ? option.name : option.short;
          return (
            <button
              key={option.id}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${option.name}：${option.description}`}
              title={option.tooltip}
              className={`effort__option${filled ? " is-filled" : ""}${active ? " is-active" : ""}`}
              style={effortVars(option.id) as CSSProperties}
              tabIndex={disabled ? -1 : active ? 0 : -1}
              disabled={disabled}
              data-effort={option.id}
              data-effort-level={option.level}
              onClick={() => select(option.id, index)}
            >
              <span className="effort__text">{text}</span>
            </button>
          );
        })}
      </div>
      {helperText ? <span className="effort__helper">{helperText}</span> : null}
    </div>
  );
}

export interface EffortBadgeProps {
  level?: EffortLevel | null;
  /** true 显示全称（Ultra），false 显示中文单字（极）。 */
  withName?: boolean;
  className?: string;
}

/** 只读档位徽标：卡片头部 / chips / 历史详情。 */
export function EffortBadge({ level, withName = false, className }: EffortBadgeProps) {
  const display = effortOf(level);
  return (
    <span
      className={["effort-badge", className ?? ""].filter(Boolean).join(" ")}
      style={effortVars(display.id) as CSSProperties}
      title={display.tooltip}
      aria-label={`强度 ${display.name}：${display.description}`}
    >
      <span className="effort-badge__dot" aria-hidden="true" />
      <span className="effort-badge__text">{withName ? display.name : display.badge}</span>
    </span>
  );
}
