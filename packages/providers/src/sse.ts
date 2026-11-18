/**
 * Server-Sent Events 解析。
 *
 * 覆盖各家的流式响应差异：
 * - 行尾 `\n` / `\r\n` 都接受；
 * - `data:` 可以多行，按 SSE 规范用 `\n` 连接；
 * - `event:` 字段独立出现（Anthropic / ChatGPT Codex 的 SSE 都带）；
 * - 注释行（`:` 开头，常见于 keep-alive）忽略；
 * - `[DONE]` 哨兵直接结束迭代（不再产出一条无意义的 data）；
 * - 每个 data 行就是一个完整 JSON（Gemini 的情况）由调用方自行 JSON.parse。
 *
 * 生命周期：SseChannel 持有 reader，chat() 在 finally 里调用 `cancel()` 释放连接。
 */

export interface SseMessage {
  /** SSE 的 event 名（没有则为 undefined） */
  event?: string;
  /** 拼接后的 data 内容（不含 "data:" 前缀） */
  data: string;
  id?: string;
  retry?: number;
}

export interface SseChannelOptions {
  /** 外部取消信号（超时合并后的 signal） */
  signal?: AbortSignal;
  /** 是否把 `data: [DONE]` 当作流结束（默认 true） */
  stopOnDone?: boolean;
}

/** 从 fetch Response 的 body 创建 SSE 通道；没有 body 时给出可读错误。 */
export function sseChannel(
  body: ReadableStream<Uint8Array> | null,
  options: SseChannelOptions = {},
): SseChannel {
  if (!body) {
    throw new Error("响应没有可读取的流（body 为空），无法解析 SSE");
  }
  return new SseChannel(body, options);
}

export class SseChannel {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly signal?: AbortSignal;
  private readonly stopOnDone: boolean;
  private cancelled = false;
  private closed = false;

  constructor(stream: ReadableStream<Uint8Array>, options: SseChannelOptions = {}) {
    this.reader = stream.getReader();
    this.signal = options.signal;
    this.stopOnDone = options.stopOnDone ?? true;
  }

  /** 逐条产出 SSE 消息。生成器结束/提前 return 时由调用方调用 cancel()。 */
  async *messages(): AsyncGenerator<SseMessage> {
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName: string | undefined;
    let dataLines: string[] = [];
    let lastId: string | undefined;
    let lastRetry: number | undefined;

    const take = (): SseMessage | null => {
      if (dataLines.length === 0 && eventName === undefined) return null;
      const message: SseMessage = { data: dataLines.join("\n") };
      if (eventName !== undefined) message.event = eventName;
      if (lastId !== undefined) message.id = lastId;
      if (lastRetry !== undefined) message.retry = lastRetry;
      eventName = undefined;
      dataLines = [];
      lastId = undefined;
      lastRetry = undefined;
      return message;
    };

    const handleLine = (line: string): SseMessage | null => {
      if (line === "") return take();
      if (line.startsWith(":")) return null; // 注释 / keep-alive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value;
      else if (field === "id") lastId = value;
      else if (field === "retry") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) lastRetry = parsed;
      }
      return null;
    };

    const isDone = (message: SseMessage): boolean =>
      this.stopOnDone && message.data.trim() === "[DONE]";

    try {
      while (!this.closed) {
        if (this.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const { done, value } = await this.reader.read();
        if (done) {
          this.closed = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          const message = handleLine(line);
          if (message) {
            if (isDone(message)) return;
            yield message;
          }
          newline = buffer.indexOf("\n");
        }
      }

      buffer += decoder.decode();
      if (buffer.length > 0) {
        let line = buffer;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const message = handleLine(line);
        if (message) {
          if (isDone(message)) return;
          yield message;
        }
        buffer = "";
      }

      const tail = take();
      if (tail) {
        if (isDone(tail)) return;
        yield tail;
      }
    } finally {
      this.closed = true;
    }
  }

  /** 释放底层流（chat() 的 finally 里调用）。 */
  async cancel(reason?: unknown): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      await this.reader.cancel(reason);
    } catch {
      /* 流可能已经自然结束，忽略 */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* 已经释放则忽略 */
    }
  }
}

/** 便捷入口：把一个 ReadableStream 解析成 async generator（内部负责 cancel）。 */
export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
  options: SseChannelOptions = {},
): AsyncGenerator<SseMessage> {
  const channel = sseChannel(body, options);
  try {
    yield* channel.messages();
  } finally {
    await channel.cancel();
  }
}
