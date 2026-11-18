/**
 * 纯工具函数：并发控制、usage 合并、超时信号、文本截断。
 * 不依赖 @super-work/core 的运行时（只做类型引用），方便单测。
 */
import type { Usage } from "@super-work/core";

/** 每次模型调用的默认超时（DESIGN §6：默认 180s）。 */
export const DEFAULT_TIMEOUT_MS = 180_000;

/** 给其他模型看的单份历史答案上限。 */
export const PER_ANSWER_LIMIT = 4_000;
/** 省钱模式下给其他模型看的单份材料上限（DESIGN v0.0.3 §4）。 */
export const CHEAP_PER_ANSWER_LIMIT = 2_000;
/** 给其他模型看的历史答案合计上限。 */
export const TOTAL_ANSWER_LIMIT = 12_000;
/** final.delta 的切块长度（按码点计）。 */
export const FINAL_CHUNK_SIZE = 48;

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const;

/** 合并两份 usage（逐字段相加，缺省视为 0），返回新对象。 */
export function mergeUsage(target: Usage = {}, add?: Usage): Usage {
  const out: Usage = { ...target };
  if (!add) return out;
  for (const key of USAGE_KEYS) {
    const value = add[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = (out[key] ?? 0) + value;
    }
  }
  return out;
}

/** usage 是否含有任何有效数字。 */
export function hasUsage(usage?: Usage): boolean {
  if (!usage) return false;
  return USAGE_KEYS.some((key) => typeof usage[key] === "number");
}

/** 按字符（码点）截断，附一句说明，避免上下文爆炸。 */
export function truncateText(text: string, limit: number): string {
  if (!text) return "";
  const max = Math.max(0, Math.floor(limit));
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）`;
}

/** 把任意异常变成可读的一句话（不抛）。 */
export function errorMessage(error: unknown, limit = 400): string {
  let raw: string;
  if (error instanceof Error) raw = error.message || error.name;
  else if (typeof error === "string") raw = error;
  else raw = String(error);
  raw = raw.trim() || "未知错误";
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

/** 是否是取消/超时类异常（AbortSignal 触发）。 */
export function isAbortLike(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return typeof DOMException !== "undefined" && error instanceof DOMException;
}

/** 判断是不是 AsyncIterable（兼容 async generator / 自定义迭代器）。 */
export function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

/** 把文本按码点切成固定长度的小块（不切开代理对）。 */
export function chunkText(text: string, size = FINAL_CHUNK_SIZE): string[] {
  if (!text) return [];
  const width = Math.max(1, Math.floor(size));
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < points.length; i += width) {
    chunks.push(points.slice(i, i + width).join(""));
  }
  return chunks;
}

export interface CallSignal {
  /** 外部取消 + 本次超时合并后的信号，交给 callModel。 */
  signal: AbortSignal;
  /** 仅超时信号，用来区分"用户取消"与"调用超时"。 */
  timeoutSignal: AbortSignal;
}

/** 构造单次模型调用的超时信号（AbortSignal.any + AbortSignal.timeout）。 */
export function makeCallSignal(parent: AbortSignal | undefined, timeoutMs: number): CallSignal {
  const ms = Math.max(1, Math.floor(timeoutMs));
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal = parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal;
  return { signal, timeoutSignal };
}

/**
 * Promise.allSettled 风格的并发池：
 * - 每个任务自己负责把流式事件逐块 emit（所以调用方不需要等全部完成才拿到输出）；
 * - 单个任务拒绝只体现在它自己的 PromiseSettledResult 里，不会中断其他任务；
 * - 返回顺序与 items 顺序一致。
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => runWorker()));
  return results;
}

/** 取 mapPool 结果里成功产出的值。 */
export function settledValues<T>(results: Array<PromiseSettledResult<T>>): T[] {
  const values: T[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") values.push(result.value);
  }
  return values;
}
