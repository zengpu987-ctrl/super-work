import { useCallback, useEffect, useMemo, useState } from "react";
import type { EffortLevel, RunMode, ThreadSummary } from "@super-work/core";
import { useWorkbench } from "./lib/useWorkbench";
import { refreshModelCatalog } from "./lib/api";
import { estimateCoordCalls, specFromModel, specKey } from "./lib/types";
import { teamCount } from "./lib/teams";
import type { ResourcePage } from "./lib/types";
import { TopBar } from "./components/TopBar";
import { Toolbar } from "./components/Toolbar";
import { HistoryRail } from "./components/HistoryRail";
import { RunCanvas } from "./components/RunCanvas";
import { EarthGlobe } from "./components/EarthGlobe";
import { ContextBar } from "./components/ContextBar";
import { TeamDrawer } from "./components/TeamDrawer";
import { Composer } from "./components/Composer";
import { RightRail, type RightTab } from "./components/RightRail";
import { OrchestrationPanel } from "./components/OrchestrationPanel";
import { ContextPanel } from "./components/ContextPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ResourceOverlay } from "./components/ResourceOverlay";
import { BillingPage } from "./components/BillingPage";
import { MemoryPage } from "./components/MemoryPage";
import { WorkflowPage } from "./components/WorkflowPage";
import { SaveRunWorkflowDialog } from "./components/SaveRunWorkflowDialog";
import { Toast } from "./components/Toast";
import { ConfirmRunDialog } from "./components/ConfirmRunDialog";
import { ThreadMemoryDialog } from "./components/ThreadMemoryDialog";
import { IconAlert } from "./components/Icons";

const sidebarDocked = (): boolean => window.matchMedia("(min-width: 820px)").matches;

