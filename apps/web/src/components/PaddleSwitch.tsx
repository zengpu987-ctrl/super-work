import type { MouseEvent as ReactMouseEvent } from "react";

export interface PaddleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** sm = 表格/行内，md = 设置面板 */
  size?: "sm" | "md";
  disabled?: boolean;
  ariaLabel: string;
  title?: string;
  className?: string;
}

export function PaddleSwitch({
  checked,
  onChange,
  size = "md",
  disabled,
  ariaLabel,
  title,
  className,
}: PaddleSwitchProps) {
  const toggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onChange(!checked);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      disabled={disabled}
      className={`paddle paddle--${size}${className ? ` ${className}` : ""}`}
      onClick={toggle}
    >
      <span className="paddle__rail" aria-hidden="true">
        <span className="paddle__lever" />
      </span>
    </button>
  );
}
