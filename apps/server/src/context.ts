import type { ContextInsight, ContextRunSummary, RunEvent } from "@super-work/core";
import type { Storage } from "./storage.js";

/** 从运行事件里汇总上下文洞察。 */
export function buildContextSummary(storage: Storage, runId: string): ContextRunSummary | undefined {
  const events = storage.eventsAfter(runId, 0, 20_000);
  const calls: Array<ContextInsight & { at: number }> = [];
  for (const { event } of events) {
    if (event.type !== "context") continue;
    if (!event.insight) continue;
    calls.push({ ...event.insight, at: event.at ?? 0 });
  }
  if (calls.length === 0) return undefined;
  let peakPromptTokens = 0;
  let peakUtilization: number | undefined;
  let totalPromptTokens = 0;
  let tightest: ContextRunSummary["tightest"];
  for (const call of calls) {
    peakPromptTokens = Math.max(peakPromptTokens, call.promptTokens);
    totalPromptTokens += call.promptTokens;
    if (typeof call.utilization === "number") {
      if (peakUtilization === undefined || call.utilization > peakUtilization) peakUtilization = call.utilization;
      if (call.contextWindow && (!tightest || call.utilization > tightest.utilization)) {
        tightest = { model: call.model, contextWindow: call.contextWindow, utilization: call.utilization };
      }
    }
  }
  return { runId, calls, peakPromptTokens, peakUtilization, tightest, totalPromptTokens };
}

export function isContextEvent(event: RunEvent): event is Extract<RunEvent, { type: "context" }> {
  return event.type === "context";
}
