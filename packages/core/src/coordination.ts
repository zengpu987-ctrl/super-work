/** 配合模式：8 个角色槽位。未选中的角色严格不调用。 */
import type { ParticipantSpec } from "./events.js";

export type CoordRole =
  | "commander" // 发令官
  | "image" // 生图
  | "reasoning" // 强推理
  | "coding" // 代码实现
  | "integrator" // 整合优化
  | "model3d" // 建模
  | "chat" // Chat
  | "judge"; // 裁判

export interface CoordRoleMeta {
  id: CoordRole;
  name: string;
  short: string;
  description: string;
  /** 该角色是"执行型"（产出文本/代码）还是"生成型"（直接产出图片） */
  kind: "text" | "image";
  /** 该角色在流程中的阶段顺序 */
  order: number;
  required?: boolean;
  hint?: string;
}

export const COORD_ROLES: CoordRoleMeta[] = [
  {
    id: "commander",
    name: "发令官",
    short: "发令",
    description: "把用户命令翻译成明确的任务分解与验收标准，给其他角色下可执行的指令。",
    kind: "text",
    order: 0,
    hint: "不选则由原始命令直接驱动后续角色",
  },
  {
    id: "reasoning",
    name: "强推理",
    short: "推理",
    description: "负责硬推理、方案推演、事实与逻辑校验。",
    kind: "text",
    order: 1,
  },
  {
    id: "coding",
    name: "代码实现",
    short: "代码",
    description: "负责写出可运行的代码、命令或配置，并说明验证方式。",
    kind: "text",
    order: 2,
  },
  {
    id: "model3d",
    name: "建模",
    short: "建模",
    description: "负责 Three.js / Blender 等 3D 方案与可运行代码，成果会在右侧以代码+预览呈现。",
    kind: "text",
    order: 3,
  },
  {
    id: "image",
    name: "生图",
    short: "生图",
    description: "直接调用图像模型产出图片（需要 WorkBuddy / 生图通道）。",
    kind: "image",
    order: 4,
  },
  {
    id: "chat",
    name: "Chat",
    short: "聊天",
    description: "负责对用户可读的解释、追问与对话式收尾。",
    kind: "text",
    order: 5,
  },
  {
    id: "integrator",
    name: "整合优化",
    short: "整合",
    description: "把各角色的产出合并、去重、补缺口，形成一版完整交付稿。",
    kind: "text",
    order: 6,
  },
  {
    id: "judge",
    name: "裁判",
    short: "裁判",
    description: "按发令官的验收标准打分、挑错，给出最终结论。",
    kind: "text",
    order: 7,
  },
];

export const COORD_ROLE_BY_ID: Record<CoordRole, CoordRoleMeta> = Object.fromEntries(
  COORD_ROLES.map((r) => [r.id, r]),
) as Record<CoordRole, CoordRoleMeta>;

/** 内置角色 id 或自定义角色 id（`custom_*`）。 */
export type CoordRoleId = CoordRole | (string & {});

export interface CoordinationAssignment {
  role: CoordRoleId;
  participants: ParticipantSpec[];
}

/** 解析角色元数据：内置优先，其次自定义角色；未知角色按文本角色处理。 */
export function resolveCoordRole(
  role: CoordRoleId,
  customRoles?: import("./v3.js").CustomRoleDef[],
): CoordRoleMeta & { builtin: boolean; custom?: import("./v3.js").CustomRoleDef } {
  const builtin = COORD_ROLE_BY_ID[role as CoordRole];
  if (builtin) return { ...builtin, builtin: true };
  const custom = customRoles?.find((r) => r.id === role);
  if (custom) {
    return {
      id: role as CoordRole,
      name: custom.name,
      short: custom.name.slice(0, 2),
      description: custom.description,
      kind: custom.kind,
      order: custom.order,
      builtin: false,
      custom,
    };
  }
  return {
    id: role as CoordRole,
    name: String(role),
    short: String(role).slice(0, 2),
    description: "自定义角色",
    kind: "text",
    order: 900,
    builtin: false,
  };
}

export const COORD_ROLE_LABEL: Record<CoordRole, string> = Object.fromEntries(
  COORD_ROLES.map((r) => [r.id, r.name]),
) as Record<CoordRole, string>;

/** 配合模式的默认执行顺序（不含发令官与裁判，它们由阶段单独处理）。 */
export const COORD_EXECUTION_ORDER: CoordRole[] = ["reasoning", "coding", "model3d", "image", "chat"];