export default function App() {
  const wb = useWorkbench();
  const [leftOpen, setLeftOpen] = useState(sidebarDocked);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("orchestrate");
  const [resource, setResource] = useState<ResourcePage | null>(null);
  const [saveRunOpen, setSaveRunOpen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [memoryThread, setMemoryThread] = useState<ThreadSummary | null>(null);

  const running = wb.run?.state === "running";
  const earthMode = wb.run ? "mini" : "hero";
  const coordinate = wb.mode === "coordinate";
  const chat = wb.mode === "chat";

  const coordinationSpecs = useMemo(
    () => wb.coordinationAssignments.flatMap((assignment) => assignment.participants),
    [wb.coordinationAssignments],
  );
  const composerParticipants = chat
    ? wb.chatModel
      ? [wb.chatModel]
      : []
    : coordinate
      ? coordinationSpecs
      : wb.participants;
  const roleModelCount = coordinationSpecs.length;
  const configuredRoles = wb.coordinationAssignments.length;

  const availableKeys = useMemo(
    () => new Set(wb.models.filter((model) => model.available).map((model) => specKey(specFromModel(model)))),
    [wb.models],
  );
  const memberCount = useMemo(
    () => teamCount(wb.participants, wb.coordinationAssignments),
    [wb.participants, wb.coordinationAssignments],
  );

  const unavailableCount = composerParticipants.filter(
    (spec) => spec.provider !== "mock" && !availableKeys.has(specKey(spec)),
  ).length;

  const calls = chat ? 1 : coordinate ? estimateCoordCalls(wb.coordinationAssignments) : wb.participants.length + (wb.judgeSpec ? 1 : 0);
  const chatModelLabel = useMemo(() => {
    if (!wb.chatModel) return undefined;
    const found = wb.models.find((model) => model.provider === wb.chatModel?.provider && model.id === wb.chatModel?.model);
    return found?.name ?? wb.chatModel.model;
  }, [wb.chatModel, wb.models]);
  const estimateText = chat
    ? `预计 1 次调用 · 单模型 Chat · 约 2–8 秒`
    : coordinate
      ? `预计 ${calls} 次调用 · 未配置角色不调用`
      : `预计 ${calls} 次调用 · 约 ${Math.max(2, Math.round(calls * 3))}–${Math.max(6, Math.round(calls * 9))} 秒`;

  // Esc 逐层关闭：资源页 → 抽屉（设置弹窗自己处理 Esc）
  useEffect(() => {
    if (wb.settingsOpen) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (resource) {
        setResource(null);
        return;
      }
      if (!sidebarDocked()) setLeftOpen(false);
      setRightOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [resource, wb.settingsOpen]);

  const handlePickExample = useCallback(
    (command: string) => {
      wb.setCommand(command);
      const input = document.getElementById("command-input") as HTMLTextAreaElement | null;
      input?.focus();
      input?.setSelectionRange(command.length, command.length);
    },
    [wb],
  );

  const handleDemo = useCallback(async () => {
    setDemoBusy(true);
    try {
      await wb.runDemo();
      if (!sidebarDocked()) setLeftOpen(false);
      setRightOpen(false);
    } finally {
      setDemoBusy(false);
    }
  }, [wb]);

  const handleModeChange = useCallback(
    (mode: RunMode) => {
      if (running) return;
      wb.setMode(mode);
    },
    [running, wb],
  );

  const openOrchestration = useCallback(() => {
    setRightTab("orchestrate");
    if (!sidebarDocked()) setLeftOpen(false);
    setRightOpen(true);
  }, []);

  const handleEffortChange = useCallback(
    async (participantId: string, effort: EffortLevel) => {
      await wb.changeRunEffort(participantId, effort);
    },
    [wb],
  );

  return (
    <div className="app-shell">
      <div className={`workspace${leftOpen ? " has-history" : ""}${rightOpen ? " has-inspector" : ""}`}>
        <HistoryRail
          threads={wb.threads}
          loading={wb.loading.history}
          activeThreadId={wb.run?.threadId ?? undefined}
          onSelectThread={(threadId) => {
            void wb.loadThread(threadId);
            if (!sidebarDocked()) setLeftOpen(false);
          }}
          showArchived={wb.showArchived}
          onToggleArchived={() => wb.setShowArchived(!wb.showArchived)}
          onArchive={(threadId, archived) => void wb.archiveThread(threadId, archived)}
          onDelete={(threadId) => void wb.deleteThread(threadId)}
          onOpenMemory={setMemoryThread}
          providers={wb.providers}
          onOpenSettings={(provider) => {
            wb.openSettings(provider);
            if (!sidebarDocked()) setLeftOpen(false);
          }}
          online={wb.server.online}
          version={wb.server.version}
          onRefresh={() => void wb.refreshHistory()}
          onRefreshProviders={() => void wb.refreshProviders()}
          onNew={() => {
            wb.resetRun();
            if (!sidebarDocked()) setLeftOpen(false);
            document.getElementById("command-input")?.focus();
          }}
          open={leftOpen}
        />

        <div className="workspace-main" data-earth-mode={earthMode}>
          <TopBar
            connectedProviders={wb.connectedProviderCount}
            totalProviders={wb.providers.length}
            availableModels={wb.availableModelCount}
            running={running}
            offline={wb.offline}
            runTitle={wb.run?.command ?? ""}
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            onToggleLeft={() => {
              if (!sidebarDocked()) setRightOpen(false);
              setLeftOpen((prev) => !prev);
            }}
            onToggleRight={() => {
              if (!sidebarDocked()) setLeftOpen(false);
              setRightOpen((prev) => !prev);
            }}
            onOpenSettings={() => wb.openSettings()}
            onSyncModels={async () => {
              try {
                const result = await refreshModelCatalog();
                await Promise.all([wb.refreshModels(), wb.refreshProviders()]);
                const count = result.updated.reduce((sum, item) => sum + item.count, 0);
                wb.pushToast(
                  result.errors.length > 0 ? "warn" : "success",
                  `已同步 ${result.updated.length} 个平台的模型目录`,
                  `${count} 个上游模型${result.errors.length > 0 ? `；${result.errors[0]!.provider} 拉取失败` : ""}`,
                );
              } catch (error) {
                wb.pushToast("error", "模型目录同步失败", error instanceof Error ? error.message : String(error));
              }
            }}
            activeResource={resource}
            onOpenResource={(page) => {
              setResource(page);
              if (!sidebarDocked()) setLeftOpen(false);
              setRightOpen(false);
            }}
          />

          <Toolbar
            mode={wb.mode}
            onModeChange={handleModeChange}
            running={running}
            roleCount={configuredRoles}
            roleModelCount={roleModelCount}
            parallelCount={wb.participants.length}
            onOpenRoles={openOrchestration}
            onSaveWorkflow={() => setSaveRunOpen(true)}
            canSaveWorkflow={!!wb.run && wb.run.participants.length > 0 && wb.run.state !== "running"}
            onOpenHistory={() => {
              if (!sidebarDocked()) setRightOpen(false);
              setLeftOpen(true);
            }}
            teamCount={memberCount}
            onOpenTeam={() => setTeamOpen(true)}
            chatModelLabel={chatModelLabel}
            budgetUsage={wb.budgetUsage}
            budgets={wb.budgets}
            cheapMode={wb.cheapMode}
            budgetLoading={wb.budgetLoading}
            budgetFailed={wb.budgetUsageFailed}
            onToggleCheapMode={(value) => void wb.setCheapMode(value)}
            onOpenBudget={() => wb.openSettings(null, "budget")}
          />

          {wb.offline ? (
            <div className="offline-strip" role="status">
              <span className="dot dot-err" aria-hidden="true" />
              <IconAlert size={12} />
              <span>
                <strong>本机服务未连接</strong> · 界面处于离线预览，历史与连接会在服务恢复后自动刷新。
              </span>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: "auto" }}
                onClick={() => void wb.refreshAll()}
              >
                重试连接
              </button>
            </div>
          ) : null}

          <div className="canvas-column">
            <RunCanvas
              run={wb.run}
              now={wb.now}
              offline={wb.offline}
              hasConnection={wb.hasConnection}
              demoBusy={demoBusy}
              judgeKey={wb.judgeKey}
              onStop={() => void wb.stopRun()}
              onRerun={() => void wb.rerun()}
              onBranch={() => { if (wb.run) void wb.branchThread(wb.run.id); }}
              onReSynthesize={() => void wb.resynthesize()}
              onFollowUp={() => wb.beginFollowUp()}
              onOpenSettings={() => wb.openSettings()}
              onDemo={handleDemo}
              onPickExample={handlePickExample}
              onEffortChange={handleEffortChange}
              onStopParticipant={(participantId) => void wb.stopParticipant(participantId)}
              customRoles={wb.customRoles}
              budgetUsage={wb.budgetUsage}
              onOpenBudget={() => wb.openSettings(null, "budget")}
              pastRounds={wb.pastRounds}
              onHandoffToChat={(spec) => wb.handoffToChat(spec)}
              onHandoffToTeam={() => wb.handoffToTeam("parallel")}
              onChatEffortChange={(effort) => {
                if (wb.chatModel) wb.setChatModel({ ...wb.chatModel, effort });
              }}
              chatEffort={wb.chatModel?.effort}
            />
          </div>
          <EarthGlobe mode={earthMode} suspended={Boolean(resource || wb.settingsOpen || teamOpen || saveRunOpen || wb.pendingConfirm)} />

          <div className="conversation-dock">
            <ContextBar
              run={wb.run}
              onOpenContext={() => {
                setRightTab("context");
                if (!sidebarDocked()) setLeftOpen(false);
                setRightOpen(true);
              }}
            />

            <Composer
              command={wb.command}
              onCommandChange={wb.setCommand}
              mode={wb.mode}
              participants={composerParticipants}
              judgeKey={wb.judgeKey}
              onRemoveParticipant={wb.removeParticipant}
              onOpenPicker={openOrchestration}
              onRun={() => void wb.startRun()}
              onStop={() => void wb.stopRun()}
              running={running}
              busy={wb.busy}
              offline={wb.offline}
              followUp={wb.followUp}
              onClearFollowUp={wb.clearFollowUp}
              useMemory={wb.useMemory}
              onUseMemoryChange={wb.setUseMemory}
              estimateText={estimateText}
              unavailableCount={unavailableCount}
              round={wb.run?.round ?? 1}
              chatModel={wb.chatModel}
              onChatEffortChange={(effort) => {
                if (wb.chatModel) wb.setChatModel({ ...wb.chatModel, effort });
              }}
              onClearChatModel={() => wb.setChatModel(null)}
              attachments={wb.attachments}
              attachmentBusy={wb.attachmentBusy}
              attachmentTokens={wb.attachmentTokens}
              attachmentTokenLimit={wb.budgets.perRunTokenLimit}
              expandedAttachmentId={wb.expandedAttachmentId}
              onExpandedAttachmentChange={wb.setExpandedAttachmentId}
              onAddFiles={wb.addAttachmentFiles}
              onRetryAttachment={wb.retryAttachment}
              onRemoveAttachment={wb.removeAttachment}
            />
          </div>
        </div>

        <RightRail
          onClose={() => setRightOpen(false)}
          tab={rightTab}
          onTabChange={setRightTab}
          contextCount={wb.run?.contexts.length ?? 0}
          running={running}
          open={rightOpen}
        >
          {rightTab === "orchestrate" ? (
            <OrchestrationPanel
              mode={wb.mode}
              running={running}
              models={wb.models}
              customModels={wb.customModels}
              participants={wb.participants}
              judgeKey={wb.judgeKey}
              coordination={wb.coordination}
              roleEnabled={wb.roleEnabled}
              onModeChange={handleModeChange}
              onToggleParticipant={wb.toggleParticipant}
              onRemoveParticipant={wb.removeParticipant}
              onUpdateRole={wb.updateRole}
              onUpdateParticipantEffort={wb.updateParticipantEffort}
              onSetJudge={wb.setJudgeKey}
              onToggleRoleModel={wb.toggleRoleModel}
              onUpdateRoleModelEffort={wb.updateRoleModelEffort}
              onClearRole={wb.clearRole}
              onSetRoleEnabled={wb.setRoleEnabled}
              onSetRoleParticipants={wb.setRoleParticipants}
              onOpenSettings={() => wb.openSettings()}
              customRoles={wb.customRoles}
              onCreateCustomRole={wb.createCustomRole}
              onUpdateCustomRole={wb.updateCustomRole}
              onDeleteCustomRole={wb.deleteCustomRole}
              onDuplicateCustomRole={wb.duplicateCustomRole}
              onReorderCustomRoles={wb.reorderCustomRoles}
              onMoveCustomRole={wb.moveCustomRole}
              chatModel={wb.chatModel}
              onSetChatModel={wb.setChatModel}
              onUpdateChatEffort={(effort) => wb.setChatModel(wb.chatModel ? { ...wb.chatModel, effort } : null)}
              onHandoffToTeam={wb.handoffToTeam}
            />
          ) : (
            <ContextPanel
              runId={wb.run?.id ?? null}
              runState={wb.run?.state ?? null}
              liveContexts={wb.run?.contexts ?? []}
            />
          )}
        </RightRail>
      </div>

      {leftOpen || rightOpen ? (
        <button
          type="button"
          className="drawer-backdrop"
          aria-label="关闭侧栏"
          onClick={() => {
            if (!sidebarDocked()) setLeftOpen(false);
            setRightOpen(false);
          }}
        />
      ) : null}

      <TeamDrawer
        open={teamOpen}
        onClose={() => {
          setTeamOpen(false);
          window.requestAnimationFrame(() => document.getElementById("team-entry")?.focus());
        }}
        mode={wb.mode}
        participants={wb.participants}
        coordination={wb.coordinationAssignments}
        customRoles={wb.customRoles}
        models={wb.models}
        availableKeys={availableKeys}
        judgeKey={wb.judgeKey}
        judgeSpec={wb.judgeSpec}
        run={wb.run}
        running={running}
        onOpenOrchestration={() => {
          setTeamOpen(false);
          openOrchestration();
        }}
        onRemoveParticipant={wb.removeParticipant}
        onToggleParticipant={wb.toggleParticipant}
        onToggleRoleModel={wb.toggleRoleModel}
        onStopParticipant={(participantId) => void wb.stopParticipant(participantId)}
        onChangeRunEffort={wb.changeRunEffort}
        onUpdateParticipantEffort={wb.updateParticipantEffort}
        onUpdateRoleModelEffort={wb.updateRoleModelEffort}
        onUpdateRole={wb.updateRole}
        roleEnabled={wb.roleEnabled}
        onApplyTeam={wb.applyTeamTemplate}
      />

      {resource ? (
        <ResourceOverlay page={resource} onBack={() => setResource(null)}>
          {resource === "billing" ? <BillingPage pushToast={wb.pushToast} /> : null}
          {resource === "memory" ? <MemoryPage pushToast={wb.pushToast} /> : null}
          {resource === "workflow" ? (
            <WorkflowPage models={wb.models} customModels={wb.customModels} pushToast={wb.pushToast} />
          ) : null}
        </ResourceOverlay>
      ) : null}

      {wb.settingsOpen ? (
        <SettingsModal
          providers={wb.providers}
          initialProviderId={wb.settingsProvider}
          settings={wb.settings}
          offline={wb.offline}
          initialSection={wb.settingsSection}
          budgetUsage={wb.budgetUsage}
          budgetLoading={wb.budgetLoading}
          participants={wb.participants}
          customRoles={wb.customRoles}
          onClose={wb.closeSettings}
          onRefreshProviders={wb.refreshProviders}
          onRefreshModels={wb.refreshModels}
          onRefreshBudget={wb.refreshBudget}
          onSaved={wb.saveSettings}
          pushToast={wb.pushToast}
        />
      ) : null}

      {saveRunOpen && wb.run ? (
        <SaveRunWorkflowDialog
          run={wb.run}
          onClose={() => setSaveRunOpen(false)}
          onSaved={() => setSaveRunOpen(false)}
          pushToast={wb.pushToast}
        />
      ) : null}

      {wb.pendingConfirm ? (
        <ConfirmRunDialog
          message={wb.pendingConfirm.message}
          detail={wb.pendingConfirm.detail}
          busy={wb.busy}
          onConfirm={() => void wb.confirmRun()}
          onCancel={wb.cancelConfirm}
          onOpenBudget={() => {
            wb.cancelConfirm();
            wb.openSettings(null, "budget");
          }}
        />
      ) : null}

      {memoryThread ? (
        <ThreadMemoryDialog
          thread={memoryThread}
          onClose={() => setMemoryThread(null)}
          onSave={async (memory) => {
            await wb.saveThreadMemory(memoryThread.id, memory);
          }}
        />
      ) : null}

      <Toast toasts={wb.toasts} onDismiss={wb.dismissToast} />
    </div>
  );
}
