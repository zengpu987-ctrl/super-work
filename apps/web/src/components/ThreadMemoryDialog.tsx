import { useState } from "react";
import type { ThreadSummary } from "@super-work/core";
import { IconBrain, IconLoader, IconSave, IconX } from "./Icons";

export interface ThreadMemoryDialogProps {
  thread: ThreadSummary;
  onClose: () => void;
  onSave: (memory: string) => Promise<void>;
}

/** 单条对话的记忆编辑器：保存后会注入该对话的下一轮调用。 */
export function ThreadMemoryDialog({ thread, onClose, onSave }: ThreadMemoryDialogProps) {
  const [memory, setMemory] = useState(thread.memory ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(memory);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal thread-memory" role="dialog" aria-modal="true" aria-labelledby="thread-memory-title">
        <header className="modal__head">
          <span className="modal__title" id="thread-memory-title">
            <IconBrain size={15} /> 对话记忆
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭对话记忆">
            <IconX size={14} />
          </button>
        </header>
        <p className="thread-memory__hint">
          「{thread.title}」的长期记忆。保存后会追加到该对话下一轮的上下文，不会改动其他对话。
        </p>
        <textarea
          className="thread-memory__input"
          value={memory}
          onChange={(event) => setMemory(event.target.value)}
          placeholder="例如：用户偏好简洁结论；项目代号 MINT；已确认使用方案 B……"
          rows={9}
          autoFocus
        />
        <p className="thread-memory__meta">
          {thread.memoryUpdatedAt ? `上次保存：${new Date(thread.memoryUpdatedAt).toLocaleString()}` : "还没有保存过记忆"}
        </p>
        {error ? <p className="thread-memory__error" role="alert">{error}</p> : null}
        <footer className="modal__foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? <IconLoader size={12} className="spin" /> : <IconSave size={12} />} 保存记忆
          </button>
        </footer>
      </div>
    </div>
  );
}
