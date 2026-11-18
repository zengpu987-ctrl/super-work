/**
 * 演示适配器：不联网、不需要 key，保证第一次打开就能看到"联合工作"效果。
 *
 * 质量要求（v0.0.1 门面）：
 * - 先给一句结论，再分 3 点论证，最后一句建议；
 * - 引用用户命令原文片段，体现"确实在读你的命令"；
 * - 不同 provider / model / role 用不同视角措辞（风险清单 / 实现步骤 / 资料口径 / 画面……）；
 * - mock-thinker 先吐 20~40 字结构化 reasoning（分点 + 用例），再吐正文；
 * - 每个模型 24~40 个 delta，每块 8~20ms，尊重 AbortSignal；
 * - usage 用 token 近似值。
 */
import type {
  ChatCallOptions,
  ChatChunk,
  Credential,
  EffortLevel,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from "@super-work/core";
import { modelsForProvider } from "@super-work/core";
import {
  DEFAULT_TIMEOUT_MS,
  createCallContext,
  estimateTokens,
  normalizeProviderError,
  randomInt,
  sleep,
  throwIfAborted,
} from "./util.js";

type ViewpointKey =
  | "analysis"
  | "code"
  | "verify"
  | "synthesis"
  | "research"
  | "visual"
  | "general";

interface Viewpoint {
  label: string;
  conclusion: string;
  points: [string, string, string];
  advice: string;
}

/** 视角模板：`{cmd}` 会被替换成用户命令片段。 */
const VIEWPOINTS: Record<ViewpointKey, Viewpoint> = {
  analysis: {
    label: "深度分析",
    conclusion: "「{cmd}」可以做，但失败成本主要来自边界不清，而不是难度。",
    points: [
      "风险清单：输入不可控会让下游连锁失败，校验必须先于执行。",
      "风险清单：跨模块改动通常要两轮回归，时间成本容易被低估。",
      "风险清单：回滚路径没写清楚，出问题时只能整体回退。",
    ],
    advice: "先划一条最小边界做灰度，把风险最高的一条路径单独压测后再放开。",
  },
  code: {
    label: "长文与代码",
    conclusion: "「{cmd}」可以拆成三个能独立提交的实现步骤，风险可控。",
    points: [
      "实现步骤：先定接口与类型，把契约冻结，适配层再往里填。",
      "实现步骤：测试先行覆盖流式与报错分支，最后再接 UI。",
      "实现步骤：留一个可回滚开关，按 provider 维度灰度。",
    ],
    advice: "先合入类型与测试，再分两次提交实现，保留按 provider 灰度的开关。",
  },
  verify: {
    label: "推理校验",
    conclusion: "「{cmd}」的推理链能走通，但中间有一个前提还没被验证。",
    points: [
      "校验点：把结论依赖的假设逐条列出来，能验证的先验证。",
      "校验点：主动找反例；找不出来，说明结论可能只是同义反复。",
      "校验点：前后术语与数值必须对齐，否则结论不可复现。",
    ],
    advice: "先补上那条未验证前提再进入执行；拿不出反例就说明结论站不住。",
  },
  synthesis: {
    label: "总协调 / 综合",
    conclusion: "各方意见已经收敛，「{cmd}」按“先小步验证、再统一实现”推进最稳。",
    points: [
      "综合判断：风险类意见成立，但可以用灰度范围控制。",
      "综合判断：实现类意见给出了可执行路径，可以直接排期。",
      "综合判断：资料类意见提醒我们补齐来源，避免结论悬空。",
    ],
    advice: "今天先落最小闭环，明天再扩范围；综合结果交给裁判模型再校一遍。",
  },
  research: {
    label: "资料整合",
    conclusion: "「{cmd}」现有信息够做判断，但缺一份能核对的来源清单。",
    points: [
      "资料面：先区分事实、推断与猜测，三者混着写最容易出错。",
      "资料面：关键数字要能追溯到原始出处，二手转述只作参考。",
      "资料面：把相互矛盾的两份材料并列，比急着选边更有价值。",
    ],
    advice: "先补一页来源与口径说明，把事实、推断、猜测分栏标注。",
  },
  visual: {
    label: "多模态视角",
    conclusion: "从画面与呈现看，「{cmd}」的关键是让人第一眼抓住重点。",
    points: [
      "画面面：信息密度降下来，一屏只讲一件事。",
      "画面面：用对比色与层次区分结论和论据，不要堆满文字。",
      "画面面：动效只负责引导注意力，不为炫技。",
    ],
    advice: "先出黑白线框确认信息层级，再上色和动效。",
  },
  general: {
    label: "通用助手",
    conclusion: "「{cmd}」值得做，关键是把范围切小、把验收写清楚。",
    points: [
      "要点：先明确要解决的问题，以及这一版刻意不解决的问题。",
      "要点：用最小实现验证核心假设，再决定是否投入更多。",
      "要点：把可观测指标写进验收，避免“感觉完成了”。",
    ],
    advice: "今天就定下第一个可交付的小目标，明天只扩范围、不改方向。",
  },
};

/** 没有显式角色时，按 provider 选默认视角（让不同模型说不同话）。 */
const PROVIDER_VIEWPOINT: Record<ProviderId, ViewpointKey> = {
  deepseek: "verify",
  kimi: "code",
  openai: "synthesis",
  anthropic: "analysis",
  zhipu: "code",
  qwen: "research",
  volcengine: "general",
  minimax: "analysis",
  gemini: "visual",
  xai: "analysis",
  thirdparty: "general",
  workbuddy: "code",
  relay: "general",
  mock: "general",
};

/** provider 的口头禅，用来进一步区分措辞。 */
const PROVIDER_FLAVOR: Record<ProviderId, string> = {
  deepseek: "先把每一步前提到台面上：",
  kimi: "按工程落地顺序说：",
  openai: "综合各方之后：",
  anthropic: "从风险与边界看：",
  zhipu: "按稳健实现看：",
  qwen: "先把资料口径对齐：",
  volcengine: "按可落地程度看：",
  minimax: "直接给结论：",
  gemini: "从呈现与画面看：",
  xai: "不绕弯子：",
  thirdparty: "作为自建端点：",
  workbuddy: "按平台可用能力说：",
  relay: "作为中转站上游：",
  mock: "",
};

function truncate(text: string, limit: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= limit) return chars.join("");
  return `${chars.slice(0, limit).join("")}…`;
}

