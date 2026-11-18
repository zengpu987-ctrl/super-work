/**
 * coordinate（配合）模式：严格按 request.coordination 的角色执行，未出现的角色 0 次调用。
 *
 * 角色不再限定 8 个内置：`coordination[].role` 可以是内置 id，也可以是 options.customRoles 里的
 * `custom_*`（用 core resolveCoordRole 解析）。未知角色由 index.ts 在任何调用前 run.error。
 *
 *   stage:command     发令官并行产出「任务分解 + 验收标准 + 给执行角色的明确指令」，
 *                     多个发令官拼接成一份执行简报；无发令官 → notice(info) + 原始命令
 *   stage:specialist  除 commander/integrator/judge 以外的角色（内置 reasoning/coding/model3d/
 *                     image/chat + 自定义 text/image）按 order 排序后并行执行；
 *                     image 角色不调 chat，直接 deps.generateImage 出图并 emit artifact(kind=image)；
 *                     coding / model3d 成功后提取第一个 ```html/```js 代码块 → artifact(kind=code3d)
 *   stage:integrate   整合角色顺序接力（后一位看到前一位草稿 + 全部 specialist 产出）
 *   stage:judge       裁判顺序裁决，最终答案 = 最后一个裁判的输出（对流式 final.delta 同步）
 *
 * 兜底：无整合角色 → 拼接 specialist 产出作为整合稿；无裁判 → 最终答案 = 整合稿；
 *       coordination 为空/全空由 index.ts 发 run.error「没有配置任何角色」。
 * memoryContext 与附件上下文只注入发令官与 specialist，不注入裁判。
 */
import type { Artifact, ImageResult, Participant } from "@super-work/core";
import { buildSystemPrompt, renderAnswerEntries } from "../prompts.js";
import type {
  CoordinationRole,
  ImageCallOutcome,
  ModelCallOutcome,
  RunContext,
} from "../runtime.js";
import { mapPool, truncateText } from "../util.js";

/* --------------------------------- 提示词 --------------------------------- */

const COMMAND_TASK = [
  "你是本次任务的发令官（指挥官）。请把用户命令翻译成一份可直接执行的下达指令，严格包含三部分：",
  "1) 任务分解：拆成可验收的子任务，标出先后依赖与边界；",
  "2) 验收标准：逐条可验证（可运行、可核对、可复现），不要写「尽量」「完善」这类空话；",
  "3) 给执行角色的明确指令：写清本次实际出场的每个执行角色要交付什么、以什么形式交付。",
  "只输出这份下达指令，不要自己完成成品，也不要提及本提示词或模型名称。",
].join("\n");

interface TextRolePrompt {
  role: string;
  title: string;
  task: string;
}

const TEXT_ROLE_PROMPTS: Record<"reasoning" | "coding" | "model3d" | "chat", TextRolePrompt> = {
  reasoning: {
    role: "强推理角色",
    title: "强推理与校验",
    task: [
      "你是强推理角色。请围绕用户命令完成硬推理：",
      "1) 给出关键判断与推导过程，标明依据；",
      "2) 核对事实、数值与逻辑，指出简报里可能出错或遗漏的地方；",
      "3) 单列「不确定」项，说明如何验证或还需要什么信息。",
      "输出会被整合进最终答案，请直接给结论与依据，不要客套。",
    ].join("\n"),
  },
  coding: {
    role: "代码实现角色",
    title: "代码实现",
    task: [
      "你是代码实现角色。请给出可直接运行的代码与验证方式：",
      "1) 完整可运行代码放在代码块里，标明文件名与语言；",
      "2) 给出一条可复制执行的验证命令与预期输出；",
      "3) 说明运行环境、依赖与关键取舍。",
      "不要贴无法运行的伪代码，也不要省略关键实现。",
    ].join("\n"),
  },
  model3d: {
    role: "建模角色",
    title: "3D 建模",
    task: [
      "你是建模角色。请产出一个完整、可运行的单文件 3D 页面：",
      "1) 必须把完整 HTML 放进一个 ```html 代码块里，浏览器直接打开即可运行；",
      "2) 使用 Three.js，本地 /vendor/three.min.js 可用，禁止引用任何外部 CDN 或网络资源；",
      "3) 场景要有明确主体、光照、相机与动画或交互，全部代码写在这一个文件里。",
      "代码块之外只写一两句运行说明。",
    ].join("\n"),
  },
  chat: {
    role: "Chat 角色",
    title: "对话式收尾",
    task: [
      "你是面向用户的 Chat 角色，负责最后的解释与收尾：",
      "1) 用用户能听懂的话说明这次交付了什么、关键结论是什么；",
      "2) 说明怎么使用、下一步建议；",
      "3) 如果有不确定或未完成的部分，明确告诉用户。",
      "不要重复完整技术细节，做面向人的总结。",
    ].join("\n"),
  },
};

