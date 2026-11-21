import { useState } from "react";
import type { ProviderId, ProviderStatus, ThreadSummary } from "@super-work/core";
import { MODE_META } from "../lib/types";
import { formatRelative, formatTokens, truncate } from "../lib/format";
import { ProviderRow } from "./ProviderRow";
import { IconBrain, IconClock, IconLayers, IconPlus, IconRefresh, IconSearch, IconTrash } from "./Icons";

export interface HistoryRailProps {
  /** 多轮对话：一个工作 = 一条对话线（左栏按工作展示） */
  threads: ThreadSummary[];
  loading: boolean;
  activeThreadId?: string;
  onSelectThread: (threadId: string) => void;
  providers: ProviderStatus[];
  onOpenSettings: (provider?: ProviderId) => void;
  online: boolean;
  version?: string;
  onRefresh: () => void;
  onRefreshProviders: () => void;
  onNew: () => void;
  showArchived?: boolean;
  onToggleArchived?: () => void;
  onArchive?: (threadId: string, archived: boolean) => void;
  onDelete?: (threadId: string) => void;
  onOpenMemory?: (thread: ThreadSummary) => void;
  open?: boolean;
}

const STATUS_META: Record<ThreadSummary["status"], { label: string; dot: string }> = {
  running: { label: "运行中", dot: "dot-warn" },
  done: { label: "完成", dot: "dot-ok" },
  error: { label: "失败", dot: "dot-err" },
};