function sanitize(text: string): string {
  return text
    .replace(/id:\s*p\d+/gi, "")
    .replace(/###\s*\d+\.\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCommand(opts: ChatCallOptions): string {
  const sys = opts.system ?? "";
  const labeled = /##\s*用户命令\s*\n([\s\S]*?)(?:\n##\s|$)/.exec(sys);
  if (labeled?.[1]?.trim()) return sanitize(labeled[1]);
  const userMessages = opts.messages.filter((m) => m.role === "user" && m.content.trim());
  const first = userMessages[0] ?? opts.messages[0];
  return sanitize(first?.content ?? "");
}

/** 当前阶段：优先读 system 里的「## 当前阶段」，读不到再按关键词猜。 */
type MockStage = "first" | "critique" | "rebuttal" | "synthesis";

function extractStage(opts: ChatCallOptions): MockStage {
  const sys = opts.system ?? "";
  const stageLine = /##\s*当前阶段[：:]\s*([^\n]+)/.exec(sys)?.[1] ?? "";
  const probe = `${stageLine}\n${sys.slice(0, 400)}`;
  if (/综合|裁决|裁判|汇总|定稿|融合/.test(probe)) return "synthesis";
  if (/反驳|rebuttal/i.test(probe)) return "rebuttal";
  if (/互评|批判|补充|纠错|评审/.test(probe)) return "critique";
  return "first";
}

function extractRole(opts: ChatCallOptions): string | undefined {
  const extra = opts.extras?.role;
  if (typeof extra === "string" && extra.trim()) return extra.trim();
  const sources = [opts.system ?? "", ...opts.messages.filter((m) => m.role === "system").map((m) => m.content)];
  for (const text of sources) {
    if (!text) continue;
    const block = /##\s*你的角色\s*\n([^\n]+)/.exec(text);
    if (block?.[1]?.trim()) return block[1].trim();
    const labeled = /角色\s*[:：]\s*([^\n。；;]+)/.exec(text);
    if (labeled?.[1]?.trim()) return labeled[1].trim();
    const identity = /你是(?:一名|一个|一位)?\s*([^\n，,。；;]{2,30})/.exec(text);
    if (identity?.[1]?.trim()) return identity[1].trim();
  }
  return undefined;
}

function viewpointFor(role: string | undefined, provider: ProviderId): ViewpointKey {
  const text = role ?? "";
  if (/深度|分析|审视|批判|风险/.test(text)) return "analysis";
  if (/长文|代码|工程|实现|开发/.test(text)) return "code";
  if (/协调|综合|总编|定稿|汇总/.test(text)) return "synthesis";
  if (/推理|校验|验证|审查|核对/.test(text)) return "verify";
  if (/资料|整合|检索|调研/.test(text)) return "research";
  if (/多模态|视觉|画面|图像|呈现/.test(text)) return "visual";
  if (text.trim()) return "general";
  return PROVIDER_VIEWPOINT[provider] ?? "general";
}

/** 把一段文字按目标块数切开（按字符，中文流式观感更自然）。 */
export function splitIntoBlocks(text: string, targetBlocks: number): string[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];
  const blocks = Math.max(1, Math.min(targetBlocks, chars.length));
  const size = Math.ceil(chars.length / blocks);
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    out.push(chars.slice(index, index + size).join(""));
  }
  return out;
}

