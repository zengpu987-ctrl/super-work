/**
 * 测试辅助：假的 deps.callModel（固定分块流）、事件收集、事件序列断言工具。
 * 只被 *.test.ts 使用，不参与 index.ts 的对外导出。
 */
import type {
  CoordinationAssignment,
  EffortLevel,
  ImageResult,
  OrchestrateArgs,
  OrchestrateResult,
  OrchestratorDeps,
  Participant,
  ProviderId,
  RunEvent,
  RunMode,
  RunOptions,
  StageId,
  Usage,
} from "@super-work/core";
import { orchestrate } from "../index.js";

export interface FakeResponse {
  /** 需要逐块吐出的 text 分块 */
  chunks?: string[];
  /** reasoning 分块 */
  reasoning?: string[];
  usage?: Usage;
  error?: string | Error;
  /** 先正常吐 N 个 text 块，再抛错（模拟流到一半失败） */
  errorAfterChunks?: number;
  /** 每块之间等待的毫秒数 */
  delayMs?: number;
  /** 不产出任何块，一直挂起到 signal 被 abort（用来测超时） */
  hangUntilAbort?: boolean;
}

export interface FakeCall {
  provider: ProviderId;
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  reasoning?: "low" | "medium" | "high";
  effort?: EffortLevel;
  signal?: AbortSignal;
}

export type FakeHandler = (call: FakeCall, index: number) => FakeResponse;

export interface FakeImageCall {
  provider: ProviderId;
  model: string;
  prompt: string;
  size?: string;
  signal?: AbortSignal;
}

export type FakeImageHandler = (
  call: FakeImageCall,
  index: number,
) => ImageResult | Error | { error: string };

export interface FakeKit {
  deps: OrchestratorDeps;
  calls: FakeCall[];
  imageCalls: FakeImageCall[];
}

type FakeChunk =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, 20);
      return;
    }
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 2_000);
  });
}

/** 构造假 deps：按 handler 返回固定分块流；calls 记录每次调用参数。 */
export function createFakeDeps(handler: FakeHandler, imageHandler?: FakeImageHandler): FakeKit {
  const calls: FakeCall[] = [];
  const imageCalls: FakeImageCall[] = [];
  const deps: OrchestratorDeps = {
    callModel(request) {
      const call: FakeCall = {
        provider: request.provider,
        model: request.model,
        system: request.system,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        reasoning: request.reasoning,
        effort: request.effort,
        signal: request.signal,
      };
      calls.push(call);
      const response = handler(call, calls.length - 1);
      return (async function* generate(): AsyncGenerator<FakeChunk> {
        if (response.hangUntilAbort) {
          await waitForAbort(call.signal);
          return;
        }
        const failWith = () =>
          response.error instanceof Error ? response.error : new Error(response.error || "mid-stream failure");
        if (response.error && response.errorAfterChunks === undefined) throw failWith();
        for (const text of response.reasoning ?? []) {
          if (response.delayMs) await sleep(response.delayMs);
          yield { type: "reasoning", text };
        }
        let yielded = 0;
        for (const text of response.chunks ?? []) {
          if (response.errorAfterChunks !== undefined && yielded >= response.errorAfterChunks) {
            throw failWith();
          }
          if (response.delayMs) await sleep(response.delayMs);
          yield { type: "text", text };
          yielded += 1;
        }
        if (response.errorAfterChunks !== undefined) throw failWith();
        if (response.usage) yield { type: "usage", usage: response.usage };
      })();
    },
  };

  if (imageHandler) {
    deps.generateImage = async (request) => {
      const call: FakeImageCall = {
        provider: request.provider,
        model: request.model,
        prompt: request.prompt,
        size: request.size,
        signal: request.signal,
      };
      imageCalls.push(call);
      const response = imageHandler(call, imageCalls.length - 1);
      if (response instanceof Error) throw response;
      if (response && typeof response === "object" && "error" in response) {
        throw new Error(response.error);
      }
      return response;
    };
  }

  return { deps, calls, imageCalls };
}

