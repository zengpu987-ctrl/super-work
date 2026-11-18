import type { ReactNode } from "react";
import { IconX } from "./Icons";

export type RightTab = "orchestrate" | "context";

export interface RightRailProps {
  tab: RightTab;
  onClose: () => void;
  onTabChange: (tab: RightTab) => void;
  contextCount: number;
  running: boolean;
  open?: boolean;
  children: ReactNode;
}

export function RightRail({ tab, onTabChange, contextCount, running, open, onClose, children }: RightRailProps) {
  return (
    <aside className={`rail rail-right${open ? " is-open" : ""}`} aria-label="编排与上下文">
      <div className="right-tabs" role="tablist" aria-label="右栏页签">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "orchestrate"}
          className={`right-tab${tab === "orchestrate" ? " is-active" : ""}`}
          onClick={() => onTabChange("orchestrate")}
        >
          编排
          {running ? <span className="right-tab__live" aria-label="运行中" /> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "context"}
          className={`right-tab${tab === "context" ? " is-active" : ""}`}
          onClick={() => onTabChange("context")}
        >
          上下文
          {contextCount > 0 ? <span className="right-tab__count mono">{contextCount}</span> : null}
        </button>
      </div>
      <button type="button" className="icon-btn rail-right__close" aria-label="关闭编排栏" onClick={onClose}>
        <IconX size={14} />
      </button>
      <div className="rail-scroll right-content">{children}</div>
    </aside>
  );
}
