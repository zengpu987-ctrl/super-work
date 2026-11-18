import type { ToastItem } from "../lib/types";
import { IconAlert, IconCheck, IconInfo, IconX } from "./Icons";

export interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}

const ICONS = {
  info: IconInfo,
  success: IconCheck,
  error: IconAlert,
  warn: IconAlert,
} as const;

export function Toast({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;
  return (
    <ol className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <li key={toast.id} className={`toast toast--${toast.kind}`} role="status">
            <span className="toast__icon" aria-hidden="true">
              <Icon size={15} />
            </span>
            <div className="toast__body">
              <div className="toast__message">{toast.message}</div>
              {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
            </div>
            <button
              type="button"
              className="toast__close"
              onClick={() => onDismiss(toast.id)}
              aria-label="关闭提示"
            >
              <IconX size={12} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
