/** 409「需要确认」弹窗：最高层级，一次确认只放行这一次运行（force=true）。 */
import { useEffect, useRef } from "react";
import { IconAlert, IconLoader, IconWallet, IconX } from "./Icons";

export interface ConfirmRunDialogProps {
  message: string;
  detail?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onOpenBudget?: () => void;
}

export function ConfirmRunDialog({
  message,
  detail,
  busy,
  onConfirm,
  onCancel,
  onOpenBudget,
}: ConfirmRunDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handler = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [busy, onCancel]);

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <header className="confirm-dialog__head">
          <span className="confirm-dialog__icon" aria-hidden="true">
            <IconWallet size={18} />
          </span>
          <div>
            <h2 className="confirm-dialog__title" id="confirm-title">
              需要确认本次运行
            </h2>
            <p className="confirm-dialog__sub">预算守卫检测到高成本或超出上限，确认只放行这一次。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel} disabled={busy} aria-label="取消运行">
            <IconX size={15} />
          </button>
        </header>

        <div className="confirm-dialog__body">
          <p className="confirm-dialog__message">
            <IconAlert size={13} /> {message}
          </p>
          {detail ? <pre className="confirm-dialog__detail">{detail}</pre> : null}
          <ul className="confirm-dialog__list">
            <li>确认后本次请求会带 force=true 重新提交，只影响这一次。</li>
            <li>后续运行仍会重新检查每日/单次预算，不会永久跳过。</li>
            <li>若不想花费，可先调低档位、减少参与模型，或到预算设置里开启省钱模式。</li>
          </ul>
        </div>

        <footer className="confirm-dialog__foot">
          {onOpenBudget ? (
            <button type="button" className="btn btn-ghost" onClick={onOpenBudget} disabled={busy}>
              打开预算设置
            </button>
          ) : null}
          <span className="confirm-dialog__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button ref={confirmRef} type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? <IconLoader size={13} className="spin" /> : null}
            {busy ? "正在提交…" : "确认并运行"}
          </button>
        </footer>
      </div>
    </div>
  );
}
