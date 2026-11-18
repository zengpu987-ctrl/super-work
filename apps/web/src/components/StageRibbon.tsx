import type { RunMode } from "@super-work/core";
import type { RunState, StageMark } from "../lib/types";
import { stageSlotsForMode, stageSlotIndex, stageSlotStates } from "../lib/types";
import { IconCheck } from "./Icons";

export interface StageRibbonProps {
  stages: StageMark[];
  state: RunState;
  mode: RunMode;
  /** 最终答案流式输出中：最后一段高亮。 */
  finalStreaming?: boolean;
}

const STATE_TEXT: Record<RunState, string> = {
  loading: "准备中",
  running: "进行中",
  done: "已完成",
  error: "已结束",
};

export function StageRibbon({ stages, state, mode, finalStreaming }: StageRibbonProps) {
  const slots = stageSlotsForMode(mode);
  const finalActive = finalStreaming === true && state === "running";
  const slotStates = finalActive
    ? slots.map((_, index) => (index === slots.length - 1 ? "active" : "done") as "pending" | "active" | "done")
    : stageSlotStates(stages, state, slots);
  const last = stages[stages.length - 1];
  const currentLabel = finalActive
    ? mode === "coordinate"
      ? "裁判综合最终答案"
      : "综合最终答案"
    : last
      ? last.label
      : STATE_TEXT[state];
  const currentIndex = last ? stageSlotIndex(last.stage, slots) : -1;
  const currentSlot = currentIndex >= 0 ? slots[currentIndex]?.label : undefined;

  return (
    <section
      className="stage-ribbon"
      aria-label={`运行阶段，当前 ${currentLabel}${currentSlot ? `（${currentSlot}）` : ""}`}
    >
      <span className="stage-ribbon__label">阶段</span>
      <ol className="stage-ribbon__track">
        {slots.map((slot, index) => {
          const slotState = slotStates[index] ?? "pending";
          return (
            <li
              key={slot.id}
              className={`stage-step stage-step--${slotState}`}
              aria-current={slotState === "active" ? "step" : undefined}
            >
              <span className="stage-step__badge" aria-hidden="true">
                {slotState === "done" ? <IconCheck size={9} /> : String(index + 1).padStart(2, "0")}
              </span>
              <span className="stage-step__label">{slot.label}</span>
              {index < slots.length - 1 ? <span className="stage-step__line" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
      <span className="stage-ribbon__current" aria-live="polite">
        {currentLabel}
      </span>
    </section>
  );
}
