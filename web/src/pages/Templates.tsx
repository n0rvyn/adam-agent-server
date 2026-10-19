import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
import { FileCode, Plus, Play, Trash2, RefreshCw, Pencil, ChevronDown, ChevronRight, ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { Switch } from "@/components/ui/Switch.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/AlertDialog.tsx";
import { NotifyTargetSelector } from "@/components/ui/NotifyTargetSelector.tsx";
import { TemplateVersionHistory } from "@/components/TemplateVersionHistory.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { timeAgo } from "@/lib/format.ts";
import { api, postExecutionFeedback } from "@/lib/api.ts";
import type { NotifyTarget, DeliveryConfig, TaskConfig } from "@/lib/types.ts";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import type { TaskStep, AuditViolation } from "@/lib/types.ts";
import { StepContractBadges } from "@/components/StepContractBadges.tsx";

interface EditableStep {
  id: string;
  prompt: string;
  roleId?: string;
  dependsOn?: string[];
  config?: { timeout?: number; maxTurns?: number };
  consumesFrom?: string[];
  consumesFromOptional?: string[];
  persona?: TaskStep["persona"];
  outputContract?: TaskStep["outputContract"];
  outputAs?: string;
}

interface ExecutionStepTask {
  id: string;
  status: string;
  roleId?: string;
  stepId?: string;
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

interface StepStatus {
  taskId: string;
  status: string;
  roleId?: string;
  result?: string;
  error?: string;
  contractRetried?: boolean;
  contract?: {
    layerAPassed: boolean;
    layerBPassed: boolean | null;
    layerCPassed: boolean | null;
    violations: AuditViolation[];
  };
}

interface TemplateExecution {
  id: string;
  templateId: string;
  status: string;
  stepStatuses: Record<string, StepStatus>;
  startedAt: number;
  completedAt?: number;
  stepTasks: ExecutionStepTask[];
}

function makeStepId(index: number): string {
  return `step-${index + 1}`;
}

type DeliveryMode = "concat-step-results" | "primary-artifact" | "custom";

function buildDeliveryConfig(
  mode: DeliveryMode,
  stepId: string,
  key: string,
): DeliveryConfig | undefined {
  if (mode === "concat-step-results" || !mode) return undefined;
  if (mode === "primary-artifact") {
    if (!stepId) return undefined;
    // key is optional — if provided, use it as explicit override; otherwise leave undefined
    // and the server will derive it from step.outputAs at delivery time.
    return { mode: "primary-artifact", primaryArtifact: { stepId, ...(key ? { key } : {}) } };
  }
  // "custom" disabled in UI; defensive ignore
  return undefined;
}

function mergeConfig(
  existing: Partial<TaskConfig> | undefined,
  additions: Partial<TaskConfig>,
): Partial<TaskConfig> {
  return { ...(existing ?? {}), ...additions };
}

export function Templates() {
  type TriggerType = "manual" | "cron" | "once" | "template_complete" | "event";

  const templates = useAppStore((s) => s.templates);
  const fetchTemplates = useAppStore((s) => s.fetchTemplates);
  const goals = useAppStore((s) => s.goals);
  const fetchGoals = useAppStore((s) => s.fetchGoals);
  const roles = useAppStore((s) => s.roles);
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("manual");
  const [targetTemplateId, setTargetTemplateId] = useState<string>("");
  const [cron, setCron] = useState("");
  const [runAt, setRunAt] = useState("");
  // Multi-step state for create
  const [steps, setSteps] = useState<EditableStep[]>([{ id: "step-1", prompt: "" }]);
  const [continueOnError, setContinueOnError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runConfirmId, setRunConfirmId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteDependents, setDeleteDependents] = useState<{ executionCount: number; taskCount: number } | null>(null);
  const [deleteMode, setDeleteMode] = useState<"template_only" | "with_tasks">("template_only");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTriggerType, setEditTriggerType] = useState<TriggerType>("manual");
  const [editCron, setEditCron] = useState("");
  const [editRunAt, setEditRunAt] = useState("");
  const [editTargetTemplateId, setEditTargetTemplateId] = useState<string>("");
  // Event trigger state
  const [eventDefId, setEventDefId] = useState<string>("");
  const [editEventDefId, setEditEventDefId] = useState<string>("");
  const [eventDefs, setEventDefs] = useState<Array<{ id: string; name: string }>>([]);
  // Multi-step state for edit
  const [editSteps, setEditSteps] = useState<EditableStep[]>([]);
  const [editContinueOnError, setEditContinueOnError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedGoalIds, setSelectedGoalIds] = useState<string[]>([]);
  const [deliverTo, setDeliverTo] = useState<NotifyTarget[]>([]);
  const [editDeliverTo, setEditDeliverTo] = useState<NotifyTarget[]>([]);
  // Delivery section state
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("concat-step-results");
  const [primaryStepId, setPrimaryStepId] = useState<string>("");
  const [primaryArtifactKey, setPrimaryArtifactKey] = useState<string>("");
  // Resolved outputAs for the selected step (read-only, shown when user picks a step)
  const [primaryStepOutputAs, setPrimaryStepOutputAs] = useState<string>("");
  const [editDeliveryMode, setEditDeliveryMode] = useState<DeliveryMode>("concat-step-results");
  const [editPrimaryStepId, setEditPrimaryStepId] = useState<string>("");
  const [editPrimaryArtifactKey, setEditPrimaryArtifactKey] = useState<string>("");
  const [editPrimaryStepOutputAs, setEditPrimaryStepOutputAs] = useState<string>("");
  // TemplateExecution detail panel
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<TemplateExecution[]>([]);
  const [loadingExecs, setLoadingExecs] = useState(false);
  // Track per-execution feedback: executionId → "good" | "bad" | "pending"
  const [feedbackState, setFeedbackState] = useState<Record<string, "good" | "bad" | "pending">>({});

  const fetchExecutions = useCallback(async (templateId: string) => {
    setLoadingExecs(true);
    try {
      const res = await api<{ executions: Array<Omit<TemplateExecution, "stepTasks">> }>(`/template-executions?templateId=${templateId}&limit=5`);
      const detailedExecutions = await Promise.all(
        res.executions.map(async (execution) => {
          try {
            const detail = await api<{ execution: Omit<TemplateExecution, "stepTasks">; stepTasks: ExecutionStepTask[] }>(`/template-executions/${execution.id}`);
            return { ...detail.execution, stepTasks: detail.stepTasks };
          } catch {
            return { ...execution, stepTasks: [] };
          }
        }),
      );
      setExecutions(detailedExecutions);
    } catch {
      setExecutions([]);
    } finally {
      setLoadingExecs(false);
    }
  }, []);

  const handleFeedback = useCallback(async (executionId: string, rating: "good" | "bad") => {
    setFeedbackState((prev) => ({ ...prev, [executionId]: "pending" }));
    try {
      await postExecutionFeedback(executionId, rating);
      setFeedbackState((prev) => ({ ...prev, [executionId]: rating }));
    } catch {
      setFeedbackState((prev) => { const next = { ...prev }; delete next[executionId]; return next; });
      toast.error("Failed to record feedback");
    }
  }, []);

  const toggleExpand = useCallback((templateId: string) => {
    if (expandedTemplateId === templateId) {
      setExpandedTemplateId(null);
      setExecutions([]);
    } else {
      setExpandedTemplateId(templateId);
      void fetchExecutions(templateId);
    }
  }, [expandedTemplateId, fetchExecutions]);

  const templateIdToName = useMemo(
    () => Object.fromEntries(templates.map((t) => [t.id, t.name])),
    [templates],
  );

  const formatTriggerSummary = (trigger: { type: string; cron?: string; runAt?: string; event?: string; eventDefId?: string }): string => {
    if (trigger.type === "cron") return `Cron: ${trigger.cron ?? "—"}`;
    if (trigger.type === "once") return `Once at ${trigger.runAt ? new Date(trigger.runAt).toLocaleString() : "—"}`;
    if (trigger.type === "template_complete") {
      const targetId = trigger.event?.split(":")[1] ?? "";
      const targetName = templateIdToName[targetId] ?? "[deleted template]";
      return `When template '${targetName}' completes`;
    }
    if (trigger.type === "event") {
      const eventDefName = eventDefs.find((e) => e.id === trigger.eventDefId)?.name ?? "[deleted event]";
      return `On event '${eventDefName}'`;
    }
    return trigger.type;
  };

  useEffect(() => {
    void fetchTemplates();
    void fetchGoals();
    void fetchRoles();
    void (async () => {
      try {
        const data = await api<Array<{ id: string; name: string }>>("/event-defs");
        setEventDefs(data);
      } catch {
        // event-defs endpoint may not exist yet
      }
    })();
  }, [fetchTemplates, fetchGoals, fetchRoles]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    if (steps.every((s) => !s.prompt.trim())) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        trigger: {
          type: triggerType,
          ...(triggerType === "cron" && cron ? { cron } : {}),
          ...(triggerType === "once" && runAt ? { runAt: new Date(runAt).toISOString() } : {}),
          ...(triggerType === "template_complete" && targetTemplateId ? { event: `template_complete:${targetTemplateId}` } : {}),
          ...(triggerType === "event" && eventDefId ? { eventDefId } : {}),
        },
        enabled: true,
        ...(deliverTo.length > 0 ? { deliverTo } : {}),
        ...(() => {
          const newConfig = mergeConfig(undefined, {
            ...(continueOnError ? { continueOnError: true } : {}),
            ...(buildDeliveryConfig(deliveryMode, primaryStepId, primaryArtifactKey)
              ? { delivery: buildDeliveryConfig(deliveryMode, primaryStepId, primaryArtifactKey)! }
              : {}),
          });
          return Object.keys(newConfig).length > 0 ? { config: newConfig } : {};
        })(),
      };
      body.steps = steps
        .filter((s) => s.prompt.trim())
        .map((s, i) => ({
          id: s.id || makeStepId(i),
          prompt: s.prompt.trim(),
          ...(s.roleId ? { roleId: s.roleId } : {}),
          ...(s.dependsOn && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
          ...(s.config && (s.config.timeout !== undefined || s.config.maxTurns !== undefined) ? { config: s.config } : {}),
          ...(s.consumesFrom?.length ? { consumesFrom: s.consumesFrom } : {}),
          ...(s.consumesFromOptional?.length ? { consumesFromOptional: s.consumesFromOptional } : {}),
          ...(s.persona ? { persona: s.persona } : {}),
          ...(s.outputContract ? { outputContract: s.outputContract } : {}),
        }));
      if (selectedGoalIds.length > 0) {
        body.goalIds = selectedGoalIds;
      }
      await api("/task-templates", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setName("");
      setSteps([{ id: "step-1", prompt: "" }]);
      setCron("");
      setRunAt("");
      setTargetTemplateId("");
      setEventDefId("");
      setSelectedGoalIds([]);
      setDeliverTo([]);
      setDeliveryMode("concat-step-results");
      setPrimaryStepId("");
      setPrimaryArtifactKey("");
      setPrimaryStepOutputAs("");
      setShowCreate(false);
      void fetchTemplates();
    } finally {
      setCreating(false);
    }
  };

  const handleRun = async (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    setRunningId(templateId);
    try {
      await api(`/task-templates/${templateId}/run`, { method: "POST" });
      toast.success(`Triggered: ${template?.name ?? templateId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to trigger template";
      toast.error(`Trigger failed: ${message}`);
    } finally {
      setRunningId(null);
    }
  };

  const openDeleteDialog = async (templateId: string) => {
    setDeleteConfirmId(templateId);
    setDeleteMode("template_only");
    setDeleteDependents(null);
    try {
      const res = await api<{ dependents: { executionCount: number; taskCount: number } }>(
        `/task-templates/${templateId}/dependents`,
      );
      setDeleteDependents(res.dependents);
    } catch {
      setDeleteDependents({ executionCount: 0, taskCount: 0 });
    }
  };

  const handleDelete = async (templateId: string, mode: "template_only" | "with_tasks") => {
    const template = templates.find((t) => t.id === templateId);
    setDeleteLoading(true);
    try {
      const res = await api<{ deleted: boolean; mode: string; deletedCounts: { template: number; templateExecutions: number; tasks: number } }>(
        `/task-templates/${templateId}?mode=${mode}`,
        { method: "DELETE" },
      );
      const parts: string[] = [];
      if (res.deletedCounts.templateExecutions > 0) {
        parts.push(`${res.deletedCounts.templateExecutions} template execution${res.deletedCounts.templateExecutions === 1 ? "" : "s"}`);
      }
      if (res.deletedCounts.tasks > 0) {
        parts.push(`${res.deletedCounts.tasks} task${res.deletedCounts.tasks === 1 ? "" : "s"}`);
      }
      const suffix = parts.length ? ` (+ ${parts.join(", ")})` : "";
      toast.success(`Deleted: ${template?.name ?? templateId}${suffix}`);
      void fetchTemplates();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete template";
      toast.error(`Delete failed: ${message}`);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleToggle = async (templateId: string) => {
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    const toggleable = ["cron", "once", "template_complete"] as const;
    if (!toggleable.includes(template.trigger.type as typeof toggleable[number])) {
      toast.error("Toggle not applicable for manual triggers");
      return;
    }
    const newEnabled = !template.enabled;
    try {
      await api(`/task-templates/${templateId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: newEnabled }),
      });
      toast.success(`${template.name} ${newEnabled ? "enabled" : "disabled"}`);
      void fetchTemplates();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to toggle template";
      toast.error(`Toggle failed: ${message}`);
    }
  };

  const startEdit = (t: typeof templates[0]) => {
    setEditId(t.id);
    setEditName(t.name);
    setEditTriggerType(t.trigger.type);
    setEditCron(t.trigger.cron ?? "");
    setEditRunAt(t.trigger.runAt ? new Date(t.trigger.runAt).toISOString().slice(0, 16) : "");
    setEditSteps(t.steps.map((s) => ({ id: s.id, prompt: s.prompt, roleId: s.roleId, dependsOn: s.dependsOn, config: s.config, consumesFrom: s.consumesFrom, consumesFromOptional: s.consumesFromOptional, persona: s.persona, outputContract: s.outputContract, outputAs: s.outputAs })));
    setEditContinueOnError(t.config?.continueOnError ?? false);
    setEditDeliveryMode((t.config?.delivery?.mode as DeliveryMode) ?? "concat-step-results");
    setEditPrimaryStepId(t.config?.delivery?.primaryArtifact?.stepId ?? "");
    setEditPrimaryArtifactKey(t.config?.delivery?.primaryArtifact?.key ?? "");
    setEditPrimaryStepOutputAs(
      t.config?.delivery?.primaryArtifact?.stepId
        ? (t.steps.find((s) => s.id === t.config?.delivery?.primaryArtifact?.stepId)?.outputAs ?? "")
        : "",
    );
    setEditDeliverTo(t.deliverTo ?? []);
    setEditTargetTemplateId(
      t.trigger.type === "template_complete"
        ? t.trigger.event?.split(":")[1] ?? ""
        : "",
    );
    setEditEventDefId((t.trigger as { eventDefId?: string }).eventDefId ?? "");
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim() || editSteps.every((s) => !s.prompt.trim())) return;
    setSaving(true);
    try {
      await api(`/task-templates/${editId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          trigger: {
            type: editTriggerType,
            ...(editTriggerType === "cron" && editCron ? { cron: editCron } : {}),
            ...(editTriggerType === "once" && editRunAt ? { runAt: new Date(editRunAt).toISOString() } : {}),
            ...(editTriggerType === "template_complete" && editTargetTemplateId ? { event: `template_complete:${editTargetTemplateId}` } : {}),
            ...(editTriggerType === "event" && editEventDefId ? { eventDefId: editEventDefId } : {}),
          },
          steps: editSteps
            .filter((s) => s.prompt.trim())
            .map((s, i) => ({
              id: s.id || makeStepId(i),
              prompt: s.prompt.trim(),
              ...(s.roleId ? { roleId: s.roleId } : {}),
              ...(s.dependsOn && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
              ...(s.config && (s.config.timeout !== undefined || s.config.maxTurns !== undefined) ? { config: s.config } : {}),
              ...(s.consumesFrom?.length ? { consumesFrom: s.consumesFrom } : {}),
              ...(s.consumesFromOptional?.length ? { consumesFromOptional: s.consumesFromOptional } : {}),
              ...(s.persona ? { persona: s.persona } : {}),
              ...(s.outputContract ? { outputContract: s.outputContract } : {}),
            })),
          enabled: templates.find((t) => t.id === editId)?.enabled ?? true,
          ...(() => {
            const t = templates.find((t) => t.id === editId);
            const existingConfig = t?.config;
            const newConfig = mergeConfig(existingConfig, {
              ...(editContinueOnError ? { continueOnError: true } : { continueOnError: false }),
              ...(buildDeliveryConfig(editDeliveryMode, editPrimaryStepId, editPrimaryArtifactKey)
                ? { delivery: buildDeliveryConfig(editDeliveryMode, editPrimaryStepId, editPrimaryArtifactKey)! }
                : { delivery: undefined }),
            });
            return { config: newConfig };
          })(),
          deliverTo: editDeliverTo.length > 0 ? editDeliverTo : undefined,
        }),
      });
      setEditId(null);
      void fetchTemplates();
      toast.success("Template updated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update template";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const runConfirmTemplate = templates.find((t) => t.id === runConfirmId);
  const deleteConfirmTemplate = templates.find((t) => t.id === deleteConfirmId);
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Automations"
        description="Reusable templates, manual triggers, and recent template executions."
        compact
        action={
          <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void fetchTemplates()}>
            <RefreshCw size={14} />
          </Button>
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} />
            New Automation
          </Button>
          </div>
        }
      />

      {showCreate && (
        <Card className="space-y-3">
          <input
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex gap-2">
            <span className="text-xs text-[var(--app-text-muted)]">Triggered by:</span>
            <select
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value as TriggerType)}
            >
              <option value="manual">Manual</option>
              <option value="cron">Schedule (Cron)</option>
              <option value="once">One-time</option>
              <option value="template_complete">Template completion</option>
              <option value="event">Event (definition)</option>
            </select>
            {triggerType === "template_complete" && (
              <select
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={targetTemplateId}
                onChange={(e) => setTargetTemplateId(e.target.value)}
              >
                <option value="">-- Select target template --</option>
                {templates
                  .filter((t) => t.id !== editId)
                  .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {triggerType === "event" && (
              <select
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={eventDefId}
                onChange={(e) => setEventDefId(e.target.value)}
              >
                <option value="">-- Select event --</option>
                {eventDefs.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}
            {triggerType === "cron" && (
              <input
                className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                placeholder="Cron expression (e.g. */5 * * * *)"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
              />
            )}
            {triggerType === "once" && (
              <input
                type="datetime-local"
                className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--app-text-muted)]">Steps</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSteps([...steps, { id: makeStepId(steps.length), prompt: "" }])}
              >
                <Plus size={12} /> Add Step
              </Button>
            </div>
            {steps.map((step, idx) => (
              <div key={step.id} className="rounded-md border border-[var(--app-border)] p-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-[var(--app-text-subtle)]">{step.id}</span>
                  <select
                    className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-xs text-[var(--app-text)]"
                    value={step.roleId ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      updated[idx] = { ...step, roleId: e.target.value || undefined };
                      setSteps(updated);
                    }}
                  >
                    <option value="">Role (template default)</option>
                    {roles.filter((r) => r.source !== "system").map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSteps(steps.filter((_, i) => i !== idx))}
                      className="text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <textarea
                  className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                  placeholder={`Step ${idx + 1} prompt${idx > 0 ? " (use {{" + steps[idx - 1].id + ".result}} for prev output)" : ""}`}
                  rows={2}
                  value={step.prompt}
                  onChange={(e) => {
                    const updated = [...steps];
                    updated[idx] = { ...step, prompt: e.target.value };
                    setSteps(updated);
                  }}
                />
                {idx > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-[var(--app-text-subtle)]">depends on:</span>
                    {steps.slice(0, idx).map((prev) => (
                      <button
                        key={prev.id}
                        type="button"
                        onClick={() => {
                          const deps = step.dependsOn ?? [];
                          const updated = [...steps];
                          updated[idx] = {
                            ...step,
                            dependsOn: deps.includes(prev.id)
                              ? deps.filter((d) => d !== prev.id)
                              : [...deps, prev.id],
                          };
                          setSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.dependsOn ?? []).includes(prev.id)
                            ? "bg-[var(--app-accent)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
                    timeout(s):
                    <input
                      type="number"
                      min={0}
                      placeholder="default"
                      className="w-20 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                      value={step.config?.timeout ?? ""}
                      onChange={(e) => {
                        const updated = [...steps];
                        const val = e.target.value === "" ? undefined : Number(e.target.value);
                        updated[idx] = { ...step, config: { ...step.config, timeout: val } };
                        setSteps(updated);
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
                    max turns:
                    <input
                      type="number"
                      min={0}
                      placeholder="default"
                      className="w-20 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                      value={step.config?.maxTurns ?? ""}
                      onChange={(e) => {
                        const updated = [...steps];
                        const val = e.target.value === "" ? undefined : Number(e.target.value);
                        updated[idx] = { ...step, config: { ...step.config, maxTurns: val } };
                        setSteps(updated);
                      }}
                    />
                  </label>
                </div>
                {/* consumesFrom / consumesFromOptional */}
                {idx > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Consumes:</span>
                    {steps.slice(0, idx).map((prev) => (
                      <button
                        key={prev.id}
                        type="button"
                        aria-label={`consumes ${prev.id}`}
                        onClick={() => {
                          const cf = step.consumesFrom ?? [];
                          const updated = [...steps];
                          updated[idx] = {
                            ...step,
                            consumesFrom: cf.includes(prev.id)
                              ? cf.filter((d) => d !== prev.id)
                              : [...cf, prev.id],
                          };
                          setSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.consumesFrom ?? []).includes(prev.id)
                            ? "bg-[var(--app-danger)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}
                      </button>
                    ))}
                    <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0 ml-1">(opt)</span>
                    {steps.slice(0, idx).map((prev) => (
                      <button
                        key={`${prev.id}-opt`}
                        type="button"
                        aria-label={`optional-consumes ${prev.id}`}
                        onClick={() => {
                          const cfo = step.consumesFromOptional ?? [];
                          const updated = [...steps];
                          updated[idx] = {
                            ...step,
                            consumesFromOptional: cfo.includes(prev.id)
                              ? cfo.filter((d) => d !== prev.id)
                              : [...cfo, prev.id],
                          };
                          setSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.consumesFromOptional ?? []).includes(prev.id)
                            ? "bg-[var(--app-accent)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}?
                      </button>
                    ))}
                  </div>
                )}
                {/* Persona fields */}
                <div className="flex gap-1 items-center">
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Speak as:</span>
                  <input
                    type="text"
                    placeholder="e.g. 卞旸"
                    className="flex-1 min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)]"
                    value={step.persona?.speakAs ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      updated[idx] = {
                        ...step,
                        persona: e.target.value ? { speakAs: e.target.value, voiceConstraints: step.persona?.voiceConstraints } : undefined,
                      };
                      setSteps(updated);
                    }}
                  />
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Voice:</span>
                  <input
                    type="text"
                    placeholder="optional"
                    className="flex-1 min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)]"
                    value={step.persona?.voiceConstraints ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      updated[idx] = {
                        ...step,
                        persona: step.persona?.speakAs
                          ? { speakAs: step.persona.speakAs, voiceConstraints: e.target.value || undefined }
                          : undefined,
                      };
                      setSteps(updated);
                    }}
                  />
                </div>
                {/* Output contract fields */}
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Contract:</span>
                  <input
                    type="number" min={0} placeholder="min"
                    className="w-16 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.min ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      const min = e.target.value === "" ? undefined : Number(e.target.value);
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: min ?? 0, max: step.outputContract?.lengthTarget?.max ?? 0, unit: step.outputContract?.lengthTarget?.unit ?? "characters" },
                        },
                      };
                      setSteps(updated);
                    }}
                  />
                  <span className="text-[10px] text-[var(--app-text-subtle)]">—</span>
                  <input
                    type="number" min={0} placeholder="max"
                    className="w-16 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.max ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      const max = e.target.value === "" ? undefined : Number(e.target.value);
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: step.outputContract?.lengthTarget?.min ?? 0, max: max ?? 0, unit: step.outputContract?.lengthTarget?.unit ?? "characters" },
                        },
                      };
                      setSteps(updated);
                    }}
                  />
                  <select
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.unit ?? "characters"}
                    onChange={(e) => {
                      const updated = [...steps];
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: step.outputContract?.lengthTarget?.min ?? 0, max: step.outputContract?.lengthTarget?.max ?? 0, unit: e.target.value as "characters" | "words" | "bytes" },
                        },
                      };
                      setSteps(updated);
                    }}
                  >
                    <option value="characters">chars</option>
                    <option value="words">words</option>
                    <option value="bytes">bytes</option>
                  </select>
                  <select
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.format ?? ""}
                    onChange={(e) => {
                      const updated = [...steps];
                      const val = e.target.value as "markdown" | "text" | "json" | "";
                      updated[idx] = {
                        ...step,
                        outputContract: { ...step.outputContract, format: val || undefined },
                      };
                      setSteps(updated);
                    }}
                  >
                    <option value="">fmt?</option>
                    <option value="markdown">md</option>
                    <option value="text">txt</option>
                    <option value="json">json</option>
                  </select>
                  <label className="flex items-center gap-0.5 text-[10px] text-[var(--app-text-subtle)] cursor-pointer">
                    <input type="checkbox" className="accent-[var(--app-accent)]"
                      checked={step.outputContract?.mustReferenceArtifacts ?? false}
                      onChange={(e) => {
                        const updated = [...steps];
                        updated[idx] = {
                          ...step,
                          outputContract: { ...step.outputContract, mustReferenceArtifacts: e.target.checked },
                        };
                        setSteps(updated);
                      }}
                    />
                    ref artifacts
                  </label>
                </div>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <span className="text-xs text-[var(--app-text-muted)]">Goals</span>
            {goals.length === 0 ? (
              <p className="text-xs text-[var(--app-text-subtle)]">No goals available</p>
            ) : (
              goals.map((goal) => (
                <label key={goal.id} className="flex items-center gap-2 text-xs text-[var(--app-text)] hover:text-[var(--app-text)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedGoalIds.includes(goal.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedGoalIds([...selectedGoalIds, goal.id]);
                      } else {
                        setSelectedGoalIds(selectedGoalIds.filter((id) => id !== goal.id));
                      }
                    }}
                    className="rounded border-[var(--app-border-strong)] bg-[var(--app-panel-elevated)]"
                  />
                  <span className="truncate">{goal.name}</span>
                  <Badge variant="muted" className="text-[10px]">{goal.status}</Badge>
                </label>
              ))
            )}
          </div>
          {steps.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-[var(--app-text)] cursor-pointer">
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
                className="rounded border-[var(--app-border-strong)] bg-[var(--app-panel-elevated)]"
              />
              Continue on error (skip failed step dependents, run independent steps)
            </label>
          )}
          {/* Delivery format section */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--app-text)]">投递格式</label>
            <select
              value={deliveryMode}
              onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
              className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            >
              <option value="concat-step-results">拼接每步结果（默认）</option>
              <option value="primary-artifact">指定主产物</option>
              <option value="custom" disabled>自定义（即将推出）</option>
            </select>
            {deliveryMode === "primary-artifact" && (
              <div className="space-y-2 rounded border border-[var(--app-border)] p-2">
                <div>
                  <label className="text-xs text-[var(--app-text-muted)]">来源 step</label>
                  <select
                    value={primaryStepId}
                    onChange={(e) => {
                      const selectedStep = steps.find((s) => s.id === e.target.value);
                      setPrimaryStepId(e.target.value);
                      setPrimaryStepOutputAs(selectedStep?.outputAs ?? "");
                    }}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                  >
                    <option value="">选择 step...</option>
                    {steps.filter(s => s.prompt.trim()).map((s) => (
                      <option key={s.id} value={s.id}>{s.id}</option>
                    ))}
                  </select>
                </div>
                {primaryStepOutputAs && (
                  <div className="text-xs text-[var(--app-accent)]">
                    Will use step&apos;s output: <span className="font-mono">{primaryStepOutputAs}</span>
                  </div>
                )}
                <div>
                  <label className="text-xs text-[var(--app-text-muted)]">
                    {primaryStepOutputAs ? "Or specify custom key:" : "artifact key"}
                  </label>
                  <input
                    type="text"
                    value={primaryArtifactKey}
                    onChange={(e) => setPrimaryArtifactKey(e.target.value)}
                    placeholder={primaryStepOutputAs ? "留空使用上面的自动解析值" : "手动输入 key"}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus:border-[var(--app-accent)] focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>
          <NotifyTargetSelector value={deliverTo} onChange={setDeliverTo} />
          <div className="flex gap-2">
            <Button
              onClick={() => void handleCreate()}
              disabled={
                creating ||
                !name.trim() ||
                steps.every((s) => !s.prompt.trim()) ||
                (triggerType === "template_complete" && !targetTemplateId)
              }
            >
              {creating ? "Creating..." : "Create"}
            </Button>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {editId !== null && (
        <Card className="space-y-3">
          <span className="text-sm font-medium text-[var(--app-text)]">Edit Automation</span>
          <input
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Template name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <div className="flex gap-2">
            <span className="text-xs text-[var(--app-text-muted)]">Triggered by:</span>
            <select
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={editTriggerType}
              onChange={(e) => setEditTriggerType(e.target.value as TriggerType)}
            >
              <option value="manual">Manual</option>
              <option value="cron">Schedule (Cron)</option>
              <option value="once">One-time</option>
              <option value="template_complete">Template completion</option>
              <option value="event">Event (definition)</option>
            </select>
            {editTriggerType === "template_complete" && (
              <select
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={editTargetTemplateId}
                onChange={(e) => setEditTargetTemplateId(e.target.value)}
              >
                <option value="">-- Select target template --</option>
                {templates
                  .filter((t) => t.id !== editId)
                  .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            {editTriggerType === "event" && (
              <select
                className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={editEventDefId}
                onChange={(e) => setEditEventDefId(e.target.value)}
              >
                <option value="">-- Select event --</option>
                {eventDefs.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}
            {editTriggerType === "cron" && (
              <input
                className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                placeholder="Cron expression"
                value={editCron}
                onChange={(e) => setEditCron(e.target.value)}
              />
            )}
            {editTriggerType === "once" && (
              <input
                type="datetime-local"
                className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={editRunAt}
                onChange={(e) => setEditRunAt(e.target.value)}
              />
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--app-text-muted)]">Steps</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditSteps([...editSteps, { id: makeStepId(editSteps.length), prompt: "" }])}
              >
                <Plus size={12} /> Add Step
              </Button>
            </div>
            {editSteps.map((step, idx) => (
              <div key={step.id} className="rounded-md border border-[var(--app-border)] p-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-[var(--app-text-subtle)]">{step.id}</span>
                  <select
                    className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-xs text-[var(--app-text)]"
                    value={step.roleId ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      updated[idx] = { ...step, roleId: e.target.value || undefined };
                      setEditSteps(updated);
                    }}
                  >
                    <option value="">Role (template default)</option>
                    {roles.filter((r) => r.source !== "system").map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  {editSteps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setEditSteps(editSteps.filter((_, i) => i !== idx))}
                      className="text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                <textarea
                  className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                  placeholder={`Step ${idx + 1} prompt`}
                  rows={2}
                  value={step.prompt}
                  onChange={(e) => {
                    const updated = [...editSteps];
                    updated[idx] = { ...step, prompt: e.target.value };
                    setEditSteps(updated);
                  }}
                />
                {idx > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-[var(--app-text-subtle)]">depends on:</span>
                    {editSteps.slice(0, idx).map((prev) => (
                      <button
                        key={prev.id}
                        type="button"
                        onClick={() => {
                          const deps = step.dependsOn ?? [];
                          const updated = [...editSteps];
                          updated[idx] = {
                            ...step,
                            dependsOn: deps.includes(prev.id)
                              ? deps.filter((d) => d !== prev.id)
                              : [...deps, prev.id],
                          };
                          setEditSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.dependsOn ?? []).includes(prev.id)
                            ? "bg-[var(--app-accent)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
                    timeout(s):
                    <input
                      type="number"
                      min={0}
                      placeholder="default"
                      className="w-20 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                      value={step.config?.timeout ?? ""}
                      onChange={(e) => {
                        const updated = [...editSteps];
                        const val = e.target.value === "" ? undefined : Number(e.target.value);
                        updated[idx] = { ...step, config: { ...step.config, timeout: val } };
                        setEditSteps(updated);
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
                    max turns:
                    <input
                      type="number"
                      min={0}
                      placeholder="default"
                      className="w-20 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                      value={step.config?.maxTurns ?? ""}
                      onChange={(e) => {
                        const updated = [...editSteps];
                        const val = e.target.value === "" ? undefined : Number(e.target.value);
                        updated[idx] = { ...step, config: { ...step.config, maxTurns: val } };
                        setEditSteps(updated);
                      }}
                    />
                  </label>
                </div>
                {/* consumesFrom / consumesFromOptional */}
                {idx > 0 && (
                  <div className="flex flex-wrap gap-1 items-center">
                    <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Consumes:</span>
                    {editSteps.slice(0, idx).map((prev) => (
                      <button
                        key={prev.id}
                        type="button"
                        aria-label={`consumes ${prev.id}`}
                        onClick={() => {
                          const cf = step.consumesFrom ?? [];
                          const updated = [...editSteps];
                          updated[idx] = {
                            ...step,
                            consumesFrom: cf.includes(prev.id)
                              ? cf.filter((d) => d !== prev.id)
                              : [...cf, prev.id],
                          };
                          setEditSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.consumesFrom ?? []).includes(prev.id)
                            ? "bg-[var(--app-danger)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}
                      </button>
                    ))}
                    <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0 ml-1">(opt)</span>
                    {editSteps.slice(0, idx).map((prev) => (
                      <button
                        key={`${prev.id}-opt`}
                        type="button"
                        aria-label={`optional-consumes ${prev.id}`}
                        onClick={() => {
                          const cfo = step.consumesFromOptional ?? [];
                          const updated = [...editSteps];
                          updated[idx] = {
                            ...step,
                            consumesFromOptional: cfo.includes(prev.id)
                              ? cfo.filter((d) => d !== prev.id)
                              : [...cfo, prev.id],
                          };
                          setEditSteps(updated);
                        }}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          (step.consumesFromOptional ?? []).includes(prev.id)
                            ? "bg-[var(--app-accent)] text-white"
                            : "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                        }`}
                      >
                        {prev.id}?
                      </button>
                    ))}
                  </div>
                )}
                {/* Persona fields */}
                <div className="flex gap-1 items-center">
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Speak as:</span>
                  <input
                    type="text"
                    placeholder="e.g. 卞旸"
                    className="flex-1 min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)]"
                    value={step.persona?.speakAs ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      updated[idx] = {
                        ...step,
                        persona: e.target.value ? { speakAs: e.target.value, voiceConstraints: step.persona?.voiceConstraints } : undefined,
                      };
                      setEditSteps(updated);
                    }}
                  />
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Voice:</span>
                  <input
                    type="text"
                    placeholder="optional"
                    className="flex-1 min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)]"
                    value={step.persona?.voiceConstraints ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      updated[idx] = {
                        ...step,
                        persona: step.persona?.speakAs
                          ? { speakAs: step.persona.speakAs, voiceConstraints: e.target.value || undefined }
                          : undefined,
                      };
                      setEditSteps(updated);
                    }}
                  />
                </div>
                {/* Output contract fields */}
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="text-[10px] text-[var(--app-text-subtle)] shrink-0">Contract:</span>
                  <input
                    type="number" min={0} placeholder="min"
                    className="w-16 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.min ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      const min = e.target.value === "" ? undefined : Number(e.target.value);
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: min ?? 0, max: step.outputContract?.lengthTarget?.max ?? 0, unit: step.outputContract?.lengthTarget?.unit ?? "characters" },
                        },
                      };
                      setEditSteps(updated);
                    }}
                  />
                  <span className="text-[10px] text-[var(--app-text-subtle)]">—</span>
                  <input
                    type="number" min={0} placeholder="max"
                    className="w-16 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.max ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      const max = e.target.value === "" ? undefined : Number(e.target.value);
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: step.outputContract?.lengthTarget?.min ?? 0, max: max ?? 0, unit: step.outputContract?.lengthTarget?.unit ?? "characters" },
                        },
                      };
                      setEditSteps(updated);
                    }}
                  />
                  <select
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.lengthTarget?.unit ?? "characters"}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      updated[idx] = {
                        ...step,
                        outputContract: {
                          ...step.outputContract,
                          lengthTarget: { min: step.outputContract?.lengthTarget?.min ?? 0, max: step.outputContract?.lengthTarget?.max ?? 0, unit: e.target.value as "characters" | "words" | "bytes" },
                        },
                      };
                      setEditSteps(updated);
                    }}
                  >
                    <option value="characters">chars</option>
                    <option value="words">words</option>
                    <option value="bytes">bytes</option>
                  </select>
                  <select
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-xs text-[var(--app-text)]"
                    value={step.outputContract?.format ?? ""}
                    onChange={(e) => {
                      const updated = [...editSteps];
                      const val = e.target.value as "markdown" | "text" | "json" | "";
                      updated[idx] = {
                        ...step,
                        outputContract: { ...step.outputContract, format: val || undefined },
                      };
                      setEditSteps(updated);
                    }}
                  >
                    <option value="">fmt?</option>
                    <option value="markdown">md</option>
                    <option value="text">txt</option>
                    <option value="json">json</option>
                  </select>
                  <label className="flex items-center gap-0.5 text-[10px] text-[var(--app-text-subtle)] cursor-pointer">
                    <input type="checkbox" className="accent-[var(--app-accent)]"
                      checked={step.outputContract?.mustReferenceArtifacts ?? false}
                      onChange={(e) => {
                        const updated = [...editSteps];
                        updated[idx] = {
                          ...step,
                          outputContract: { ...step.outputContract, mustReferenceArtifacts: e.target.checked },
                        };
                        setEditSteps(updated);
                      }}
                    />
                    ref artifacts
                  </label>
                </div>
              </div>
            ))}
          </div>
          {editSteps.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-[var(--app-text)] cursor-pointer">
              <input
                type="checkbox"
                aria-label="continue on error"
                checked={editContinueOnError}
                onChange={(e) => setEditContinueOnError(e.target.checked)}
                className="rounded border-[var(--app-border-strong)] bg-[var(--app-panel-elevated)]"
              />
              Continue on error
            </label>
          )}
          {/* Delivery format section */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-[var(--app-text)]">投递格式</label>
            <select
              value={editDeliveryMode}
              onChange={(e) => setEditDeliveryMode(e.target.value as DeliveryMode)}
              className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            >
              <option value="concat-step-results">拼接每步结果（默认）</option>
              <option value="primary-artifact">指定主产物</option>
              <option value="custom" disabled>自定义（即将推出）</option>
            </select>
            {editDeliveryMode === "primary-artifact" && (
              <div className="space-y-2 rounded border border-[var(--app-border)] p-2">
                <div>
                  <label className="text-xs text-[var(--app-text-muted)]">来源 step</label>
                  <select
                    value={editPrimaryStepId}
                    onChange={(e) => {
                      const selectedStep = editSteps.find((s) => s.id === e.target.value);
                      setEditPrimaryStepId(e.target.value);
                      setEditPrimaryStepOutputAs(selectedStep?.outputAs ?? "");
                    }}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                  >
                    <option value="">选择 step...</option>
                    {editSteps.filter(s => s.prompt.trim()).map((s) => (
                      <option key={s.id} value={s.id}>{s.id}</option>
                    ))}
                  </select>
                </div>
                {editPrimaryStepOutputAs && (
                  <div className="text-xs text-[var(--app-accent)]">
                    Will use step&apos;s output: <span className="font-mono">{editPrimaryStepOutputAs}</span>
                  </div>
                )}
                <div>
                  <label className="text-xs text-[var(--app-text-muted)]">
                    {editPrimaryStepOutputAs ? "Or specify custom key:" : "artifact key"}
                  </label>
                  <input
                    type="text"
                    value={editPrimaryArtifactKey}
                    onChange={(e) => setEditPrimaryArtifactKey(e.target.value)}
                    placeholder={editPrimaryStepOutputAs ? "留空使用上面的自动解析值" : "手动输入 key"}
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-muted)] focus:border-[var(--app-accent)] focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>
          <NotifyTargetSelector value={editDeliverTo} onChange={setEditDeliverTo} />
          <div className="flex gap-2">
            <Button onClick={() => void saveEdit()} disabled={saving || !editName.trim() || editSteps.every((s) => !s.prompt.trim())}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button variant="ghost" onClick={() => setEditId(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <Card padding={false}>
        {templates.length === 0 ? (
          <EmptyState
            icon={<FileCode size={32} />}
            title="No automations"
            description="Create an automation to run recurring tasks"
          />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Trigger</Th>
                <Th>Schedule</Th>
                <Th>Steps</Th>
                <Th>Enabled</Th>
                <Th>Created</Th>
                <Th>Webhook URL</Th>
                <Th>Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {templates.map((t) => (
                <Fragment key={t.id}>
                <Tr>
                  <Td className="font-medium text-[var(--app-text)]">
                    <button
                      type="button"
                      onClick={() => toggleExpand(t.id)}
                      className="flex items-center gap-1 hover:text-[var(--app-accent)] transition-colors"
                    >
                      {expandedTemplateId === t.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {t.name}
                    </button>
                    {(t.isPreset || t.presetId) && (
                      <Badge variant="info" className="ml-2">Preset</Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge variant={t.trigger.type === "cron" ? "info" : t.trigger.type === "once" ? "muted" : "muted"}>
                      {formatTriggerSummary(t.trigger)}
                    </Badge>
                  </Td>
                  <Td className="font-mono text-xs">{t.trigger.type === "once" && t.trigger.runAt ? new Date(t.trigger.runAt).toLocaleString() : (t.trigger.cron ?? "\u2014")}</Td>
                  <Td className="font-mono text-xs">
                    {(() => {
                      const uniqueRoles = new Set(t.steps.filter((s) => s.roleId).map((s) => s.roleId));
                      const stepsSummary = uniqueRoles.size > 0
                        ? `${t.steps.length} steps / ${uniqueRoles.size} roles`
                        : `${t.steps.length} steps`;
                      return t.goalIds && t.goalIds.length > 0
                        ? `${stepsSummary} / ${t.goalIds.length} goals`
                        : stepsSummary;
                    })()}
                  </Td>
                  <Td>
                    {["cron", "once", "template_complete"].every((v) => t.trigger.type !== v) ? (
                      <span className="text-xs text-[var(--app-text-subtle)]">—</span>
                    ) : (
                      <Switch
                        checked={t.enabled}
                        onCheckedChange={() => void handleToggle(t.id)}
                        aria-label={`Toggle ${t.name}`}
                      />
                    )}
                  </Td>
                  <Td className="text-xs text-[var(--app-text-subtle)]">{t.createdAt ? timeAgo(t.createdAt) : "\u2014"}</Td>
                  <Td className="font-mono text-xs text-[var(--app-text-muted)]">
                    {t.enabled ? `POST /webhooks/${t.id}` : "\u2014"}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(t)} title="Edit">
                        <Pencil size={12} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRunConfirmId(t.id)}
                        disabled={runningId === t.id}
                        title="Run now"
                      >
                        <Play size={12} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                        onClick={() => { void openDeleteDialog(t.id); }}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </Td>
                </Tr>
                {expandedTemplateId === t.id && (
                  <Tr>
                    <Td colSpan={8} className="bg-[var(--app-panel)]/50 p-3">
                      <div className="mb-3">
                        <TemplateVersionHistory
                          templateId={t.id}
                          templateName={t.name}
                          onRestored={() => void fetchTemplates()}
                        />
                      </div>
                      <div className="text-xs text-[var(--app-text-muted)] mb-2 font-medium">Recent Template Executions</div>
                      {loadingExecs ? (
                        <div className="text-xs text-[var(--app-text-subtle)]">Loading...</div>
                      ) : executions.length === 0 ? (
                        <div className="text-xs text-[var(--app-text-subtle)]">No template executions yet</div>
                      ) : (
                        <div className="space-y-1.5">
                          {executions.map((ex) => {
                            const stepEntries = Object.entries(ex.stepStatuses);
                            const completed = stepEntries.filter(([, s]) => s.status === "completed").length;
                            const failed = stepEntries.filter(([, s]) => s.status === "failed").length;
                            const skipped = stepEntries.filter(([, s]) => s.status === "skipped").length;
                            const cancelled = stepEntries.filter(([, s]) => s.status === "cancelled").length;
                            const total = stepEntries.length;
                            const taskByStepId = new Map(
                              ex.stepTasks
                                .filter((task) => task.stepId)
                                .map((task) => [task.stepId as string, task]),
                            );
                            const orderedStepIds = [
                              ...t.steps.map((step) => step.id),
                              ...Object.keys(ex.stepStatuses).filter((stepId) => !t.steps.some((step) => step.id === stepId)),
                            ];
                            return (
                              <div key={ex.id} className="rounded border border-[var(--app-border)] bg-[var(--app-canvas)]/50 p-2.5 space-y-2">
                                <div className="flex items-center gap-3 text-xs">
                                  <Badge variant={ex.status === "completed" ? "success" : ex.status === "failed" ? "destructive" : ex.status === "partial" ? "warning" : ex.status === "cancelled" ? "secondary" : "muted"}>
                                    {ex.status}
                                  </Badge>
                                  <span className="text-[var(--app-text-subtle)]">{new Date(ex.startedAt).toLocaleString()}</span>
                                  {total > 0 && (
                                    <span className="text-[var(--app-text-muted)]">
                                      {completed}/{total} steps
                                      <span className="inline-flex items-center gap-2">
                                        {failed > 0 && <span className="text-[var(--app-danger)]">{failed} failed</span>}
                                        {skipped > 0 && <span className="text-[var(--app-warning)]">{skipped} skipped</span>}
                                        {cancelled > 0 && <span className="text-[var(--app-text)]">{cancelled} cancelled</span>}
                                      </span>
                                    </span>
                                  )}
                                  {ex.completedAt && (
                                    <span className="text-[var(--app-text-subtle)]">{Math.round((ex.completedAt - ex.startedAt) / 1000)}s</span>
                                  )}
                                  <span className="font-mono text-[var(--app-text-subtle)] truncate max-w-[120px]">{ex.id.slice(0, 8)}</span>
                                  <div className="ml-auto flex items-center gap-1" data-testid="execution-feedback-buttons">
                                    {feedbackState[ex.id] === "good" ? (
                                      <ThumbsUp size={13} className="text-[var(--app-success)]" aria-label="Good — recorded" />
                                    ) : feedbackState[ex.id] === "bad" ? (
                                      <ThumbsDown size={13} className="text-[var(--app-danger)]" aria-label="Bad — recorded" />
                                    ) : feedbackState[ex.id] === "pending" ? (
                                      <span className="text-[var(--app-text-subtle)] text-[10px]">...</span>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => void handleFeedback(ex.id, "good")}
                                          className="rounded p-0.5 hover:bg-[var(--app-success-soft)] text-[var(--app-text-subtle)] hover:text-[var(--app-success)] transition-colors"
                                          aria-label="Rate good"
                                          title="Good"
                                        >
                                          <ThumbsUp size={13} />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => void handleFeedback(ex.id, "bad")}
                                          className="rounded p-0.5 hover:bg-[var(--app-danger-soft)] text-[var(--app-text-subtle)] hover:text-[var(--app-danger)] transition-colors"
                                          aria-label="Rate bad"
                                          title="Bad"
                                        >
                                          <ThumbsDown size={13} />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                                <div className="space-y-1.5">
                                  {orderedStepIds.map((stepId) => {
                                    const stepStatus = ex.stepStatuses[stepId];
                                    if (!stepStatus) return null;
                                    const templateStep = t.steps.find((step) => step.id === stepId);
                                    const stepTask = taskByStepId.get(stepId);
                                    const effectiveRoleId = stepTask?.roleId ?? stepStatus.roleId ?? templateStep?.roleId;
                                    const roleName = roles.find((role) => role.id === effectiveRoleId)?.name ?? effectiveRoleId;
                                    const message = stepTask?.error ?? stepStatus.error ?? stepTask?.result ?? stepStatus.result;
                                    return (
                                      <div key={`${ex.id}-${stepId}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 rounded bg-[var(--app-panel)]/60 px-2 py-1.5 text-xs">
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2">
                                            <span className="font-mono text-[var(--app-text)]">{stepId}</span>
                                            {roleName && <span className="text-[var(--app-warning-soft-text)]">@{roleName}</span>}
                                            {templateStep?.dependsOn && templateStep.dependsOn.length > 0 && (
                                              <span className="text-[var(--app-text-subtle)]">after {templateStep.dependsOn.join(", ")}</span>
                                            )}
                                          </div>
                                          {message && (
                                            <div className={`mt-1 truncate ${stepStatus.status === "failed" ? "text-[var(--app-danger-soft-text)]" : stepStatus.status === "skipped" ? "text-[var(--app-warning-soft-text)]" : stepStatus.status === "cancelled" ? "text-[var(--app-text)]" : "text-[var(--app-text-muted)]"}`}>
                                              {message}
                                            </div>
                                          )}
                                        </div>
                                        <Badge variant={stepStatus.status === "completed" ? "success" : stepStatus.status === "failed" ? "destructive" : stepStatus.status === "skipped" ? "warning" : stepStatus.status === "cancelled" ? "secondary" : "muted"}>
                                          {stepStatus.status}
                                        </Badge>
                                        {stepStatus.contract && (
                                          <StepContractBadges
                                            contract={stepStatus.contract}
                                            retried={stepStatus.contractRetried}
                                          />
                                        )}
                                        <div className="text-right text-[var(--app-text-subtle)]">
                                          {stepTask?.completedAt && (
                                            <div>{Math.max(0, Math.round((stepTask.completedAt - stepTask.createdAt) / 1000))}s</div>
                                          )}
                                          {stepTask?.id && <div className="font-mono">{stepTask.id.slice(0, 8)}</div>}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Td>
                  </Tr>
                )}
                </Fragment>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {/* Run confirmation dialog */}
      <AlertDialog open={runConfirmId !== null} onOpenChange={(open) => { if (!open) setRunConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run Template</AlertDialogTitle>
            <AlertDialogDescription>
              Run &ldquo;{runConfirmTemplate?.name}&rdquo; now? This will execute the template immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (runConfirmId) void handleRun(runConfirmId);
                setRunConfirmId(null);
              }}
            >
              Run Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deleteConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConfirmId(null);
            setDeleteDependents(null);
            setDeleteMode("template_only");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDependents === null ? (
                <>Loading&hellip;</>
              ) : deleteDependents.taskCount === 0 && deleteDependents.executionCount === 0 ? (
                <>Delete &ldquo;{deleteConfirmTemplate?.name}&rdquo;? This action cannot be undone.</>
              ) : deleteDependents.taskCount === 0 ? (
                <>
                  &ldquo;{deleteConfirmTemplate?.name}&rdquo; has {deleteDependents.executionCount} template execution{deleteDependents.executionCount === 1 ? "" : "s"} which will be removed. Delete?
                </>
              ) : (
                <>
                  &ldquo;{deleteConfirmTemplate?.name}&rdquo; has{" "}
                  {deleteDependents.executionCount > 0 && (
                    <>{deleteDependents.executionCount} template execution{deleteDependents.executionCount === 1 ? "" : "s"}</>
                  )}
                  {deleteDependents.executionCount > 0 && deleteDependents.taskCount > 0 && " and "}
                  {deleteDependents.taskCount} task{deleteDependents.taskCount === 1 ? "" : "s"}. Choose what to delete:
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteDependents !== null && deleteDependents.taskCount > 0 && (
            <div className="space-y-2 px-1">
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="deleteMode"
                  value="template_only"
                  checked={deleteMode === "template_only"}
                  onChange={() => setDeleteMode("template_only")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">Template only</div>
                  <div className="text-xs text-[var(--app-text-subtle)]">
                    Removes the automation. Tasks remain under the Tasks tab as history.
                  </div>
                </div>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="deleteMode"
                  value="with_tasks"
                  checked={deleteMode === "with_tasks"}
                  onChange={() => setDeleteMode("with_tasks")}
                  className="mt-1"
                />
                <div>
                  <div className="text-sm font-medium">Template and its tasks</div>
                  <div className="text-xs text-[var(--app-text-subtle)]">
                    Also deletes {deleteDependents.taskCount} task{deleteDependents.taskCount === 1 ? "" : "s"} and their score history. Cannot be undone.
                  </div>
                </div>
              </label>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-[var(--app-danger)] hover:bg-[var(--app-danger)]"
              disabled={deleteLoading || deleteDependents === null}
              onClick={() => {
                if (deleteConfirmId) {
                  const effectiveMode = deleteDependents && deleteDependents.taskCount > 0 ? deleteMode : "template_only";
                  void handleDelete(deleteConfirmId, effectiveMode);
                }
                setDeleteConfirmId(null);
                setDeleteDependents(null);
                setDeleteMode("template_only");
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