export function HistoryRail({
  threads,
  loading,
  activeThreadId,
  onSelectThread,
  providers,
  onOpenSettings,
  online,
  version,
  onRefresh,
  onRefreshProviders,
  onNew,
  showArchived = false,
  onToggleArchived,
  onArchive,
  onDelete,
  onOpenMemory,
  open,
}: HistoryRailProps) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const matches = query ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query)) : threads;
  return (
    <aside className={`rail rail-left${open ? " is-open" : ""}`} aria-label="工作记录与模型连接">
      <button type="button" className="history-new" onClick={onNew} title="开始一条新的多轮对话">
        <IconPlus size={17} /> 新建对话
      </button>
      <label className="history-search">
        <IconSearch size={15} aria-hidden="true" />
        <input type="search" aria-label="搜索工作记录" placeholder="搜索对话" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="history-view-toggle" role="group" aria-label="对话范围">
        <button
          type="button"
          className={`history-view-toggle__btn${showArchived ? "" : " is-active"}`}
          onClick={() => { if (showArchived) onToggleArchived?.(); }}
        >
          当前
        </button>
        <button
          type="button"
          className={`history-view-toggle__btn${showArchived ? " is-active" : ""}`}
          onClick={() => { if (!showArchived) onToggleArchived?.(); }}
          title="显示已归档的对话"
        >
          归档
        </button>
      </div>

      <div className="rail-head">
        <h2 className="rail-head__title rail-label">工作记录</h2>
        <span className="rail-head__count mono">{threads.length}</span>
        <div className="rail-head__actions">
          <button
            type="button"
            className="icon-btn"
            onClick={onRefresh}
            aria-label="刷新工作记录"
            title="刷新工作记录"
          >
            <IconRefresh size={13} />
          </button>
        </div>
      </div>

      <div className="rail-history-list" role="list" aria-label="工作记录">
        {loading && threads.length === 0 ? (
          <div className="rail-empty">正在读取工作记录…</div>
        ) : threads.length === 0 ? (
          <div className="rail-empty">
            <strong>还没有工作记录</strong>
            发出第一条命令后，这里按工作保留多轮对话与最终答案。
          </div>
        ) : (
          matches.length === 0 ? (
            <div className="rail-empty">找不到匹配的对话</div>
          ) : matches.map((thread) => {
            const status = STATUS_META[thread.status] ?? { label: thread.status, dot: "" };
            const active = thread.id === activeThreadId;
            const modeName = MODE_META[thread.mode]?.name ?? thread.mode;
            return (
              <div
                key={thread.id}
                role="listitem"
                className={`history-item${active ? " is-active" : ""}${thread.archived ? " is-archived" : ""}`}
              >
                <button
                  type="button"
                  className="history-item__open"
                  onClick={() => onSelectThread(thread.id)}
                  aria-current={active ? "true" : undefined}
                  title={`${modeName} · ${thread.title}`}
                  aria-label={`${modeName}工作，${thread.rounds} 轮，${truncate(thread.title, 40)}，${status.label}`}
                >
                  <span className="history-item__top">
                    <span className="history-item__mode">{modeName}</span>
                    {thread.parentThreadId ? <span className="history-item__branch"><IconLayers size={10} /> 分支</span> : null}
                    {thread.rounds > 1 ? (
                      <span className="history-item__round mono">{thread.rounds} 轮</span>
                    ) : null}
                    <span className="history-item__time">{formatRelative(thread.updatedAt)}</span>
                  </span>
                  <span className="history-item__command clamp-2">{thread.title}</span>
                  <span className="history-item__meta">
                    <span className={`dot ${thread.status === "running" ? "dot-warn" : status.dot}`} aria-hidden="true" />
                    {status.label}
                    <span aria-hidden="true">·</span>
                    <span className="mono">{thread.participantCount} 模型</span>
                    {thread.usage?.totalTokens ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="mono">{formatTokens(thread.usage.totalTokens)} tok</span>
                      </>
                    ) : null}
                    {thread.memory ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="history-item__memory" title="已保存对话记忆"><IconBrain size={10} /> 记忆</span>
                      </>
                    ) : null}
                  </span>
                </button>
                <div className="history-item__actions">
                  {onOpenMemory ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={(event) => { event.stopPropagation(); onOpenMemory(thread); }}
                      aria-label={`编辑对话记忆 ${thread.title}`}
                      title="对话记忆"
                    >
                      <IconBrain size={12} />
                    </button>
                  ) : null}
                  {onArchive ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={(event) => { event.stopPropagation(); onArchive(thread.id, !thread.archived); }}
                      aria-label={`${thread.archived ? "取消归档" : "归档"}对话 ${thread.title}`}
                      title={thread.archived ? "取消归档" : "归档"}
                    >
                      <IconClock size={12} />
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      className="icon-btn history-item__delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (window.confirm(`删除对话「${truncate(thread.title, 40)}」？运行记录与产物仍保留在本机，只是不再显示。`)) onDelete(thread.id);
                      }}
                      aria-label={`删除对话 ${thread.title}`}
                      title="删除对话"
                    >
                      <IconTrash size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      <details className="rail-block history-providers">
        <summary>模型连接 <span>{providers.filter((provider) => provider.connected).length} 已连接</span></summary>
        <div className="rail-head">
          <h2 className="rail-head__title rail-label">模型连接</h2>
          <div className="rail-head__actions">
            <button
              type="button"
              className="icon-btn"
              onClick={onRefreshProviders}
              aria-label="刷新模型连接状态"
              title="刷新连接状态"
            >
              <IconRefresh size={13} />
            </button>
          </div>
        </div>
        <div className="provider-scroll" role="list" aria-label="provider 连接状态">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              id={provider.id}
              name={provider.name}
              short={provider.short}
              color={provider.color}
              connected={provider.connected}
              connectionCount={provider.connections.length}
              onClick={() => onOpenSettings(provider.id)}
              ariaLabel={`${provider.name}，${provider.connected ? `已连接 ${provider.connections.length} 个凭证` : "未连接"}，打开设置`}
            />
          ))}
        </div>
      </details>

      <div className="rail-foot">
        <span className={`dot ${online ? "dot-ok" : "dot-err"}`} aria-hidden="true" />
        <span className="rail-label">{online ? "本机服务已连接" : "本机服务未连接"}</span>
        {version ? <span className="mono">v{version}</span> : <span className="mono">离线预览</span>}
      </div>
    </aside>
  );
}