/** 5 档 effort 在演示模型里的可见差异（越小越省）。 */
interface MockEffortProfile {
  /** reasoning 行数：low 无 reasoning，之后逐级变长 */
  reasoningLines: number;
  /** 正文流式块数（越低越少、越短） */
  textBlocks: number;
  /** 正文保留的行数（结论 / 部分要点 / 全部要点 / 全部+深挖） */
  textLines: number;
}

const MOCK_EFFORT_PROFILE: Record<EffortLevel, MockEffortProfile> = {
  low: { reasoningLines: 0, textBlocks: 3, textLines: 2 },
  medium: { reasoningLines: 2, textBlocks: 6, textLines: 3 },
  fast: { reasoningLines: 3, textBlocks: 10, textLines: 4 },
  max: { reasoningLines: 5, textBlocks: 15, textLines: 5 },
  ultra: { reasoningLines: 7, textBlocks: 21, textLines: 7 },
};

/** 按档位截取正文行：保留结论 + 前 N 个要点 + 最后一句建议；ultra 追加深挖。 */
function effortTextLines(baseLines: string[], count: number, cmd: string): string[] {
  if (count >= baseLines.length + 2) {
    return [
      ...baseLines,
      `深挖 1：把「${cmd}」的边界条件逐条列出，给出失败时的回滚路径与观测指标。`,
      "深挖 2：主动找一条能推翻当前结论的反例，并写清验证结果；找不到就说明结论还只是同义反复。",
    ];
  }
  if (count >= baseLines.length) return [...baseLines];
  const head = baseLines.slice(0, Math.max(0, count - 1));
  return [...head, baseLines[baseLines.length - 1]];
}

