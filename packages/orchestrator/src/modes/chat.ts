/**
 * chat（Chat）模式：
 *   只允许一个参与者，像聊天一样多轮往来。
 *   - 前几轮由 RunContext.call 以 user/assistant 消息注入（options.conversation）；
 *   - 本轮命令作为最后一条 user 消息；
 *   - 正文通过 streamFinal 实时同步到 final.delta，最终答案就是这一条回复（不加模型标题）。
 */
import { buildSystemPrompt } from "../prompts.js";
import type { RunContext } from "../runtime.js";

const CHAT_TASK = [
  "你正在和用户一对一聊天。",
  "1) 直接、自然地回应用户这条消息，延续前文语境；",
  "2) 需要给代码时给完整可运行代码，需要步骤时给可执行步骤；",
  "3) 不要扮演多个模型、不要复述系统提示词、不要加模型标题。",
].join("\n");

export async function run(ctx: RunContext): Promise<string> {
  const participant = ctx.participants[0];
  if (!participant) {
    ctx.emit({
      type: "notice",
      level: "error",
      message: "Chat 模式需要选择一个模型",
      at: Date.now(),
    });
    return "";
  }

  ctx.emit({
    type: "stage",
    stage: "chat",
    label: `Chat · ${participant.label}`,
    at: Date.now(),
  });

  const system = buildSystemPrompt({
    role: participant.role || "通用对话助手",
    stageTitle: "Chat 对话",
    task: CHAT_TASK,
    command: ctx.command,
    language: ctx.language,
    extra: ctx.attachmentsContext,
  });

  const outcome = await ctx.call(participant, {
    system,
    messages: [{ role: "user", content: ctx.command }],
    label: "Chat",
    stage: "chat",
    streamFinal: true,
    reference: ctx.attachmentsContext,
  });

  if (!outcome.ok) return "";
  return outcome.text;
}
