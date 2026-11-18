import { useState } from "react";
import { EXAMPLE_COMMANDS } from "../lib/types";
import { IconPlay, IconSettings, IconX } from "./Icons";

export interface EmptyStateProps {
  onPickExample: (command: string) => void;
  onDemo: () => void;
  onOpenSettings: () => void;
  demoBusy: boolean;
  hasConnection: boolean;
  offline: boolean;
}

const GUIDE_KEY = "superwork.guideDismissed.v2";

function guideDismissed(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function EmptyState({
  onPickExample,
  onDemo,
  onOpenSettings,
  demoBusy,
  hasConnection,
  offline,
}: EmptyStateProps) {
  const [dismissed, setDismissed] = useState(guideDismissed);

  const closeGuide = (): void => {
    setDismissed(true);
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      /* 忽略隐私模式 */
    }
  };

  return (
    <div className="canvas-empty">
      <header className="welcome">
        <div className="earth-hero-slot" data-earth-slot="hero" />
        <div className="welcome__copy">
          <h1>今天想做什么？</h1>
          <div className="welcome__actions">
            <button type="button" className="btn" onClick={onDemo} disabled={demoBusy}>
              <IconPlay size={12} /> {demoBusy ? "启动中…" : "演示试跑"}
            </button>
            {!hasConnection ? (
              <button type="button" className="btn" onClick={onOpenSettings}>
                <IconSettings size={12} /> 连接真实模型
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {!dismissed ? (
        <details className="start-card" aria-label="首次使用引导">
          <summary>第一次用？三步上手</summary>
          <div className="start-card__head">
            <div className="start-card__titles">
              <p>选一个模型开始聊，或让多个模型一起完成任务。</p>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={closeGuide}
              aria-label="关闭首次使用引导"
              title="关闭引导"
            >
              <IconX size={13} />
            </button>
          </div>
          <ol className="start-steps">
            <li>
              <b>01</b>
              <span>连接模型</span>
              <em>API Key、订阅登录或复用本机凭证；没有 key 也能用演示模型。</em>
            </li>
            <li>
              <b>02</b>
              <span>选模式</span>
              <em>Chat 与一个模型对话；并行让多个模型独立作答；配合按角色分工。</em>
            </li>
            <li>
              <b>03</b>
              <span>发命令</span>
              <em>在底部命令台写任务，⌘/Ctrl + Enter 运行。</em>
            </li>
          </ol>
          <div className="start-card__actions">
            <button type="button" className="btn" onClick={onOpenSettings}>
              <IconSettings size={12} />
              {hasConnection ? "管理模型连接" : "连接真实模型"}
            </button>
            <span className="start-card__hint">
              {offline ? "当前处于离线预览，服务恢复后可运行真实模型。" : "所有凭证只保存在本机。"}
            </span>
          </div>
        </details>
      ) : null}

      <section className="empty-examples" aria-label="示例命令">
        <div className="empty-examples__head">
          <span>示例命令</span>
          <span className="empty-examples__hint">点击填入命令台，可先改再发</span>
        </div>
        <div className="empty-examples__grid">
          {EXAMPLE_COMMANDS.slice(0, 4).map((example) => (
            <button
              type="button"
              key={example.title}
              className="example-row"
              onClick={() => onPickExample(example.command)}
              aria-label={`示例：${example.title}，填入命令台`}
            >
              <span className="example-row__tag">{example.tag}</span>
              <span className="example-row__body">
                <span className="example-row__title">{example.title}</span>
                <span className="example-row__hint">{example.command}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
