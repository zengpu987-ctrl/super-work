/** 格式化工具：token / 耗时 / 相对时间 / 截断。全部纯函数，无副作用。 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 1280 → 1.3k；1_234_567 → 1.2M。 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimZero(value / 1_000)}k`;
  return groupThousands(Math.round(value));
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** token 数：带单位与千分位的紧凑写法。 */
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "0";
  return formatNumber(value);
}

/** 耗时：480ms / 3.4s / 1m 12s / 2h 05m。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(/\.0$/, "")}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 14:03 / 11-16。 */
export function formatRelative(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  const diff = now - timestamp;
  if (diff < 0) return formatClock(timestamp);
  if (diff < 45_000) return "刚刚";
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return `昨天 ${formatClock(timestamp)}`;
  const date = new Date(timestamp);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 时钟：14:03 / 11-16 14:03。 */
export function formatClock(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return time;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

/** 凭证有效期：剩余 2 小时 / 已过期 / 长期有效。 */
export function formatExpiry(expiresAt: number | null | undefined, now = Date.now()): string {
  if (!expiresAt || !Number.isFinite(expiresAt)) return "长期有效";
  const diff = expiresAt - now;
  if (diff <= 0) return "已过期";
  if (diff < HOUR) return `剩余 ${Math.max(1, Math.round(diff / MINUTE))} 分钟`;
  if (diff < DAY) return `剩余 ${Math.round(diff / HOUR)} 小时`;
  return `剩余 ${Math.round(diff / DAY)} 天`;
}

/** 截断，保留结尾省略号；对多行文本先去换行。 */
export function truncate(text: string | null | undefined, max = 120): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 文本尾部截断（用于"基于上一轮答案继续"的上下文注入）。 */
export function tail(text: string | null | undefined, max = 1200): string {
  if (!text) return "";
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `…${clean.slice(clean.length - max)}`;
}

export function formatCount(value: number): string {
  return groupThousands(value);
}

/** 粗略 token 估算（中文约 1 字 = 1 token，英文约 4 字符 = 1 token）。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
  }
  const rest = Math.max(0, text.length - cjk);
  return Math.round(cjk * 1.05 + rest / 4);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