/** 构造一个参与者。 */
export function makeParticipant(id: string, overrides: Partial<Participant> = {}): Participant {
  return {
    id,
    provider: "mock",
    model: `mock-${id}`,
    label: `模型 ${id}`,
    role: "",
    ...overrides,
  };
}

export interface MakeArgsOptions {
  mode: RunMode;
  participants: Participant[];
  judge?: Participant;
  command?: string;
  options?: RunOptions;
  coordination?: CoordinationAssignment[];
  runId?: string;
}

/** 构造 OrchestrateArgs（request.participants 与 participants 都填好）。 */
export function makeArgs(options: MakeArgsOptions): OrchestrateArgs {
  const command = options.command ?? "请为我的团队写一份本周上线计划";
  return {
    runId: options.runId ?? "run-test",
    request: {
      command,
      mode: options.mode,
      participants: options.participants.map((participant) => ({
        provider: participant.provider,
        model: participant.model,
        role: participant.role,
      })),
      options: options.options,
      coordination: options.coordination,
    },
    participants: options.participants,
    judge: options.judge,
    options: options.options,
  };
}

export interface RunOutcome {
  result: OrchestrateResult;
  events: RunEvent[];
}

/** 跑一次 orchestrate 并收集事件。 */
export async function runOrchestrator(
  args: OrchestrateArgs,
  deps: OrchestratorDeps,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const events: RunEvent[] = [];
  const result = await orchestrate(args, deps, (event) => events.push(event), signal);
  return { result, events };
}

export function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

export function stageIds(events: readonly RunEvent[]): StageId[] {
  return events
    .filter((event): event is Extract<RunEvent, { type: "stage" }> => event.type === "stage")
    .map((event) => event.stage);
}

export function stages(events: readonly RunEvent[]): Array<{ stage: StageId; label: string }> {
  return events
    .filter((event): event is Extract<RunEvent, { type: "stage" }> => event.type === "stage")
    .map((event) => ({ stage: event.stage, label: event.label }));
}

/** 逐次调用校验：model.delta(text) 的累加必须等于 model.done.text。 */
export function deltaMismatches(events: readonly RunEvent[]): string[] {
  const buffers = new Map<string, string>();
  const mismatches: string[] = [];
  for (const event of events) {
    if (event.type === "model.start") {
      buffers.set(event.participantId, "");
    } else if (event.type === "model.delta" && event.channel === "text") {
      buffers.set(event.participantId, (buffers.get(event.participantId) ?? "") + event.text);
    } else if (event.type === "model.done") {
      const buffered = buffers.get(event.participantId) ?? "";
      if (buffered !== event.text) {
        mismatches.push(
          `participant ${event.participantId}: delta=${JSON.stringify(buffered)} done=${JSON.stringify(
            event.text,
          )}`,
        );
      }
    }
  }
  return mismatches;
}

/** final.delta 的累加 = final.text。 */
export function finalDeltaMismatch(events: readonly RunEvent[]): string | undefined {
  const deltas = events
    .filter((event): event is Extract<RunEvent, { type: "final.delta" }> => event.type === "final.delta")
    .map((event) => event.text)
    .join("");
  const final = events.find((event): event is Extract<RunEvent, { type: "final" }> => event.type === "final");
  if (!final) return deltas ? `final.delta 有内容但缺少 final 事件：${JSON.stringify(deltas)}` : undefined;
  if (deltas !== final.text) {
    return `final.delta=${JSON.stringify(deltas)} final=${JSON.stringify(final.text)}`;
  }
  return undefined;
}

export function findCall(calls: readonly FakeCall[], needle: string): FakeCall | undefined {
  return calls.find((call) => (call.system ?? "").includes(needle));
}

export function findCalls(calls: readonly FakeCall[], needle: string): FakeCall[] {
  return calls.filter((call) => (call.system ?? "").includes(needle));
}

/** 生成一段可预期长度的文本。 */
export function repeat(text: string, times: number): string {
  return Array.from({ length: times }, () => text).join("");
}
