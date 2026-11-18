import type { ReactNode } from "react";
import type { ResourcePage } from "../lib/types";
import { IconChevronLeft } from "./Icons";

const PAGE_TITLE: Record<ResourcePage, { title: string; sub: string }> = {
  billing: { title: "计费", sub: "用量、成本与价格表" },
  memory: { title: "记忆", sub: "长期记忆空间与条目" },
  workflow: { title: "工作流", sub: "可复用的多步骤编排" },
};

export interface ResourceOverlayProps {
  page: ResourcePage;
  onBack: () => void;
  children: ReactNode;
}

/** 资源页统一骨架：56px 页头 + 内容区；覆盖式进入，返回不重置工作台。 */
export function ResourceOverlay({ page, onBack, children }: ResourceOverlayProps) {
  const meta = PAGE_TITLE[page];
  return (
    <section className="resource-overlay" aria-label={`${meta.title}页面`}>
      <header className="resource-header">
        <button type="button" className="resource-header__back" onClick={onBack} aria-label="返回工作台">
          <IconChevronLeft size={14} /> 工作台
        </button>
        <div className="resource-header__titles">
          <h1>{meta.title}</h1>
          <span>{meta.sub}</span>
        </div>
        <span className="resource-header__hint">Esc 返回</span>
      </header>
      <div className="resource-body">{children}</div>
    </section>
  );
}
