/** 工作流：可保存、可复用的多步骤模型编排。 */
import type { Usage } from "./types.js";
import type { ParticipantSpec } from "./events.js";

export interface WorkflowStep {
  id: string;
  name: string;
  /** 这一步用哪个模型（与 role 二选一；model 显式指定时优先） */
  model?: ParticipantSpec;
  /** 角色提示词（例如「代码审查」），会作为 system 角色注入 */
  role?: string;
  instruction: string;
  /** 输入来源 */
  input: "command" | "previous" | "all";
  /** 同一 parallelGroup 的步骤并行执行（按组号升序） */
  parallelGroup?: number;
  /** 把输出当作 JSON 处理（失败则按文本处理） */
  outputMode?: "text" | "json";
  /** 输出超过该字符数时截断后再给后续步骤 */
  maxOutputChars?: number;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** 内置模板标记 */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStepRun {
  stepId: string;
  name: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  text: string;
  reasoning?: string;
  usage?: Usage;
  latencyMs?: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  command: string;
  status: "running" | "done" | "error";
  steps: WorkflowStepRun[];
  finalText: string;
  usage?: Usage;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface WorkflowCreateRequest {
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface WorkflowRunRequest {
  command: string;
  /** 只跑部分步骤（不填 = 全部） */
  stepIds?: string[];
  overrides?: Record<string, ParticipantSpec>;
}

/** 内置示例工作流（首次启动写入，可编辑）。 */
export const BUILTIN_WORKFLOWS: Array<Omit<WorkflowDef, "id" | "createdAt" | "updatedAt">> = [
  {
    name: "需求 → 实现 → 审查",
    description: "先拆需求与验收，再写实现，最后做一轮代码审查与风险清单。",
    builtin: true,
    steps: [
      {
        id: "s1",
        name: "拆解需求",
        role: "需求分析与验收标准",
        instruction: "把用户的命令拆成可执行的任务清单，写出验收标准与不做什么。输出精简、可勾选的清单。",
        input: "command",
      },
      {
        id: "s2",
        name: "给出实现",
        role: "代码实现",
        instruction: "基于上一步的任务清单给出完整实现（代码 + 命令），标注每一步如何验证。",
        input: "previous",
      },
      {
        id: "s3",
        name: "审查与风险",
        role: "代码审查",
        instruction: "审查上一步的实现：指出 bug、边界情况、安全与性能风险，给出最小修改建议。",
        input: "previous",
        parallelGroup: 2,
      },
      {
        id: "s4",
        name: "汇总交付",
        role: "技术负责人",
        instruction: "把前面的分析与审查合并成一份最终交付说明：做什么、怎么做、怎么验证、还有什么风险。",
        input: "all",
        parallelGroup: 3,
      },
    ],
  },
  {
    name: "研究 → 交叉验证 → 结论",
    description: "三个模型并行研究同一问题，再由裁判交叉验证并给结论。",
    builtin: true,
    steps: [
      {
        id: "r1",
        name: "并行研究 A",
        role: "资料研究",
        instruction: "围绕用户命令做结构化研究：已知事实、关键争议、需要验证的假设。",
        input: "command",
        parallelGroup: 1,
      },
      {
        id: "r2",
        name: "并行研究 B",
        role: "反方审视",
        instruction: "围绕用户命令给出与主流叙事相反的证据与推理，明确指出哪些结论站不住。",
        input: "command",
        parallelGroup: 1,
      },
      {
        id: "r3",
        name: "交叉验证",
        role: "裁判",
        instruction: "比较两份研究：哪些一致、哪些冲突、冲突处谁有证据。给出可信结论与不确定项。",
        input: "all",
        parallelGroup: 2,
      },
    ],
  },
];
