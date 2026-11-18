/**
 * 测试辅助：本地假 HTTP 服务器（动态端口，listen(0)）+ 流式结果收集。
 * 只在测试中使用，不参与运行时逻辑。
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatChunk, Usage } from "@super-work/core";

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** 起一个监听 127.0.0.1 随机端口的 HTTP 服务器（避免占用 7788 / 5178）。 */
export async function startServer(handler: RequestHandler): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        handler(req, res, body);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 输出一组 SSE 行（调用方自己保证 data:/event: 前缀与空行分隔）。 */
export function writeSse(
  res: ServerResponse,
  lines: string[],
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "close",
    ...headers,
  });
  for (const line of lines) res.write(`${line}\n`);
  res.end();
}

/** 发送一个 JSON 错误响应。 */
export function writeError(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    connection: "close",
  });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export async function collectChunks(iterable: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

export function concatText(chunks: ChatChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<ChatChunk, { type: "text" }> => chunk.type === "text")
    .map((chunk) => chunk.text)
    .join("");
}

export function concatReasoning(chunks: ChatChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<ChatChunk, { type: "reasoning" }> => chunk.type === "reasoning")
    .map((chunk) => chunk.text)
    .join("");
}

export function usageOf(chunks: ChatChunk[]): Usage | undefined {
  for (const chunk of chunks) {
    if (chunk.type === "usage") return chunk.usage;
  }
  return undefined;
}

export function doneChunk(chunks: ChatChunk[]): Extract<ChatChunk, { type: "done" }> | undefined {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (chunk?.type === "done") return chunk;
  }
  return undefined;
}

export function deltaCount(chunks: ChatChunk[]): number {
  return chunks.filter((chunk) => chunk.type === "text" || chunk.type === "reasoning").length;
}
