import type { CSSProperties } from "react";
import type { ProviderId } from "@super-work/core";
import { brandStyle } from "../lib/brand";
import { BrandIcon } from "./BrandIcon";

export interface ProviderRowProps {
  id: ProviderId;
  name: string;
  short: string;
  color: string;
  kind?: string;
  connected: boolean;
  connectionCount: number;
  modelCount?: number;
  selected?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  className?: string;
}

export function ProviderRow({
  id,
  name,
  color,
  connected,
  connectionCount,
  modelCount,
  selected,
  onClick,
  ariaLabel,
  className,
}: ProviderRowProps) {
  const stateText =
    id === "mock" ? "无需凭证" : connected ? `${connectionCount} 个连接` : "未连接";
  const stateClass = connected || id === "mock" ? "is-on" : "";
  return (
    <button
      type="button"
      className={`provider-row${selected ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      style={brandStyle(color) as unknown as CSSProperties}
      aria-label={ariaLabel ?? `${name}，${stateText}`}
      aria-pressed={selected}
    >
      <span className="dot dot-brand" aria-hidden="true" />
      <BrandIcon provider={id} size={20} title={`${name} 官方商标`} />
      <span className="provider-row__name">{name}</span>
      {modelCount != null && modelCount > 0 ? (
        <span className="provider-row__state" title="可用模型数">
          {modelCount}
        </span>
      ) : null}
      <span className={`provider-row__state ${stateClass}`}>{stateText}</span>
    </button>
  );
}
