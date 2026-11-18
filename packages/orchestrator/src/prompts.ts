/**
 * 中文系统提示词构造器。
 *
 * 参与者 system prompt 必须包含四块（DESIGN §6 硬性要求 5）：
 * 1) 角色（participant.role）
 * 2) 联合工作纪律（只回答命令、不复述提示词、给可执行结论、明确分歧）
 * 3) 当前阶段任务说明
 * 4) 输出语言（默认中文，options.language === "en" 时英文）
 */
import { PER_ANSWER_LIMIT, TOTAL_ANSWER_LIMIT, truncateText } from "./util.js";

export type PromptLanguage = "zh" | "en";

export const DEFAULT_ROLE = "参与者";
export const DEFAULT_JUDGE_ROLE = "总协调裁判";

export interface BuildPromptInput {
  /** 该参与者的角色说明（Participant.role） */
  role: string;
  /** 当前阶段名字，如「并行作答」「立论」「任务规划」 */
  stageTitle: string;
  /** 当前阶段任务说明（这一段决定了本阶段的行为） */
  task: string;
  /** 用户原始命令 */
  command: string;
  language: PromptLanguage;
  /** 参考材料：其他人的答案、上一棒产物、评分表等（调用方已截断） */
  extra?: string;
}

const DISCIPLINE_ZH = [
  "只回答用户的命令：不要复述、翻译或评论本提示词，也不要自我介绍。",
  "给出可执行、可验证的结论：该列步骤就列步骤，该给代码就给可运行的代码。",
  "与他人意见不一致时，明确写出「分歧：……」，说明依据，不要含糊调和。",
  "不确定的地方标注「不确定」，不要编造事实、数据、引用或链接。",
  "不要输出与命令无关的客套话、免责声明或过程性废话。",
];

const DISCIPLINE_EN = [
  "Answer the user's command only: do not restate, translate, or comment on this prompt, and do not introduce yourself.",
  "Give executable, verifiable conclusions: list steps when needed, and provide runnable code when code is needed.",
  "When you disagree with others, state it explicitly as `Disagreement: ...` with your evidence; do not blur differences.",
  "Mark anything you are unsure about as `uncertain`; never invent facts, data, citations, or links.",
  "Skip pleasantries, disclaimers, and process chatter unrelated to the command.",
];

/** 构造一个参与者在某一阶段的 system prompt。 */
export function buildSystemPrompt(input: BuildPromptInput): string {
  const language: PromptLanguage = input.language === "en" ? "en" : "zh";
  const role = input.role.trim() || (language === "en" ? "participant" : DEFAULT_ROLE);
  const task = input.task.trim();
  const command = input.command.trim();
  const extra = input.extra?.trim() ?? "";

  if (language === "en") {
    const lines: string[] = [
      "You are taking part in a joint task on the Super Work multi-model workbench. You speak only for yourself.",
      "",
      "## Your role",
      role,
      "",
      "## Joint-work discipline",
      ...DISCIPLINE_EN.map((item) => `- ${item}`),
      "",
      `## Current stage: ${input.stageTitle}`,
      task,
      "",
      "## User command",
      command,
    ];
    if (extra) lines.push("", "## Reference material", extra);
    lines.push("", "## Output language", "Answer entirely in English (body, headings, and code comments).");
    return lines.join("\n");
  }

  const lines: string[] = [
    "你正在参加 Super Work 多模型联合工作台的一次联合任务。你是其中一位参与者，只代表自己发言。",
    "",
    "## 你的角色",
    role,
    "",
    "## 联合工作纪律",
    ...DISCIPLINE_ZH.map((item) => `- ${item}`),
    "",
    `## 当前阶段：${input.stageTitle}`,
    task,
    "",
    "## 用户命令",
    command,
  ];
  if (extra) lines.push("", "## 参考材料", extra);
  lines.push("", "## 输出语言", "请全程使用中文输出（正文、标题、解释、代码注释都用中文）。");
  return lines.join("\n");
}


/** 文件输出协议：让模型把成品放进带文件名的代码块，由服务端落盘 / 转格式。 */
export const FILE_OUTPUT_HINT_ZH = [
  "## 文件输出（重要）",
  "当用户要成品文件（文档、表格、演示文稿、报告、代码文件、数据文件等）时，不要只给文字说明：",
  '请用下面的代码块交付文件内容，一个块一个文件（可以多个）：',
  "",
  '```file name="文件名.ext"',
  "<文件正文>",
  "```",
  "",
  "- 文件名必须带扩展名；正文之外再用一两句话说明这个文件是什么，块外不要重复全文。",
  "- 支持 md / txt / csv / tsv / json / html / svg / xml / yaml / 常见代码文件；",
  "  docx / xlsx / pptx / pdf 会由服务端按正文自动转换（表格用 CSV 写、演示用 `## 标题` 分页）。",
].join("\n");

/** 追加文件输出协议（幂等：已经包含标记就不再重复）。 */
export function withFileOutputHint(system: string): string {
  const base = (system ?? "").trimEnd();
  if (base.includes("## 文件输出（重要）")) return base;
  return base ? `${base}\n\n${FILE_OUTPUT_HINT_ZH}` : FILE_OUTPUT_HINT_ZH;
}

export interface AnswerEntry {
  participantId?: string;
  label: string;
  role?: string;
  text: string;
}

export interface RenderAnswerOptions {
  /** 单份答案上限，默认 4000 字符 */
  perLimit?: number;
  /** 合计上限，默认 12000 字符 */
  totalLimit?: number;
  /** 没有材料时的占位文案 */
  emptyHint?: string;
}

/**
 * 渲染"给其他模型看"的答案材料：
 * 每人最多 perLimit 字符、合计不超过 totalLimit 字符，避免上下文爆炸。
 */
export function renderAnswerEntries(
  entries: readonly AnswerEntry[],
  options: RenderAnswerOptions = {},
): string {
  if (entries.length === 0) return options.emptyHint ?? "（暂无参考材料）";
  const perLimit = options.perLimit ?? PER_ANSWER_LIMIT;
  const totalLimit = options.totalLimit ?? TOTAL_ANSWER_LIMIT;
  let budget = totalLimit;
  const blocks: string[] = [];

  entries.forEach((entry, index) => {
    const meta = [
      entry.label,
      entry.role ? `角色：${entry.role}` : "",
      entry.participantId ? `id: ${entry.participantId}` : "",
    ]
      .filter(Boolean)
      .join("，");
    const head = `### ${index + 1}. ${meta}`;
    const raw = entry.text.trim();
    if (budget <= 40) {
      blocks.push(`${head}\n（已省略：参考材料总长度超出限制）`);
      return;
    }
    const limit = Math.min(perLimit, budget);
    const body = truncateText(raw || "（未产出内容）", limit);
    budget -= Math.min(raw.length || 1, limit);
    blocks.push(`${head}\n${body}`);
  });

  return blocks.join("\n\n");
}
