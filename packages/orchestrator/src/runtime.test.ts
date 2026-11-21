import test from "node:test";
import assert from "node:assert/strict";
import { effectiveCallTimeoutMs } from "./runtime.js";

test("模型调用超时：KIMI 慢模型保有 180s 下限，其他平台保持配置值", () => {
  assert.equal(effectiveCallTimeoutMs("kimi", "k3.1-pro-highspeed", 90_000), 180_000);
  assert.equal(effectiveCallTimeoutMs("kimi", "k3.1-pro", 300_000), 300_000);
  assert.equal(effectiveCallTimeoutMs("openai", "gpt-6.2-sol", 90_000), 90_000);
  assert.equal(effectiveCallTimeoutMs("kimi", "k3.1-pro-highspeed", 30_000), 180_000);
});