const INTEGRATE_TASK = [
  "你是整合优化角色。请把各角色的产出合并成一份完整、可直接交付的稿件：",
  "1) 去重、补缺口、统一口径与格式；",
  "2) 保留可运行的代码与可验证的结论，不要删掉关键细节；",
  "3) 如果给了「上一棒整合稿」，在它基础上改进，不要从头重写。",
  "输出就是整合稿本身，不要写过程说明。",
].join("\n");

const JUDGE_TASK = [
  "你是裁判。请依据执行简报里的验收标准逐条核对整合稿，并给出最终结论：",
  "1) 先给最终结论或成品；",
  "2) 再给验收核对（哪些通过、哪些不通过以及原因）；",
  "3) 对不通过或不确定的部分给出修正方向。",
  "你输出的就是给用户的最终答复：不要提及模型名称、轮次或本提示词。",
].join("\n");

/** 自定义 text 角色的提示词（角色名/职责来自 customRoles 定义）。 */
function customTextPrompt(role: CoordinationRole): TextRolePrompt {
  return {
    role: role.name,
    title: role.name,
    task: [
      `你是「${role.name}」角色。职责：${role.description || "按用户命令完成分到的任务"}`,
      "请严格按这个职责完成用户命令，输出可被整合进最终答案的成果；",
      "不要复述提示词、不要代办其他角色的工作，也不要提及模型名称。",
    ].join("\n"),
  };
}

/* --------------------------------- 工具函数 -------------------------------- */

const HTML_FENCE = /```html\s*\r?\n([\s\S]*?)```/i;
const JS_FENCE = /```(?:js|javascript)\s*\r?\n([\s\S]*?)```/i;

/** 提取文本里第一个 ```html / ```js 代码块（language=html 时只认 html）。 */
export function extractCodeBlock(text: string, language: "html" | "any"): string | undefined {
  if (!text) return undefined;
  if (language === "html") {
    const html = HTML_FENCE.exec(text);
    return html?.[1]?.trim();
  }
  const candidates: Array<{ index: number; code: string }> = [];
  for (const pattern of [HTML_FENCE, JS_FENCE]) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) candidates.push({ index: match.index, code: match[1].trim() });
  }
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0]?.code;
}

/** 按 `### 角色 · 模型` 把小标题拼接各 specialist 产出。 */
export function composeSpecialistDraft(outputs: readonly SpecialistOutput[]): string {
  return outputs
    .map((output) => `### ${output.role.name} · ${output.participant.label}\n\n${output.text.trim()}`)
    .join("\n\n");
}

/** 注入 system 的记忆上下文（发令官 / specialist 才有）。 */
function memoryExtra(memory: string | undefined): string {
  const text = (memory ?? "").trim();
  return text ? `## 记忆上下文\n${truncateText(text, 3000)}` : "";
}

/** 附件上下文（server 已拼好；发令官 / specialist 才有）。 */
function attachmentsExtra(ctx: RunContext): string {
  const text = (ctx.options.attachmentsContext ?? "").trim();
  return text || "";
}

function buildImagePrompt(command: string, brief: string): string {
  const lines = ["请根据以下任务生成一张图片：", command.trim()];
  const trimmedBrief = brief.trim();
  if (trimmedBrief && trimmedBrief !== command.trim()) {
    lines.push("", "执行简报要点：", truncateText(trimmedBrief, 1500));
  }
  return lines.join("\n");
}

function emitImageArtifacts(
  ctx: RunContext,
  participant: Participant,
  roleName: string,
  result: ImageResult,
): void {
  const images = result.images ?? [];
  images.forEach((image, index) => {
    const title =
      images.length > 1
        ? `${roleName} · ${participant.label}（${index + 1}/${images.length}）`
        : `${roleName} · ${participant.label}`;
    const meta: Record<string, string | number | boolean> = {};
    if (image.url) meta.url = image.url;
    if (typeof result.credit === "number") meta.credit = result.credit;
    if (image.mime) meta.mime = image.mime;
    const artifact: Artifact = {
      id: `image-${participant.id}-${index + 1}`,
      kind: "image",
      title,
      createdAt: Date.now(),
    };
    if (Object.keys(meta).length > 0) artifact.meta = meta;
    if (image.b64) artifact.dataUrl = `data:${image.mime || "image/png"};base64,${image.b64}`;
    ctx.emit({ type: "artifact", participantId: participant.id, artifact, at: Date.now() });
  });
}

