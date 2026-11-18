/**
 * @super-work/orchestrator 包入口。
 *
 * 导出 orchestrate(args, deps, onEvent, signal) 与 core 的类型重导出。
 * 契约（DESIGN §4 / §6）已冻结，本包只依赖 @super-work/core，不反向修改。
 *
 * 支持的模式：council / debate / pipeline / vote / auto（v0.0.1）+
 *              parallel / coordinate（v0.0.2）。
 *
 * 事件顺序：
 *   run.start
 *   → context（每次 chat / 生图调用前，紧跟其后是 model.start）
 *   → stage / model.start / model.delta* / model.done|model.error（各阶段可多次）
 *   → artifact（配合模式的图片 / 代码产物，可多次）
 *   → final.delta* → final → run.done
 *   裁判产出最终答案的路径（council synthesis / debate judge / vote synthesis /
 *   auto synthesis / parallel synthesis / coordinate judge）
 *   会在裁判 model.delta 的同时同步发 final.delta；其余路径在收尾时一次性分块补发。
 * 全员失败时：model.error* → notice(error) → run.error，返回空结果（不抛异常）。
 */
import type {
  OrchestrateArgs,
  OrchestrateResult,
  OrchestratorDeps,
  RunEvent,
  RunMode,
} from "@super-work/core";
import { createRunContext, type RunContext } from "./runtime.js";
import { errorMessage, chunkText, hasUsage } from "./util.js";
import { run as runCouncil } from "./modes/council.js";
import { run as runDebate } from "./modes/debate.js";
import { run as runPipeline } from "./modes/pipeline.js";
import { run as runVote } from "./modes/vote.js";
import { run as runAuto } from "./modes/auto.js";
import { run as runParallel } from "./modes/parallel.js";
import { run as runCoordinate } from "./modes/coordinate.js";
import { run as runChat } from "./modes/chat.js";

export type {
  ChatChunk,
  ChatMessage,
  ModelInfo,
  OrchestrateArgs,
  OrchestrateResult,
  OrchestratorDeps,
  Participant,
  ParticipantResult,
  ParticipantSpec,
  ParticipantStageResult,
  RunEvent,
  RunMode,
  RunOptions,
  RunRequest,
  StageId,
  Usage,
} from "@super-work/core";

const MODE_RUNNERS: Record<RunMode, (ctx: RunContext) => Promise<string>> = {
  council: runCouncil,
  debate: runDebate,
  pipeline: runPipeline,
  vote: runVote,
  auto: runAuto,
  parallel: runParallel,
  coordinate: runCoordinate,
  chat: runChat,
};

/**
 * 收尾最终答案：
 * - 裁判已经实时发过 final.delta 时，只补发缺失的尾部（保证 final.delta 累计 == final.text）；
 * - 否则按 48 码点一块补齐。
 * 返回真正写进 final.text 的文本（被中断时可能是在已流出的部分后面追加兜底内容）。
 */
function emitFinal(ctx: RunContext, finalText: string): string {
  const streamed = ctx.streamedFinalText;
  let text = finalText;
  if (streamed) {
    // 裁判流到一半失败、模式回退到别的答案：把兜底内容接在已流出的部分后面，保证累计一致。
    if (!text.trim()) text = streamed;
    else if (!text.startsWith(streamed)) text = `${streamed}\n\n${text}`;
  }
  const remainder = streamed && text.startsWith(streamed) ? text.slice(streamed.length) : text;
  for (const chunk of chunkText(remainder)) {
    ctx.emit({ type: "final.delta", text: chunk, at: Date.now() });
  }
  const usage = { ...ctx.usage };
  ctx.emit({
    type: "final",
    text,
    usage: hasUsage(usage) ? usage : undefined,
    at: Date.now(),
  });
  return text;
}

/**
 * 跑一次多模型联合工作。
 * 不抛异常：任何失败都通过事件 + 空结果返回，由 server 决定如何落库/展示。
 */
export async function orchestrate(
  args: OrchestrateArgs,
  deps: OrchestratorDeps,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
): Promise<OrchestrateResult> {
  const ctx = createRunContext(args, deps, onEvent, signal);
  // 把「单独停止某个模型」的控制句柄交回 server；不传也无副作用。
  args.onControl?.({
    stopParticipant: (participantId) => ctx.stopParticipant(participantId),
    stoppedParticipants: () => ctx.stoppedParticipants(),
  });
  const mode = (args.request?.mode ?? "council") as RunMode;

  const partialResult = (): OrchestrateResult => ({
    finalText: "",
    results: ctx.listResults(),
    usage: { ...ctx.usage },
  });

  const announced = ctx.announcedParticipants();
  ctx.emit({
    type: "run.start",
    runId: args.runId,
    mode,
    participants: announced,
    at: Date.now(),
  });

  // 已取消：只发 run.start 就返回，不产生任何模型调用。
  if (ctx.aborted) return partialResult();

  // 配合模式：没有任何配置角色时不跑任何调用，直接给出明确错误。
  if (mode === "coordinate" && !ctx.hasCoordination) {
    const message = "没有配置任何角色";
    ctx.emit({ type: "notice", level: "error", message, at: Date.now() });
    ctx.emit({ type: "run.error", message, at: Date.now() });
    return partialResult();
  }

  // 配合模式：存在既非内置、也不在 options.customRoles 里的角色 → 0 调用直接报错。
  if (mode === "coordinate") {
    const unknown = ctx.unknownCoordinationRoles();
    if (unknown.length > 0) {
      const message = `存在未知角色：${unknown.join("、")}`;
      ctx.emit({ type: "notice", level: "error", message, at: Date.now() });
      ctx.emit({ type: "run.error", message, at: Date.now() });
      return partialResult();
    }
  }

  const hasCoordinateWork = mode === "coordinate" && ctx.hasCoordination;
  if (!ctx.hasParticipants && !hasCoordinateWork) {
    const message = "没有可用的参与模型";
    ctx.emit({ type: "notice", level: "error", message, at: Date.now() });
    ctx.emit({ type: "run.error", message, at: Date.now() });
    return partialResult();
  }

  let finalText = "";
  let unexpectedError: string | undefined;

  try {
    const runner = MODE_RUNNERS[mode] ?? runCouncil;
    finalText = await runner(ctx);
  } catch (error) {
    // 取消导致的异常不算失败，安静返回。
    if (ctx.aborted) return partialResult();
    unexpectedError = errorMessage(error);
  }

  if (ctx.aborted) return partialResult();

  if (unexpectedError) {
    ctx.emit({
      type: "notice",
      level: "error",
      message: `联合工作异常：${unexpectedError}`,
      at: Date.now(),
    });
    ctx.emit({ type: "run.error", message: unexpectedError, at: Date.now() });
    return partialResult();
  }

  // 裁判已经在 synthesis 阶段流出了部分内容时，也算产出了结果（收尾会补齐一致性）。
  if (!finalText.trim() && !ctx.streamedFinalText.trim()) {
    const message = "所有模型均未产出可用结果";
    ctx.emit({ type: "notice", level: "error", message, at: Date.now() });
    ctx.emit({ type: "run.error", message, at: Date.now() });
    return partialResult();
  }

  finalText = emitFinal(ctx, finalText);

  const usage = { ...ctx.usage };
  ctx.emit({
    type: "run.done",
    runId: args.runId,
    at: Date.now(),
    usage: hasUsage(usage) ? usage : undefined,
  });

  return { finalText, results: ctx.listResults(), usage };
}

export default orchestrate;
