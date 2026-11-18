import type { ModelInfo, ProviderId } from "@super-work/core";

/**
 * 把上游实时目录合并进本地模型池。
 *
 * 规则：
 * - 新 id → 追加，并统一标记 provider / via（按凭证模式：api-key → api，订阅 → subscription）；
 * - 已存在的 id → 只更新上游能给的元数据（名称 / 上下文 / 能力），保留本地额外字段（tags 等）；
 * - 上游这次没返回的旧模型 → 原样保留（用户可能仍在用，不静默删除）。
 */
export function mergeDiscoveredModels(
  current: ModelInfo[],
  incoming: ModelInfo[],
  provider: ProviderId,
  via: "api" | "subscription",
): ModelInfo[] {
  const byId = new Map<string, ModelInfo>(current.map((model) => [model.id, model]));
  for (const model of incoming) {
    if (!model || typeof model.id !== "string" || model.id.trim() === "") continue;
    const previous = byId.get(model.id);
    byId.set(model.id, {
      ...previous,
      ...model,
      provider,
      via: model.via ?? via,
    });
  }
  return [...byId.values()];
}