function emitCodeArtifact(
  ctx: RunContext,
  participant: Participant,
  role: CoordinationRole,
  code: string,
): void {
  const artifact: Artifact = {
    id: `code3d-${role.id}-${participant.id}`,
    kind: "code3d",
    title: `${role.name} · ${participant.label}`,
    text: code,
    mime: role.id === "model3d" ? "text/html" : "text/javascript",
    createdAt: Date.now(),
  };
  ctx.emit({ type: "artifact", participantId: participant.id, artifact, at: Date.now() });
}

/** 代码产物：内置 coding / model3d 每人最多 1 个；model3d 找不到 html 时给 warn。 */
function maybeEmitCodeArtifact(
  ctx: RunContext,
  participant: Participant,
  role: CoordinationRole,
  text: string,
  emitted: Set<string>,
): void {
  if (role.id !== "coding" && role.id !== "model3d") return;
  const key = `${role.id}:${participant.id}`;
  if (emitted.has(key)) return;
  if (role.id === "model3d") {
    const code = extractCodeBlock(text, "html");
    if (!code) {
      ctx.emit({
        type: "notice",
        level: "warn",
        message: `${role.name}角色 ${participant.label} 的输出里没有找到 \`\`\`html 代码块，无法生成 3D 预览。`,
        at: Date.now(),
      });
      return;
    }
    emitted.add(key);
    emitCodeArtifact(ctx, participant, role, code);
    return;
  }
  const code = extractCodeBlock(text, "any");
  if (!code) return;
  emitted.add(key);
  emitCodeArtifact(ctx, participant, role, code);
}

/* --------------------------------- 数据类型 -------------------------------- */

export interface SpecialistOutput {
  role: CoordinationRole;
  participant: Participant;
  text: string;
}

interface BriefOutput {
  roleName: string;
  participant: Participant;
  text: string;
}

type SpecialistRun =
  | {
      role: CoordinationRole;
      participant: Participant;
      kind: "text";
      outcome: ModelCallOutcome;
    }
  | {
      role: CoordinationRole;
      participant: Participant;
      kind: "image";
      outcome: ImageCallOutcome;
    };

function composeBrief(outputs: readonly BriefOutput[]): string {
  return outputs
    .map((output, index) => `## ${output.roleName} ${index + 1} · ${output.participant.label}\n${output.text.trim()}`)
    .join("\n\n");
}

function specialistMaterial(outputs: readonly SpecialistOutput[], perLimit: number): string {
  return renderAnswerEntries(
    outputs.map((output) => ({
      participantId: output.participant.id,
      label: `${output.role.name} · ${output.participant.label}`,
      role: output.role.name,
      text: output.text,
    })),
    { perLimit, totalLimit: 12000 },
  );
}

function uniqueNames(roles: readonly CoordinationRole[]): string[] {
  const names: string[] = [];
  for (const role of roles) if (!names.includes(role.name)) names.push(role.name);
  return names;
}

/* ---------------------------------- 主流程 --------------------------------- */

