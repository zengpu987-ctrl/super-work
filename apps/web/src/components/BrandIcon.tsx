import type { CSSProperties } from "react";
import type { ProviderId } from "@super-work/core";
import { BRAND_ICONS } from "../lib/brandIcons";
import { IconGlobe, IconLink, IconSpark } from "./Icons";

/** 没有官方商标的平台，用字形兜底（中转站 / 第三方 / 演示模型）。 */
const FALLBACK_GLYPH: Partial<Record<ProviderId, typeof IconLink>> = {
  relay: IconLink,
  thirdparty: IconGlobe,
  mock: IconSpark,
};

export interface BrandIconProps {
  provider: ProviderId;
  /** 底片边长（px），标记约为其 62% */
  size?: number;
  className?: string;
  /** 悬停提示；为空时视为纯装饰 */
  title?: string;
}

/**
 * 平台官方图标：浅色底片 + 官方 SVG 标记。
 * 统一尺寸与圆角，任何位置插入都不破坏行高。
 */
export function BrandIcon({ provider, size = 20, className, title }: BrandIconProps) {
  const meta = BRAND_ICONS[provider];
  const style = { "--bi-size": `${size}px` } as CSSProperties;
  const cls = `brand-icon${className ? ` ${className}` : ""}`;
  if (meta) {
    return (
      <span className={cls} style={style} title={title} aria-hidden="true">
        <img src={meta.src} alt="" draggable={false} loading="lazy" />
      </span>
    );
  }
  const Glyph = FALLBACK_GLYPH[provider] ?? IconLink;
  return (
    <span className={`${cls} brand-icon--glyph`} style={style} title={title} aria-hidden="true">
      <Glyph size={Math.max(8, Math.round(size * 0.52))} />
    </span>
  );
}
