import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@super-work/core";
import { mergeDiscoveredModels } from "./model-sync.js";

const existing: ModelInfo[] = [
  {
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    provider: "openai",
    contextWindow: 400000,
    via: "subscription",
    tags: ["flagship"],
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    provider: "openai",
    contextWindow: 400000,
    via: "subscription",
  },
];

test("mergeDiscoveredModels：新模型追加，已有 id 只更新元数据，旧模型不丢", () => {
  const incoming: ModelInfo[] = [
    {
      id: "gpt-6.1-terra",
      name: "GPT-6.1 Terra",
      provider: "openai",
      contextWindow: 500000,
      via: "subscription",
    },
    {
      id: "gpt-6.2-sol",
      name: "GPT-6.2-Sol",
      provider: "openai",
      contextWindow: 500000,
      reasoning: true,
      via: "subscription",
    },
  ];

  const merged = mergeDiscoveredModels(existing, incoming, "openai", "subscription");
  const byId = new Map(merged.map((m) => [m.id, m]));

  assert.equal(merged.length, 3, "两条旧模型保留 + 一条新模型");
  assert.equal(byId.get("gpt-6.1-terra")?.contextWindow, 500000, "已有 id 的上下文窗口要更新");
  assert.deepEqual(
    byId.get("gpt-6.1-terra")?.tags,
    ["flagship"],
    "本地额外字段（tags）不能被上游数据抹掉",
  );
  assert.equal(byId.get("gpt-6.2-sol")?.name, "GPT-6.2-Sol");
  assert.equal(byId.get("gpt-6.2-sol")?.reasoning, true);
  assert.equal(byId.get("gpt-6.2-sol")?.provider, "openai");
  assert.equal(byId.get("gpt-6-sol")?.contextWindow, 400000, "上游这次没返回的旧模型保持原样");
});

test("mergeDiscoveredModels：via 按凭证模式统一标记", () => {
  const merged = mergeDiscoveredModels(
    [],
    [{ id: "k3.1-pro", name: "K3.1 Pro", provider: "kimi" }],
    "kimi",
    "subscription",
  );
  assert.equal(merged[0]?.via, "subscription");
  assert.equal(merged[0]?.provider, "kimi");
});
