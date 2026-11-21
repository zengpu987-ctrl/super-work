/**
 * 模型平台的官方品牌标记（本地打包，离线可用）。
 *
 * 图标来自 @lobehub/icons-static-svg（MIT，品牌商标归各厂商所有），
 * 已裁剪为 apps/web/public/brand 下 11 个 SVG；新增平台时把官方 SVG 放进去即可。
 * 深色界面统一用浅色小底片承托，保留官方配色（Kimi / OpenAI 等含黑色笔画，
 * 直接放在深色底上会看不见）。
 */
import type { ProviderId } from "@super-work/core";

export interface BrandIconMeta {
  /** public 下的相对路径（vite 原样拷贝，服务端同源托管） */
  src: string;
  /** 官方主色，用于底片的极轻着色与 hover 光晕 */
  tint: string;
}

export const BRAND_ICONS: Partial<Record<ProviderId, BrandIconMeta>> = {
  deepseek: { src: "/brand/deepseek.svg", tint: "#4d6bfe" },
  "deepseek-account": { src: "/brand/deepseek.svg", tint: "#4d6bfe" },
  kimi: { src: "/brand/kimi.svg", tint: "#1783ff" },
  openai: { src: "/brand/openai.svg", tint: "#10a37f" },
  anthropic: { src: "/brand/claude.svg", tint: "#d97757" },
  zhipu: { src: "/brand/zhipu.svg", tint: "#3859ff" },
  qwen: { src: "/brand/qwen.svg", tint: "#615ced" },
  volcengine: { src: "/brand/doubao.svg", tint: "#1e37fc" },
  minimax: { src: "/brand/minimax.svg", tint: "#e2167e" },
  gemini: { src: "/brand/gemini.svg", tint: "#3186ff" },
  xai: { src: "/brand/grok.svg", tint: "#c7d0dd" },
  workbuddy: { src: "/brand/workbuddy.svg", tint: "#009273" },
};

/** provider 是否有官方标记（用于 UI 决定要不要退化到短名/字形）。 */
export function hasBrandIcon(provider: ProviderId): boolean {
  return Boolean(BRAND_ICONS[provider]);
}
