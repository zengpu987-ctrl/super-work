import { useState } from "react";
import type { WorkflowStep } from "@super-work/core";
import { api, errorMessage } from "../lib/api";
import type { RunView } from "../lib/types";
import { truncate } from "../lib/format";
import { IconLoader, IconSave, IconX } from "./Icons";

export interface SaveRunWorkflowDialogProps {
  run: RunView;
  onClose: () => void;
  onSaved: (name: string) => void;
  pushToast: (kind: "info" | "success" | "error" | "warn", message: string, detail?: string) => void;
}

/** 把当前运行的参与者编排保存成可复用的工作流（不依赖 workflow 页面）。 */
export function SaveRunWorkflowDialog({ run, onClose, onSaved, pushToast }: SaveRunWorkflowDialogProps) {
  const [name, setName] = useState(`${truncate(run.command || "本次运行", 24)} · 工作流`);
  const [description, setDescription] = useState(
    `由 ${new Date(run.createdAt).toLocaleString("zh-CN")} 的运行保存（${run.mode === "coordinate" ? "配合" : "并行"}模式）`,
  );
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      pushToast("warn", "工作流名称不能为空");
      return;
    }
    const usedModels = run.participants.filter((participant) => !participant.id.startsWith("spec-"));
    const steps: WorkflowStep[] = usedModels.map((participant, index) => ({
      id: `s${index + 1}`,
      name: participant.role || participant.label,
      role: participant.role || undefined,
      model: {
        provider: participant.provider,
        model: participant.model,
        relayId: participant.relayId,
        effort: participant.effort,
      },
      instruction: `围绕下面的原始任务，完成「${participant.role || participant.label}」这一部分：\n\n${run.command}`,
      input: "command",
      // 同一并行组：复刻并行模式的独立作答
      parallelGroup: 1,
    }));
    if (run.judge?.provider && run.judge.model) {
      steps.push({
        id: `s${steps.length + 1}`,
        name: "裁判 / 综合",
        role: "裁判",
        model: { provider: run.judge.provider, model: run.judge.model },
        instruction: "综合前面各模型的输出，给出最终答案。",
        input: "all",
        parallelGroup: 2,
      });
    }
    if (steps.length === 0) {
      pushToast("warn", "本次运行没有可保存的参与者");
      return;
    }
    setSaving(true);
    try {
      await api.createWorkflow({ name: name.trim(), description: description.trim(), steps });
      pushToast("success", "已保存为工作流", name.trim());
      onSaved(name.trim());
      onClose();
    } catch (err) {
      pushToast("error", "保存工作流失败", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal save-workflow-modal" role="dialog" aria-modal="true" aria-labelledby="save-workflow-title">
        <header className="modal__head">
          <div className="modal__title-group">
            <h2 className="modal__title" id="save-workflow-title">
              <IconSave size={15} /> 把本次运行保存为工作流
            </h2>
            <p className="modal__subtitle">
              {run.participants.length} 个参与者 · {run.mode === "coordinate" ? "配合模式" : "并行模式"} · 未配置的角色不会被保存
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={15} />
          </button>
        </header>
        <div className="modal__body save-workflow-body">
          <label className="field-row">
            <span>名称</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="field-row">
            <span>描述</span>
            <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="save-workflow-steps">
            {run.participants.map((participant) => (
              <div className="save-workflow-step" key={participant.id}>
                <span className="tag">{participant.provider}</span>
                <b>{participant.label}</b>
                <span>{participant.role}</span>
              </div>
            ))}
          </div>
          <p className="save-workflow-hint">
            保存后可在「资源 → 工作流」里编辑每一步的模型、指令、输入来源与并行组，并直接运行。
          </p>
        </div>
        <footer className="modal__foot">
          <div className="modal__foot-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <IconLoader size={13} className="spin" /> : <IconSave size={13} />} 保存工作流
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
