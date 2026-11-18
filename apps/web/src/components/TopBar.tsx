import { useEffect, useRef, useState } from "react";
import type { ResourcePage } from "../lib/types";
import { truncate } from "../lib/format";
import {
  IconChart,
  IconChevronDown,
  IconDatabase,
  IconMenu,
  IconPanelRight,
  IconRefresh,
  IconSettings,
  IconWorkflow,
} from "./Icons";

export interface TopBarProps {
  connectedProviders: number;
  totalProviders: number;
  availableModels: number;
  running: boolean;
  offline: boolean;
  runTitle: string;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSettings: () => void;
  activeResource: ResourcePage | null;
  onOpenResource: (page: ResourcePage | null) => void;
  /** 拉取上游最新模型目录；未提供时隐藏按钮 */
  onSyncModels?: () => Promise<void>;
}

function BrandMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.6 21.4 8v8L12 21.4 2.6 16V8L12 2.6Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 7.2 17 10v4L12 16.8 7 14v-4l5-2.8Z" fill="currentColor" opacity="0.86" />
    </svg>
  );
}

const RESOURCES: Array<{ id: ResourcePage; label: string; sub: string; icon: typeof IconChart }> = [
  { id: "billing", label: "计费", sub: "用量 / 成本 / 价格表", icon: IconChart },
  { id: "memory", label: "记忆", sub: "空间 / 条目 / DSH 导入", icon: IconDatabase },
  { id: "workflow", label: "工作流", sub: "模板 / 步骤 / 运行", icon: IconWorkflow },
];

export function TopBar({
  onSyncModels,
  connectedProviders,
  totalProviders,
  availableModels,
  running,
  offline,
  runTitle,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onOpenSettings,
  activeResource,
  onOpenResource,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const syncTimer = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const handleSync = (): void => {
    if (!onSyncModels || syncing) return;
    setSyncing(true);
    setSyncDone(false);
    void onSyncModels()
      .then(() => {
        setSyncDone(true);
        if (syncTimer.current) window.clearTimeout(syncTimer.current);
        syncTimer.current = window.setTimeout(() => setSyncDone(false), 4000);
      })
      .catch(() => undefined)
      .finally(() => setSyncing(false));
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const statusClass = running ? "is-running" : offline ? "is-offline" : "is-idle";
  const statusText = running ? "运行中" : offline ? "服务离线" : "空闲就绪";

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn drawer-toggle drawer-toggle-left"
        onClick={onToggleLeft}
        aria-label={leftOpen ? "收起运行历史栏" : "展开运行历史栏"}
        aria-expanded={leftOpen}
      >
        <IconMenu size={16} />
      </button>
      <div className="brand">
        <span className="brand__mark" data-earth-slot="mini">
          <BrandMark />
        </span>
        <div className="brand__text">
          <span className="brand__name">Super Work</span>
          <span className="brand__sub">多模型联合工作台</span>
        </div>
      </div>

      <span className="topbar__divider" aria-hidden="true" />

      <div className="topbar__center">
        <span className="topbar__label">当前</span>
        <span className="topbar__crumb" title={runTitle || "新工作台"}>
          <span
            className={`dot ${running ? "dot-warn" : connectedProviders > 0 ? "dot-ok" : "dot-off"}`}
            aria-hidden="true"
          />
          {runTitle ? truncate(runTitle, 64) : "新对话"}
        </span>
      </div>

      <div className="topbar__status">
        <button
          type="button"
          className="status-pill"
          onClick={onOpenSettings}
          aria-label={`已连接 ${connectedProviders} 家 provider，共 ${availableModels} 个可用模型，打开连接设置`}
          title="模型连接状态 · 点击打开设置"
        >
          <span className={`dot ${connectedProviders > 0 ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
          <span className="status-pill__label">已连接</span>
          <b>{connectedProviders}</b>
          <span className="status-pill__sep">/ {totalProviders}</span>
          <span className="status-pill__sep">·</span>
          <span>{availableModels} 个模型</span>
        </button>

        <div className={`status-light ${statusClass}`} role="status" aria-live="polite">
          <span className="status-light__dot" aria-hidden="true" />
          {statusText}
        </div>

        {onSyncModels ? (
          <button
            type="button"
            className="btn btn-sm topbar__sync"
            onClick={handleSync}
            disabled={syncing}
            title="从各家上游拉取最新模型目录（需要对应平台已连接）"
            aria-label="同步最新模型目录"
          >
            <IconRefresh size={11} />
            <span>{syncing ? "同步中…" : syncDone ? "已同步" : "同步模型"}</span>
          </button>
        ) : null}

        <div className="resource-menu" ref={menuRef}>
          <button
            type="button"
            className={`btn resource-menu__trigger${menuOpen || activeResource ? " is-open" : ""}`}
            onClick={() => setMenuOpen((prev) => !prev)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            资源 <IconChevronDown size={11} />
          </button>
          {menuOpen ? (
            <div className="resource-menu__panel" role="menu" aria-label="资源页面">
              {RESOURCES.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className={`resource-menu__item${activeResource === item.id ? " is-active" : ""}`}
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenResource(item.id);
                    }}
                  >
                    <span className="resource-menu__item-icon">
                      <Icon size={14} />
                    </span>
                    <span>
                      {item.label}
                      <span className="resource-menu__item-sub">{item.sub}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="icon-btn drawer-toggle drawer-toggle-right"
          onClick={onToggleRight}
          aria-label={rightOpen ? "收起编排栏" : "展开编排栏"}
          aria-expanded={rightOpen}
        >
          <IconPanelRight size={16} />
        </button>

        <button
          type="button"
          className="btn btn-ghost topbar__settings"
          onClick={onOpenSettings}
          aria-label="打开模型连接与设置"
        >
          <IconSettings size={14} />
          <span>设置</span>
        </button>
      </div>
    </header>
  );
}
