/**
 * provider 品牌色 → 深色界面可用的派生色。
 * catalog 里 kimi=#0b0b0f、xai=#111827 这类近黑色直接画在 #0a0b10 上几乎不可见，
 * 这里按相对亮度混合白色得到"可读的墨色"，并派生低透明度光晕。
 */

export type BrandVars = {
  "--brand": string;
  "--brand-ink": string;
  "--brand-soft": string;
  "--brand-line": string;
};

function parseHex(color: string): [number, number, number] {
  const clean = color.trim().replace(/^#/, "");
  if (clean.length === 3) {
    const [r, g, b] = clean.split("");
    return [parseInt(`${r}${r}`, 16), parseInt(`${g}${g}`, 16), parseInt(`${b}${b}`, 16)];
  }
  if (clean.length >= 6) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  return [148, 163, 184];
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const [r, g, b] = parseHex(color);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function mixWithWhite(color: string, amount: number): string {
  const [r, g, b] = parseHex(color);
  const t = Math.max(0, Math.min(1, amount));
  return toHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

function rgba(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 深色背景上的可读品牌色：亮度不足则逐级提亮。 */
export function brandInk(color: string): string {
  const luminance = relativeLuminance(color);
  if (luminance >= 0.28) return color;
  const needed = Math.min(0.86, (0.3 - luminance) / 0.7 + 0.18);
  return mixWithWhite(color, needed);
}

export function brandVars(color: string): BrandVars {
  const ink = brandInk(color);
  return {
    "--brand": color,
    "--brand-ink": ink,
    "--brand-soft": rgba(ink, 0.14),
    "--brand-line": rgba(ink, 0.42),
  };
}

export function brandStyle(color: string): Record<string, string> {
  return brandVars(color) as unknown as Record<string, string>;
}

/** 把任意字符串稳定映射到 0..n-1，用于没有品牌色的兜底着色。 */
export function hashIndex(value: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 1_000_003;
  }
  return modulo > 0 ? hash % modulo : 0;
}
