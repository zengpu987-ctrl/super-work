import type { BudgetSettings, RunMode } from "@super-work/core";
import type { BudgetUsageView } from "../lib/api";
import { BudgetMeter } from "./BudgetMeter";
import { IconLayers, IconUsers, IconWorkflow } from "./Icons";

export interface ToolbarProps {
  mode: RunMode;
  onModeChange: (mode: RunMode) => void;
  /** 运行中锁定模式切换（只影响后续运行） */
  running: boolean;
  /** 配合模式：已配置的角色数（含自定义） */
  roleCount: number;
  roleModelCount: number;
  parallelCount: number;
  onOpenRoles: () => void;
  onSaveWorkflow: () => void;
  canSaveWorkflow: boolean;
  onOpenHistory: () => void;
  /** 模型团队：并行 + 配合去重后的成员数 */
  teamCount: number;
  onOpenTeam: () => void;
  /** Chat：当前唯一模型名 */
  chatModelLabel?: string;
  /* v0.0.3 预算 */
  budgetUsage: BudgetUsageView | null;
  budgets: BudgetSettings;
  cheapMode: boolean;
  budgetLoading: boolean;
  budgetFailed: boolean;
  onToggleCheapMode: (value: boolean) => void;
  onOpenBudget: () => void;
}

export function Toolbar({
  mode,
  onModeChange,
  running,
  roleCount,
  roleModelCount,
  parallelCount,
  onOpenRoles,
  onSaveWorkflow,
  canSaveWorkflow,
  onOpenHistory,
  teamCount,
  onOpenTeam,
  chatModelLabel,
  budgetUsage,
  budgets,
  cheapMode,
  budgetLoading,
  budgetFailed,
  onToggleCheapMode,
  onOpenBudget,
}: ToolbarProps) {
  const coordinate = mode === "coordinate";
  const chat = mode === "chat";
  return (
    <div className="toolbar" role="region" aria-label="工作台工具条">
      <div className="toolbar__controls">
        <div className="segmented" role="group" aria-label="工作台模式">
          <button
            type="button"
            className={`segmented__item${mode === "parallel" ? " is-active" : ""}`}
            onClick={() => onModeChange("parallel")}
            aria-pressed={mode === "parallel"}
            disabled={running}
            title={running ? "运行中锁定模式，结束后可切换" : "并行：所有参与模型同时独立作答"}
          >
            并行
            <span className="seg-en">Parallel</span>
          </button>
          <button
            type="button"
            className={`segmented__item${coordinate ? " is-active" : ""}`}
            onClick={() => onModeChange("coordinate")}
            aria-pressed={coordinate}
            disabled={running}
            title={running ? "运行中锁定模式，结束后可切换" : "配合：按角色分工，未配置角色不会调用"}
          >
            配合
            <span className="seg-en">Coordinate</span>
          </button>
          <button
            type="button"
            className={`segmented__item${chat ? " is-active" : ""}`}
            onClick={() => onModeChange("chat")}
            aria-pressed={chat}
            disabled={running}
            title={running ? "运行中锁定模式，结束后可切换" : "Chat：每次只选一个模型，像聊天一样多轮对话"}
          >
            Chat
            <span className="seg-en">单模型</span>
          </button>
        </div>
        <button type="button" className="toolbar__role-entry" onClick={onOpenRoles} title={chatModelLabel ?? (coordinate ? "配置角色与模型" : "选择参与模型")}>
          <IconLayers size={13} />
          {coordinate ? <>角色编排 <b>{roleModelCount}</b></> : chat ? <span>{chatModelLabel ?? "选择模型"}</span> : "参与模型"}
        </button>
        <button
          type="button"
          className="toolbar__team-entry"
          id="team-entry"
          onClick={onOpenTeam}
          title="模型团队：把并行与配合模式用到的模型归纳到一处"
        >
          <IconUsers size={13} /> 模型团队 <b>{teamCount}</b>
        </button>
        <span className="toolbar__desc">
          {chat ? (
            <>
              Chat · {chatModelLabel ? <b>{chatModelLabel}</b> : <span className="is-warn">未选择模型</span>} · 每次只能 1 个模型
            </>
          ) : coordinate ? (
            <>
              按角色分工 · 已配置 <b className="mono">{roleCount}</b> 个角色 /{" "}
              <b className="mono">{roleModelCount}</b> 个模型
            </>
          ) : (
            <>
              并行作答 · 已选 <b className="mono">{parallelCount}</b> 个模型
            </>
          )}
        </span>

        {running ? (
          <span className="toolbar__lock" role="status">
            运行中 · 模式已锁定
          </span>
        ) : null}
      </div>
      <div className="toolbar__utilities">
        <BudgetMeter
          usage={budgetUsage}
          budgets={budgets}
          cheapMode={cheapMode}
          loading={budgetLoading}
          failed={budgetFailed}
          running={running}
          onToggleCheapMode={onToggleCheapMode}
          onOpenBudget={onOpenBudget}
        />
        <div className="toolbar__actions">
          <button
            type="button"
            className="btn"
            onClick={onSaveWorkflow}
            disabled={!canSaveWorkflow}
            title={canSaveWorkflow ? "把本次运行保存为可复用的工作流" : "先完成一次运行才能保存为工作流"}
          >
            <IconWorkflow size={13} /> <span>保存为工作流</span>
          </button>
          <button type="button" className="btn" onClick={onOpenHistory} title="查看工作记录（多轮对话）">
            <IconLayers size={13} /> <span>工作记录</span>
          </button>
        </div>
      </div>
    </div>
  );
}