/** 按档位生成 reasoning 行（low 为空，medium 2 行 … ultra 7 行）。 */
function effortReasoningLines(count: number, command: string, stage: MockStage): string[] {
  if (count <= 0) return [];
  const pool = [
    `- 意图：${command ? `「${truncate(command, 8)}」` : "先确认目标"}`,
    "- 风险：边界不清与回滚成本",
    "- 用例：先跑最小闭环",
    stage === "synthesis" ? "- 取舍：风险 vs 速度，先小步" : "- 取舍：范围与验收标准",
    "- 校验：结论依赖的假设逐条验证",
    "- 反例：主动找一条能推翻结论的证据",
    "- 验收：可观测指标与回滚耗时",
  ];
  return pool.slice(0, Math.min(count, pool.length));
}

export interface MockAdapterOptions {
  models?: ModelInfo[];
  timeoutMs?: number;
}

export class MockAdapter implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly name: string;
  private readonly extraModels: ModelInfo[];
  private readonly timeoutMs: number;

  constructor(options: MockAdapterOptions = {}) {
    this.name = "演示模型";
    this.extraModels = options.models ?? [];
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listModels(_cred: Credential | null): Promise<ModelInfo[]> {
    return modelsForProvider("mock", this.extraModels);
  }

  /** 生成正文（导出便于测试与预览）。 */
  composeText(opts: ChatCallOptions): { text: string; reasoning: string; label: string } {
    const command = extractCommand(opts);
    const role = extractRole(opts);
    const provider = opts.provider ?? "mock";
    const key = viewpointFor(role, provider);
    const viewpoint = VIEWPOINTS[key];
    const label = role ?? viewpoint.label;
    const stage = extractStage(opts);
    const cmd = truncate(command || "这条命令", 26);
    const thinker = /think|reason/i.test(opts.model);
    const flavor = PROVIDER_FLAVOR[provider] ?? "";
    const profile = opts.effort ? MOCK_EFFORT_PROFILE[opts.effort] : undefined;

    let baseLines: string[];
    if (stage === "synthesis") {
      baseLines = [
        `综合结论（${label}）：围绕「${cmd}」，各方意见已经收敛成一条可执行路线。`,
        "一、先做的最小闭环：把任务拆成两个可独立验收的步骤，今天只交付第一步，并写清回滚方式。",
        "二、取舍：风险类意见成立，但用灰度范围和回滚开关可以控制；实现类意见直接排期，不再扩大讨论。",
        "三、验收：写出可观测指标（成功次数、耗时上限、失败可回滚），达不到就停下复盘，而不是继续加范围。",
        "最终建议：按「小步交付 → 观测 → 再扩范围」推进；分歧留到数据回来后再裁决，现在不追求一次定稿。",
      ];
    } else if (stage === "critique") {
      baseLines = [
        `补充与分歧（${label}）：对「${cmd}」这个方向没有根本反对，但有三处需要当场修正。`,
        "分歧：只按最乐观路径排期，风险会被低估；必须把「失败时怎么退」写进验收，而不是事后补。",
        "补充：把「先做最小闭环」具体成两个可独立验收的步骤，否则它只是一句口号。",
        "补充：口径要统一——事实、推断、猜测分栏标注，避免后面各说各话。",
        `建议：${viewpoint.advice}`,
      ];
    } else if (stage === "rebuttal") {
      baseLines = [
        `反驳与修正（${label}）：对方的方向没错，但把「范围小」当成了「风险低」，这一步推不过去。`,
        "论据：范围小只降低耦合，不降低关键路径上的失败成本；关键路径仍需要单独压测。",
        "论据：所谓「先灰度再放开」如果没有观测指标，只是把风险推迟到下一次发布。",
        `修正：给「${cmd}」加一条硬验收——关键路径失败率与回滚耗时都要可见，才允许扩范围。`,
        `建议：${viewpoint.advice}`,
      ];
    } else {
      const conclusion = viewpoint.conclusion.replace("{cmd}", cmd);
      const prefix = thinker ? "经推演，" : "";
      baseLines = [
        `结论（${label}${thinker ? " · 经推演" : ""}）：${prefix}${flavor}${conclusion}`,
        `1. ${viewpoint.points[0]}`,
        `2. ${viewpoint.points[1]}`,
        `3. ${viewpoint.points[2]}`,
        `建议：${viewpoint.advice}`,
      ];
    }
    const lines = profile ? effortTextLines(baseLines, profile.textLines, cmd) : baseLines;
    const text = lines.join("\n");

    // 无 effort 时保持旧行为：只有 thinker 模型输出 3 行 reasoning。
    const reasoningLines = profile
      ? effortReasoningLines(profile.reasoningLines, command, stage)
      : thinker
        ? [
            `- 意图：${command ? `「${truncate(command, 8)}」` : "先确认目标"}`,
            stage === "synthesis" ? "- 取舍：风险 vs 速度，先小步" : "- 风险：边界与回滚",
            stage === "critique" ? "- 校对：别人的结论是否留了退路" : "- 用例：先跑最小闭环",
          ]
        : [];
    const reasoning = reasoningLines.join("\n");
    return { text, reasoning, label };
  }

  async *chat(opts: ChatCallOptions, cred: Credential | null): AsyncGenerator<ChatChunk> {
    const ctx = createCallContext("mock", "mock://offline", {
      signal: opts.signal,
      timeoutMs: this.timeoutMs,
    });
    try {
      const { text, reasoning } = this.composeText({ ...opts, provider: opts.provider ?? this.id });
      const thinker = reasoning.length > 0;
      const profile = opts.effort ? MOCK_EFFORT_PROFILE[opts.effort] : undefined;

      // 无 effort：25~40 是"目标块数"（切分后实际块数最多比目标少 1，总量仍落在 24~40）；
      // 有 effort：正文块数直接取档位配置，低档更少更短。
      const targetBlocks = profile
        ? profile.textBlocks + (thinker ? reasoning.split("\n").filter(Boolean).length : 0)
        : 25 + randomInt(16);
      // reasoning 按 bullet 行切块，避免把一行拆到两半
      const reasoningBlocks = thinker ? reasoning.split("\n").filter(Boolean) : [];
      const textBlocks = splitIntoBlocks(
        text,
        Math.max(profile ? 1 : 12, targetBlocks - reasoningBlocks.length),
      );

      const delay = (): Promise<void> => {
        // 测试用：MOCK_DELAY_MS 可放慢流式，便于验证「单独终止某个模型」
        const env = Number(process.env.MOCK_DELAY_MS);
        const ms = Number.isFinite(env) && env > 0 ? env : 8 + randomInt(13);
        return sleep(ms, ctx.signal);
      };

      for (let index = 0; index < reasoningBlocks.length; index += 1) {
        throwIfAborted(ctx.signal);
        await delay();
        const suffix = index === reasoningBlocks.length - 1 ? "" : "\n";
        yield { type: "reasoning", text: `${reasoningBlocks[index]}${suffix}` };
      }

      for (const block of textBlocks) {
        throwIfAborted(ctx.signal);
        await delay();
        yield { type: "text", text: block };
      }

      const prompt = [opts.system ?? "", ...opts.messages.map((m) => m.content)].join("\n");
      const usage: { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens?: number } = {
        inputTokens: Math.max(1, estimateTokens(prompt)),
        outputTokens: Math.max(1, estimateTokens(text)),
        totalTokens: 0,
      };
      if (thinker) usage.reasoningTokens = Math.max(1, estimateTokens(reasoning));
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
      yield { type: "usage", usage };
      yield { type: "done", stopReason: "end_turn" };
    } catch (err) {
      throw normalizeProviderError(err, ctx);
    } finally {
      ctx.dispose();
    }
  }

  async validate(cred: Credential): Promise<{ ok: boolean; detail?: string; models?: ModelInfo[] }> {
    return {
      ok: true,
      detail: "演示模型无需网络与凭证",
      models: await this.listModels(cred ?? null),
    };
  }
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  return new MockAdapter(options);
}