export async function run(ctx: RunContext): Promise<string> {
  const roles = ctx.coordinationRoles();
  const commanders = roles.filter((role) => role.id === "commander");
  const integrators = roles.filter((role) => role.id === "integrator");
  const judges = roles.filter((role) => role.id === "judge");
  const specialistRoles = roles
    .filter((role) => role.id !== "commander" && role.id !== "integrator" && role.id !== "judge")
    .sort((a, b) => a.order - b.order);
  const specialists: Array<{ role: CoordinationRole; participant: Participant }> = [];
  for (const role of specialistRoles) {
    for (const participant of role.participants) specialists.push({ role, participant });
  }

  const memory = ctx.options.memoryContext;
  const memoryBlock = memoryExtra(memory);
  const attachments = attachmentsExtra(ctx);

  // ---------- stage: command ----------
  let brief = ctx.command;
  let briefIsCommand = true;
  const commandersFlat: Array<{ role: CoordinationRole; participant: Participant }> = [];
  for (const role of commanders) {
    for (const participant of role.participants) commandersFlat.push({ role, participant });
  }
  if (commandersFlat.length > 0) {
    ctx.emit({
      type: "stage",
      stage: "command",
      label: `${uniqueNames(commanders).join(" / ")}下达指令 · ${commandersFlat.length} 位`,
      at: Date.now(),
    });

    const commandExtras = [memoryBlock, attachments].filter(Boolean).join("\n\n");
    const results = await mapPool(commandersFlat, ctx.concurrency, async ({ role, participant }) => {
      const system = buildSystemPrompt({
        role: participant.role || role.name,
        stageTitle: "任务分解与验收标准",
        task: COMMAND_TASK,
        command: ctx.command,
        language: ctx.language,
        extra: commandExtras,
      });
      const outcome = await ctx.call(participant, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: "任务分解",
        stage: "command",
        memory,
        reference: attachments,
      });
      return { roleName: role.name, participant, outcome } satisfies {
        roleName: string;
        participant: Participant;
        outcome: ModelCallOutcome;
      };
    });

    const briefs: BriefOutput[] = [];
    for (const settled of results) {
      if (settled.status === "rejected") continue;
      if (settled.value.outcome.ok && settled.value.outcome.text.trim()) {
        briefs.push({
          roleName: settled.value.roleName,
          participant: settled.value.participant,
          text: settled.value.outcome.text,
        });
      }
    }

    if (ctx.aborted) return "";
    if (briefs.length > 0) {
      brief = composeBrief(briefs);
      briefIsCommand = false;
    } else {
      ctx.emit({
        type: "notice",
        level: "warn",
        message: "发令官未能产出执行简报，已直接使用原始命令驱动执行角色。",
        at: Date.now(),
      });
    }
  } else {
    ctx.emit({
      type: "notice",
      level: "info",
      message: "未配置发令官角色，直接使用原始命令驱动执行角色。",
      at: Date.now(),
    });
  }

  // ---------- stage: specialist ----------
  const specialistOutputs: SpecialistOutput[] = [];
  const emittedCodeArtifacts = new Set<string>();
  if (specialists.length > 0) {
    ctx.emit({
      type: "stage",
      stage: "specialist",
      label: `角色执行 · ${uniqueNames(specialistRoles).join(" / ")}`,
      at: Date.now(),
    });

    const extras: string[] = [];
    if (!briefIsCommand && brief.trim()) extras.push(`## 执行简报\n${truncateText(brief, 4000)}`);
    if (memoryBlock) extras.push(memoryBlock);
    if (attachments) extras.push(attachments);
    const extra = extras.join("\n\n");

    const results = await mapPool(specialists, ctx.concurrency, async (item) => {
      const { role, participant } = item;
      if (role.kind === "image") {
        const outcome = await ctx.image(participant, {
          prompt: buildImagePrompt(ctx.command, brief),
          size: ctx.options.imageSize,
          label: role.name,
          stage: "specialist",
          memory,
        });
        if (outcome.ok && outcome.result) {
          emitImageArtifacts(ctx, participant, role.name, outcome.result);
        }
        return { role, participant, kind: "image", outcome } satisfies SpecialistRun;
      }
      const prompt = TEXT_ROLE_PROMPTS[role.id as keyof typeof TEXT_ROLE_PROMPTS] ?? customTextPrompt(role);
      const system = buildSystemPrompt({
        role: prompt.role,
        stageTitle: prompt.title,
        task: prompt.task,
        command: ctx.command,
        language: ctx.language,
        extra,
      });
      const outcome = await ctx.call(participant, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: prompt.title,
        stage: "specialist",
        memory,
        reference: attachments,
      });
      if (outcome.ok && outcome.text.trim()) {
        maybeEmitCodeArtifact(ctx, participant, role, outcome.text, emittedCodeArtifacts);
      }
      return { role, participant, kind: "text", outcome } satisfies SpecialistRun;
    });

    for (const settled of results) {
      if (settled.status === "rejected") continue;
      const item = settled.value;
      if (item.outcome.ok && item.outcome.text.trim()) {
        specialistOutputs.push({ role: item.role, participant: item.participant, text: item.outcome.text });
      }
    }
  }

  if (ctx.aborted) return "";

  // ---------- stage: integrate ----------
  let draft = composeSpecialistDraft(specialistOutputs);
  // 预算在中途触发、执行角色一个都没产出时，至少把发令官简报作为已有内容收尾。
  if (ctx.budgetExceeded && specialistOutputs.length === 0 && !briefIsCommand) {
    draft = brief;
    ctx.emit({
      type: "notice",
      level: "info",
      message: "预算已超限，执行角色未产出内容，已使用发令官简报作为最终答案。",
      at: Date.now(),
    });
  }
  const integratorsFlat: Participant[] = [];
  for (const role of integrators) integratorsFlat.push(...role.participants);
  if (integratorsFlat.length > 0) {
    ctx.emit({
      type: "stage",
      stage: "integrate",
      label: `${uniqueNames(integrators).join(" / ")} · ${integratorsFlat.length} 位`,
      at: Date.now(),
    });

    const material = specialistMaterial(specialistOutputs, ctx.answerLimit());
    let current = "";
    for (let index = 0; index < integratorsFlat.length; index += 1) {
      const integrator = integratorsFlat[index] as Participant;
      const extras: string[] = [];
      if (!briefIsCommand && brief.trim()) extras.push(`## 执行简报\n${truncateText(brief, 3000)}`);
      if (material) extras.push(`## 各角色产出\n${material}`);
      if (current.trim()) extras.push(`## 上一棒整合稿（已截断）\n${truncateText(current, 6000)}`);
      const system = buildSystemPrompt({
        role: integrator.role || uniqueNames(integrators).join(" / "),
        stageTitle: "整合优化",
        task: INTEGRATE_TASK,
        command: ctx.command,
        language: ctx.language,
        extra: extras.join("\n\n"),
      });
      const outcome = await ctx.call(integrator, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: `整合第 ${index + 1} 棒`,
        stage: "integrate",
      });
      if (ctx.aborted) return current || draft;
      if (outcome.ok && outcome.text.trim()) current = outcome.text;
    }

    if (current.trim()) {
      draft = current;
    } else {
      ctx.emit({
        type: "notice",
        level: "warn",
        message: "整合优化未能产出整合稿，已使用各角色产出拼接稿。",
        at: Date.now(),
      });
    }
  } else {
    ctx.emit({
      type: "notice",
      level: "info",
      message: "未配置整合优化角色，已将各角色产出直接拼接为整合稿。",
      at: Date.now(),
    });
  }

  if (ctx.aborted) return draft;

  // ---------- stage: judge ----------
  const judgesFlat: Participant[] = [];
  for (const role of judges) judgesFlat.push(...role.participants);
  if (judgesFlat.length > 0) {
    ctx.emit({
      type: "stage",
      stage: "judge",
      label: `${uniqueNames(judges).join(" / ")}裁决 · ${judgesFlat.length} 位`,
      at: Date.now(),
    });

    const material = specialistMaterial(specialistOutputs, ctx.answerLimit());
    let verdict = "";
    for (let index = 0; index < judgesFlat.length; index += 1) {
      const judge = judgesFlat[index] as Participant;
      const last = index === judgesFlat.length - 1;
      const extras = [`## 执行简报（含验收标准）\n${truncateText(brief, 3000)}`];
      if (material) extras.push(`## 各角色产出\n${material}`);
      if (draft.trim()) extras.push(`## 整合稿（已截断）\n${truncateText(draft, 8000)}`);
      if (verdict.trim()) extras.push(`## 前一位裁判的结论（已截断）\n${truncateText(verdict, 4000)}`);
      const system = buildSystemPrompt({
        role: judge.role || uniqueNames(judges).join(" / "),
        stageTitle: "裁判裁决",
        task: JUDGE_TASK,
        command: ctx.command,
        language: ctx.language,
        extra: extras.join("\n\n"),
      });
      const outcome = await ctx.call(judge, {
        system,
        messages: [{ role: "user", content: ctx.command }],
        label: last ? "最终裁决" : `裁判第 ${index + 1} 位`,
        stage: "judge",
        streamFinal: last,
      });
      if (ctx.aborted) return verdict || draft;
      if (outcome.ok && outcome.text.trim()) verdict = outcome.text;
    }

    if (verdict.trim()) return verdict;

    ctx.emit({
      type: "notice",
      level: "warn",
      message: "裁判未能产出裁决，已回退到整合稿。",
      at: Date.now(),
    });
    return draft;
  }

  ctx.emit({
    type: "notice",
    level: "info",
    message: "未配置裁判角色，最终答案使用整合稿。",
    at: Date.now(),
  });
  return draft;
}
