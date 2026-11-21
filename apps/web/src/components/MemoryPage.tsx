import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemoryHit, MemoryKind, MemorySpace, MemoryStats } from "@super-work/core";
import { MEMORY_KIND_LABEL } from "@super-work/core";
import { api, errorMessage, isApiError } from "../lib/api";
import { formatRelative, truncate } from "../lib/format";
import {
  IconAlert,
  IconBrain,
  IconCheck,
  IconEdit,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "./Icons";
import { PaddleSwitch } from "./PaddleSwitch";

export interface MemoryPageProps {
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

const KINDS: MemoryKind[] = ["fact", "preference", "decision", "insight"];

interface EntryDraft {
  content: string;
  kind: MemoryKind;
  importance: number;
  tags: string;
  spaceId: string;
}

const EMPTY_DRAFT: EntryDraft = { content: "", kind: "fact", importance: 3, tags: "", spaceId: "" };

function hitsToEntries(hits: MemoryHit[]): MemoryEntry[] {
  return hits.map((hit) => hit.memory);
}

export function MemoryPage({ pushToast }: MemoryPageProps) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [spaces, setSpaces] = useState<MemorySpace[]>([]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [selectedSpace, setSelectedSpace] = useState<string>("");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemoryHit[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft>({ ...EMPTY_DRAFT });
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EntryDraft>({ ...EMPTY_DRAFT });
  const [spaceForm, setSpaceForm] = useState<{ name: string; description: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, spaceList] = await Promise.all([
        api.getMemoryStats().catch(() => null),
        api.listMemorySpaces(),
      ]);
      setStats(statsRes);
      setSpaces(spaceList.length > 0 ? spaceList : statsRes?.spaces ?? []);
      setMissing(false);
      setEntries(await api.listMemoryEntries({ spaceId: selectedSpace || undefined, limit: 200 }));
    } catch (err) {
      if (isApiError(err) && err.status === 404) setMissing(true);
      else setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [selectedSpace]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    setBusy("search");
    try {
      const hits = await api.searchMemory(q, 40);
      setSearchHits(hits);
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        pushToast("info", "记忆搜索接口未就绪", "先用空间列表浏览条目。");
      } else {
        pushToast("error", "搜索失败", errorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }, [pushToast, query]);

  useEffect(() => {
    if (!query.trim()) setSearchHits(null);
  }, [query]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const createEntry = async (): Promise<void> => {
    if (!draft.content.trim()) {
      pushToast("warn", "记忆内容不能为空");
      return;
    }
    setBusy("create");
    try {
      await api.createMemoryEntry({
        content: draft.content.trim(),
        kind: draft.kind,
        importance: draft.importance,
        tags: draft.tags
          .split(/[,，\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        spaceId: draft.spaceId || selectedSpace || undefined,
      });
      pushToast("success", "已添加记忆");
      setDraft({ ...EMPTY_DRAFT, spaceId: selectedSpace });
      setShowNew(false);
      await refresh();
    } catch (err) {
      pushToast("error", "添加记忆失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (entry: MemoryEntry): void => {
    setEditingId(entry.id);
    setEditDraft({
      content: entry.content,
      kind: entry.kind,
      importance: entry.importance,
      tags: entry.tags.join(", "),
      spaceId: entry.spaceId,
    });
  };

  const saveEdit = async (entry: MemoryEntry): Promise<void> => {
    if (!editDraft.content.trim()) {
      pushToast("warn", "记忆内容不能为空");
      return;
    }
    setBusy(`edit:${entry.id}`);
    try {
      await api.updateMemoryEntry(entry.id, {
        content: editDraft.content.trim(),
        kind: editDraft.kind,
        importance: editDraft.importance,
        tags: editDraft.tags
          .split(/[,，\s]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
        spaceId: editDraft.spaceId || undefined,
      });
      pushToast("success", "记忆已更新");
      setEditingId(null);
      await refresh();
    } catch (err) {
      pushToast("error", "更新记忆失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleEntry = async (entry: MemoryEntry): Promise<void> => {
    setBusy(`toggle:${entry.id}`);
    try {
      await api.updateMemoryEntry(entry.id, { enabled: !entry.enabled });
      await refresh();
    } catch (err) {
      pushToast("error", "切换启停失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const removeEntry = async (entry: MemoryEntry): Promise<void> => {
    if (confirmDelete !== entry.id) {
      setConfirmDelete(entry.id);
      setTimeout(() => setConfirmDelete((prev) => (prev === entry.id ? null : prev)), 4000);
      return;
    }
    setConfirmDelete(null);
    setBusy(`delete:${entry.id}`);
    try {
      await api.deleteMemoryEntry(entry.id);
      pushToast("success", "已删除记忆");
      await refresh();
    } catch (err) {
      pushToast("error", "删除记忆失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const createSpace = async (): Promise<void> => {
    if (!spaceForm?.name.trim()) {
      pushToast("warn", "空间名称不能为空");
      return;
    }
    setBusy("space");
    try {
      await api.createMemorySpace({
        name: spaceForm.name.trim(),
        description: spaceForm.description.trim() || undefined,
      });
      pushToast("success", "已创建记忆空间");
      setSpaceForm(null);
      await refresh();
    } catch (err) {
      pushToast("error", "创建空间失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const importDsh = async (): Promise<void> => {
    setBusy("import");
    try {
      const res = await api.importDshMemory();
      pushToast(
        "success",
        "已导入 DSH 记忆",
        res.imported != null ? `新增 ${res.imported} 条` : res.detail ?? "导入完成",
      );
      await refresh();
    } catch (err) {
      pushToast("error", "导入 DSH 失败", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const shownEntries = useMemo(() => {
    if (searchHits) return hitsToEntries(searchHits);
    return entries;
  }, [entries, searchHits]);

  const spaceName = useMemo(() => {
    const map = new Map(spaces.map((space) => [space.id, space.name]));
    return (id: string): string => map.get(id) ?? id;
  }, [spaces]);

  if (loading && !stats && entries.length === 0) {
    return (
      <div className="resource-loading">
        <IconLoader size={16} className="spin" /> 正在读取记忆…
      </div>
    );
  }

  if (missing) {
    return (
      <div className="resource-fallback">
        <span className="resource-fallback__icon">
          <IconBrain size={20} />
        </span>
        <h3>记忆接口未就绪</h3>
        <p>
          服务端实现 <code>/api/memory/stats</code>、<code>/api/memory/entries</code> 与搜索接口后，这里会显示空间、条目与
          DSH 导入。
        </p>
        <button type="button" className="btn" onClick={() => void refresh()}>
          <IconRefresh size={12} /> 重新读取
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="resource-fallback resource-fallback--error">
        <span className="resource-fallback__icon">
          <IconAlert size={20} />
        </span>
        <h3>记忆读取失败</h3>
        <p>{error}</p>
        <button type="button" className="btn" onClick={() => void refresh()}>
          <IconRefresh size={12} /> 重试
        </button>
      </div>
    );
  }

  return (
    <div className="memory-page">
      <div className="resource-toolbar">
        <div className="resource-toolbar__stats">
          <span>
            共 <b className="mono">{stats?.total ?? entries.length}</b> 条记忆
          </span>
          <span>·</span>
          <span>
            启用 <b className="mono">{stats?.enabled ?? entries.filter((entry) => entry.enabled).length}</b>
          </span>
          {stats ? (
            <>
              <span>·</span>
              <span>
                {KINDS.map((kind) => `${MEMORY_KIND_LABEL[kind]} ${stats.byKind?.[kind] ?? 0}`).join(" / ")}
              </span>
            </>
          ) : null}
        </div>
        <div className="resource-toolbar__actions">
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            <IconRefresh size={12} /> 刷新
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void importDsh()} disabled={busy === "import"}>
            {busy === "import" ? <IconLoader size={12} className="spin" /> : <IconUpload size={12} />} 导入 DSH
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowNew((prev) => !prev)}>
            <IconPlus size={12} /> 新建记忆
          </button>
        </div>
      </div>

      <div className="memory-layout">
        <aside className="memory-spaces" aria-label="记忆空间">
          <div className="memory-spaces__head">
            <span>空间</span>
            <button type="button" className="icon-btn" onClick={() => setSpaceForm({ name: "", description: "" })} aria-label="新建空间">
              <IconPlus size={12} />
            </button>
          </div>
          <button
            type="button"
            className={`space-row${selectedSpace === "" ? " is-active" : ""}`}
            onClick={() => {
              setSelectedSpace("");
              setSearchHits(null);
            }}
          >
            <span className="space-row__name">全部记忆</span>
            <span className="mono">{stats?.total ?? entries.length}</span>
          </button>
          {spaces.map((space) => (
            <button
              type="button"
              key={space.id}
              className={`space-row${selectedSpace === space.id ? " is-active" : ""}`}
              onClick={() => {
                setSelectedSpace(space.id);
                setSearchHits(null);
              }}
              title={space.description}
            >
              <span className="space-row__name">{space.name}</span>
              <span className="mono">{space.count ?? stats?.spaces?.find((item) => item.id === space.id)?.count ?? "—"}</span>
            </button>
          ))}
          {spaceForm ? (
            <div className="space-form">
              <input
                className="input"
                value={spaceForm.name}
                onChange={(event) => setSpaceForm({ ...spaceForm, name: event.target.value })}
                placeholder="空间名称"
                aria-label="空间名称"
              />
              <textarea
                className="textarea"
                value={spaceForm.description}
                onChange={(event) => setSpaceForm({ ...spaceForm, description: event.target.value })}
                placeholder="描述（可选）"
                rows={2}
                aria-label="空间描述"
              />
              <div className="space-form__actions">
                <button type="button" className="btn btn-sm" onClick={() => setSpaceForm(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void createSpace()}
                  disabled={busy === "space"}
                >
                  创建
                </button>
              </div>
            </div>
          ) : null}
        </aside>

        <section className="memory-main" aria-label="记忆条目">
          <div className="memory-search">
            <span className="memory-search__input">
              <IconSearch size={13} />
              <input
                className="input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runSearch();
                }}
                placeholder="搜索记忆内容 / 标签，回车检索"
                aria-label="搜索记忆"
              />
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void runSearch()} disabled={busy === "search"}>
              {busy === "search" ? <IconLoader size={11} className="spin" /> : <IconSearch size={11} />} 搜索
            </button>
            {searchHits ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setQuery("");
                  setSearchHits(null);
                }}
              >
                <IconX size={11} /> 清除搜索
              </button>
            ) : null}
          </div>

          {showNew ? (
            <div className="entry-editor entry-editor--new">
              <textarea
                className="textarea"
                rows={3}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                placeholder="写一条长期记忆：事实 / 偏好 / 决策 / 洞察"
                aria-label="记忆内容"
                autoFocus
              />
              <div className="entry-editor__row">
                <label>
                  类型
                  <select
                    className="select"
                    value={draft.kind}
                    onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {MEMORY_KIND_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  重要度
                  <select
                    className="select"
                    value={draft.importance}
                    onChange={(event) => setDraft({ ...draft, importance: Number(event.target.value) })}
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="entry-editor__grow">
                  标签
                  <input
                    className="input"
                    value={draft.tags}
                    onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                    placeholder="逗号分隔"
                  />
                </label>
                <label>
                  空间
                  <select
                    className="select"
                    value={draft.spaceId || selectedSpace}
                    onChange={(event) => setDraft({ ...draft, spaceId: event.target.value })}
                  >
                    <option value="">默认空间</option>
                    {spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="entry-editor__actions">
                <button type="button" className="btn btn-sm" onClick={() => setShowNew(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => void createEntry()}
                  disabled={busy === "create"}
                >
                  <IconCheck size={12} /> 保存记忆
                </button>
              </div>
            </div>
          ) : null}

          {shownEntries.length === 0 ? (
            <div className="resource-empty">
              {searchHits
                ? "没有匹配的记忆。"
                : "这个空间还没有记忆。点「新建记忆」写一条，或从 DSH 导入。"}
            </div>
          ) : (
            <ul className="entry-list">
              {shownEntries.map((entry) => {
                const hit = searchHits?.find((item) => item.memory.id === entry.id);
                const editing = editingId === entry.id;
                return (
                  <li className={`entry${entry.enabled ? "" : " is-off"}`} key={entry.id}>
                    {editing ? (
                      <div className="entry-editor">
                        <textarea
                          className="textarea"
                          rows={3}
                          value={editDraft.content}
                          onChange={(event) => setEditDraft({ ...editDraft, content: event.target.value })}
                          aria-label="编辑记忆内容"
                        />
                        <div className="entry-editor__row">
                          <label>
                            类型
                            <select
                              className="select"
                              value={editDraft.kind}
                              onChange={(event) =>
                                setEditDraft({ ...editDraft, kind: event.target.value as MemoryKind })
                              }
                            >
                              {KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {MEMORY_KIND_LABEL[kind]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            重要度
                            <select
                              className="select"
                              value={editDraft.importance}
                              onChange={(event) =>
                                setEditDraft({ ...editDraft, importance: Number(event.target.value) })
                              }
                            >
                              {[1, 2, 3, 4, 5].map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="entry-editor__grow">
                            标签
                            <input
                              className="input"
                              value={editDraft.tags}
                              onChange={(event) => setEditDraft({ ...editDraft, tags: event.target.value })}
                            />
                          </label>
                          <label>
                            空间
                            <select
                              className="select"
                              value={editDraft.spaceId}
                              onChange={(event) => setEditDraft({ ...editDraft, spaceId: event.target.value })}
                            >
                              {spaces.map((space) => (
                                <option key={space.id} value={space.id}>
                                  {space.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="entry-editor__actions">
                          <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)}>
                            取消
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => void saveEdit(entry)}
                            disabled={busy === `edit:${entry.id}`}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="entry__head">
                          <span className={`tag tag-${entry.kind === "decision" ? "accent" : entry.kind === "preference" ? "warn" : "ok"}`}>
                            {MEMORY_KIND_LABEL[entry.kind]}
                          </span>
                          <span className="entry__importance mono" title={`重要度 ${entry.importance}`}>
                            {"★".repeat(Math.max(1, Math.min(5, entry.importance)))}
                          </span>
                          <span className="entry__space">{spaceName(entry.spaceId)}</span>
                          {hit ? <span className="entry__score mono">匹配 {Math.round(hit.score * 100)}%</span> : null}
                          <span className="entry__meta">
                            {entry.enabled ? "已启用" : "已停用"} · {formatRelative(entry.updatedAt)}
                            {entry.useCount ? ` · 用过 ${entry.useCount} 次` : ""}
                          </span>
                          <div className="entry__actions">
                            <PaddleSwitch
                              checked={entry.enabled}
                              onChange={() => void toggleEntry(entry)}
                              disabled={busy === `toggle:${entry.id}`}
                              ariaLabel={entry.enabled ? "停用记忆" : "启用记忆"}
                            />
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => startEdit(entry)}
                              aria-label="编辑记忆"
                              title="编辑"
                            >
                              <IconEdit size={12} />
                            </button>
                            <button
                              type="button"
                              className={`icon-btn${confirmDelete === entry.id ? " is-danger" : ""}`}
                              onClick={() => void removeEntry(entry)}
                              aria-label="删除记忆"
                              title={confirmDelete === entry.id ? "再点一次确认" : "删除"}
                            >
                              <IconTrash size={12} />
                            </button>
                          </div>
                        </div>
                        <p className="entry__content">{truncate(entry.content, 500)}</p>
                        {entry.tags.length > 0 ? (
                          <div className="entry__tags">
                            {entry.tags.map((tag) => (
                              <span className="tag" key={tag}>
                                #{tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
