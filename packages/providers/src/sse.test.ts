/**
 * SSE 解析测试：\r\n、跨 chunk 缓冲、多行 data、event 名、注释行、[DONE]。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "./index.js";
import type { SseMessage } from "./index.js";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(parts: string[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of parseSse(streamOf(parts))) messages.push(message);
  return messages;
}

test("parseSse：\\r\\n + 多行 data + event 名 + 注释 + [DONE]", async () => {
  const messages = await collect([
    "event: message_start\r\ndata: {\"a\":1}\r\n\r\n",
    ": keep-alive\r\n",
    "data: line1\r\ndata: line2\r\n\r\n",
    "data: [DONE]\r\n\r\n",
    "data: 不会到达\r\n\r\n",
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { event: "message_start", data: '{"a":1}' });
  assert.deepEqual(messages[1], { data: "line1\nline2" });
});

test("parseSse：跨 chunk 边界 + 末尾无换行也能取出消息", async () => {
  const messages = await collect([
    "event: x\r",
    "\ndata: hel",
    "lo\r\n\r\n",
    "data: tail",
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { event: "x", data: "hello" });
  assert.deepEqual(messages[1], { data: "tail" });
});

test("parseSse：只有 data 的 OpenAI 风格事件", async () => {
  const messages = await collect([
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":1}}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.event, undefined);
  assert.match(messages[0]?.data ?? "", /hi/);
  assert.match(messages[1]?.data ?? "", /total_tokens/);
});
