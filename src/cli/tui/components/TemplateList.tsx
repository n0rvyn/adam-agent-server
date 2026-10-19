import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState, useCallback } from "react";
import { CronExpressionParser } from "cron-parser";
import { request } from "../../client.js";
import type { Role, TaskTemplate, TaskTemplateTriggerType } from "../../../shared/types.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";

type FormMode = "list" | "create" | "edit";
type FormField = "name" | "triggerType" | "cron" | "targetTemplateId" | "stepPrompt";

const TRIGGER_TYPES: TaskTemplateTriggerType[] = [
  "manual", "cron", "once", "template_complete",
];

const TOGGLEABLE: TaskTemplateTriggerType[] = ["cron", "once", "template_complete"];

interface FormData {
  name: string;
  triggerType: TaskTemplateTriggerType;
  cron: string;
  targetTemplateId: string;
  stepPrompt: string;
}

const emptyForm: FormData = { name: "", triggerType: "manual", cron: "", targetTemplateId: "", stepPrompt: "" };

function nextCronRun(cronExpr: string): string {
  try {
    const interval = CronExpressionParser.parse(cronExpr);
    const next = interval.next();
    return next.toDate().toLocaleString();
  } catch {
    return "invalid";
  }
}

interface TemplateListProps {
  onBack: () => void;
}

export function TemplateList({ onBack }: TemplateListProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<FormMode>("list");
  const [formData, setFormData] = useState<FormData>({ ...emptyForm });
  const [activeField, setActiveField] = useState<FormField>("name");
  const [editId, setEditId] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useFlashMessage();
  const [triggering, setTriggering] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [roleNamesById, setRoleNamesById] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<null | {
    templateId: string;
    templateName: string;
    executionCount: number;
    taskCount: number;
  }>(null);
  const [beginningDelete, setBeginningDelete] = useState(false);

  // Execution history panel state
  const [showExecutions, setShowExecutions] = useState(false);
  const [executions, setExecutions] = useState<Array<{ id: string; status: string; startedAt: number }>>([]);
  const [executionFeedback, setExecutionFeedback] = useState<Record<string, "good" | "bad">>({});

  const fetchExecHistory = useCallback(async (templateId: string) => {
    try {
      const res = await request<{ executions: Array<{ id: string; status: string; startedAt: number }> }>(
        `/template-executions?templateId=${templateId}&limit=5`
      );
      setExecutions(res.executions ?? []);
    } catch {
      setExecutions([]);
    }
  }, []);

  const rateExecution = useCallback(async (executionId: string, rating: "good" | "bad") => {
    try {
      await request(`/executions/${executionId}/feedback`, { method: "POST", body: { rating } });
      setExecutionFeedback((prev) => ({ ...prev, [executionId]: rating }));
    } catch (err) {
      setMessage(`Feedback failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [setMessage]);

  const fetchTemplates = useCallback(() => {
    setLoading(true);
    request<{ templates: TaskTemplate[] }>("/task-templates")
      .then(({ templates }) => {
        setTemplates(templates);
        const roleIds = new Set(
          templates.flatMap((template) => template.steps?.map((step) => step.roleId).filter(Boolean) ?? []),
        );
        if (roleIds.size > 0) {
          void request<{ roles?: Role[] }>("/roles")
            .then(({ roles }) => {
              if (!Array.isArray(roles)) {
                setRoleNamesById({});
                return;
              }
              setRoleNamesById(Object.fromEntries(roles.map((role) => [role.id, role.name])));
            })
            .catch(() => setRoleNamesById({}));
        } else {
          setRoleNamesById({});
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const inputMode = mode === "create" || mode === "edit";

  const handleTrigger = useCallback(async () => {
    const t = templates[selectedIndex];
    if (!t || triggering) return;
    setTriggering(true);
    setMessage(`Triggering ${t.name}...`, "loading");
    try {
      const res = await request<{ executionId: string }>(`/task-templates/${t.id}/run`, { method: "POST" });
      setMessage(`Triggered: ${t.name} (${res.executionId})`, "success");
    } catch (err) {
      setMessage(`Trigger failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setTriggering(false);
    }
  }, [templates, selectedIndex, triggering, setMessage]);

  const handleToggle = useCallback(async () => {
    const t = templates[selectedIndex];
    if (!t || toggling) return;
    if (!TOGGLEABLE.includes(t.trigger?.type ?? "manual")) {
      setMessage("Toggle not applicable for manual triggers", "error");
      return;
    }
    const newEnabled = !t.enabled;
    setToggling(true);
    setMessage(`${t.name} → ${newEnabled ? "enabling" : "disabling"}...`, "loading");
    try {
      await request(`/task-templates/${t.id}`, {
        method: "PATCH",
        body: { enabled: newEnabled },
      });
      setTemplates((prev) =>
        prev.map((template) =>
          template.id === t.id ? { ...template, enabled: newEnabled } : template,
        ),
      );
      setMessage(`${t.name} ${newEnabled ? "enabled" : "disabled"}`, "success");
    } catch (err) {
      setMessage(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setToggling(false);
    }
  }, [templates, selectedIndex, toggling, setMessage]);

  const beginDelete = useCallback(async () => {
    if (beginningDelete) return;
    const t = templates[selectedIndex];
    if (!t) return;
    setBeginningDelete(true);
    try {
      const res = await request<{ dependents: { executionCount: number; taskCount: number } }>(
        `/task-templates/${t.id}/dependents`,
        { method: "GET" },
      );
      setPendingDelete({
        templateId: t.id,
        templateName: t.name,
        executionCount: res.dependents.executionCount,
        taskCount: res.dependents.taskCount,
      });
      if (res.dependents.taskCount === 0 && res.dependents.executionCount === 0) {
        setMessage(`Delete "${t.name}"? Press d to confirm, Esc to cancel.`, "loading");
      } else {
        setMessage(
          `"${t.name}" has ${res.dependents.executionCount} template execution${res.dependents.executionCount === 1 ? "" : "s"}, ${res.dependents.taskCount} task${res.dependents.taskCount === 1 ? "" : "s"}. [d] template only (keep tasks) | [D] template + tasks | [Esc] cancel.`,
          "loading",
        );
      }
    } catch (err) {
      setMessage(`Failed to inspect dependents: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBeginningDelete(false);
    }
  }, [templates, selectedIndex, setMessage, beginningDelete]);

  const confirmDelete = useCallback(async (mode: "template_only" | "with_tasks") => {
    const pd = pendingDelete;
    if (!pd) return;
    setPendingDelete(null);
    try {
      const res = await request<{ deleted: boolean; mode: string; deletedCounts: { template: number; templateExecutions: number; tasks: number } }>(
        `/task-templates/${pd.templateId}?mode=${mode}`,
        { method: "DELETE" },
      );
      const parts: string[] = [];
      if (res.deletedCounts.templateExecutions > 0) {
        parts.push(`${res.deletedCounts.templateExecutions} template exec`);
      }
      if (res.deletedCounts.tasks > 0) {
        parts.push(`${res.deletedCounts.tasks} task${res.deletedCounts.tasks === 1 ? "" : "s"}`);
      }
      const suffix = parts.length ? ` (+${parts.join(", ")})` : "";
      setMessage(`Deleted: ${pd.templateName}${suffix}`, "success");
      fetchTemplates();
      setSelectedIndex((i) => Math.max(0, Math.min(i, templates.length - 2)));
    } catch (err) {
      setMessage(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [pendingDelete, fetchTemplates, setMessage, templates.length]);

  const cancelDelete = useCallback(() => {
    setPendingDelete(null);
    clearMessage();
  }, [clearMessage]);

  const handleEdit = useCallback(() => {
    const t = templates[selectedIndex];
    if (!t) return;
    setEditId(t.id);
    setFormData({
      name: t.name,
      triggerType: t.trigger?.type ?? "manual",
      cron: t.trigger?.cron ?? "",
      targetTemplateId: t.trigger?.type === "template_complete"
        ? (t.trigger.event?.split(":")[1] ?? "")
        : "",
      stepPrompt: t.steps?.[0]?.prompt ?? "",
    });
    setActiveField("name");
    setMode("edit");
  }, [templates, selectedIndex]);

  const submitForm = useCallback(async () => {
    const body = {
      name: formData.name,
      trigger: {
        type: formData.triggerType,
        ...(formData.triggerType === "cron" ? { cron: formData.cron } : {}),
        ...(formData.triggerType === "template_complete" && formData.targetTemplateId
            ? { event: `template_complete:${formData.targetTemplateId}` } : {}),
      },
      steps: [{ id: "step-1", prompt: formData.stepPrompt }],
      enabled: true,
    };

    try {
      if (mode === "create") {
        await request("/task-templates", { method: "POST", body });
        setMessage(`Created: ${formData.name}`, "success");
      } else if (mode === "edit" && editId) {
        await request(`/task-templates/${editId}`, { method: "PATCH", body });
        setMessage(`Updated: ${formData.name}`, "success");
      }
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }

    setMode("list");
    setFormData({ ...emptyForm });
    setEditId(null);
    fetchTemplates();
  }, [formData, mode, editId, fetchTemplates]);

  useInput((input, key) => {
    if (inputMode) {
      if (key.escape) {
        setMode("list");
        setFormData({ ...emptyForm });
        setEditId(null);
        return;
      }
      if (key.return) {
      const baseFields: FormField[] = ["name", "triggerType", "cron", "stepPrompt"];
      const needsTarget = formData.triggerType === "template_complete";
        const fields: FormField[] = needsTarget
          ? ["name", "triggerType", "targetTemplateId", "stepPrompt"]
          : baseFields.filter((f) => f !== "targetTemplateId");
        const idx = fields.indexOf(activeField);
        // Skip cron field if not cron trigger
        if (idx < fields.length - 1) {
          let nextIdx = idx + 1;
          if (fields[nextIdx] === "cron" && formData.triggerType !== "cron") {
            nextIdx++;
          }
          if (nextIdx < fields.length) {
            setActiveField(fields[nextIdx]!);
            return;
          }
        }
        // Last field: submit
        submitForm();
        return;
      }
      // Cycle trigger type with Tab when on triggerType field
      if (key.tab && activeField === "triggerType") {
        setFormData((prev) => {
          const idx = TRIGGER_TYPES.indexOf(prev.triggerType);
          return { ...prev, triggerType: TRIGGER_TYPES[(idx + 1) % TRIGGER_TYPES.length]! };
        });
        return;
      }
      // Cycle target template with Tab when on targetTemplateId field
      if (key.tab && activeField === "targetTemplateId") {
        setFormData((prev) => {
          const candidates = templates.filter((t) => t.id !== editId);
          const idx = candidates.findIndex((t) => t.id === prev.targetTemplateId);
          const next = candidates[(idx + 1) % candidates.length];
          return { ...prev, targetTemplateId: next?.id ?? "" };
        });
        return;
      }
      return;
    }

    // List mode shortcuts

    // Pending-delete state machine takes priority over normal shortcuts.
    if (pendingDelete) {
      if (key.escape) {
        cancelDelete();
        return;
      }
      if (input === "D" && key.shift) {
        void confirmDelete("with_tasks");
        return;
      }
      if (input === "d" && !key.shift) {
        void confirmDelete("template_only");
        return;
      }
      return; // swallow other input while pending
    }

    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(templates.length - 1, i + 1));
      return;
    }
    if (input === "t") {
      handleTrigger();
      return;
    }
    if (input === "d" && !key.shift) {
      void beginDelete();
      return;
    }
    if (input === "e") {
      handleEdit();
      return;
    }
    if (input === "c") {
      setFormData({ ...emptyForm });
      setActiveField("name");
      setMode("create");
      return;
    }
    if (input === "s" || input === " ") {
      handleToggle();
      return;
    }
    if (input === "r") {
      fetchTemplates();
      clearMessage();
    }
    if (input === "x") {
      const t = templates[selectedIndex];
      if (!t) return;
      if (showExecutions) {
        setShowExecutions(false);
        setExecutions([]);
      } else {
        setShowExecutions(true);
        void fetchExecHistory(t.id);
      }
      return;
    }
    if (input === "g" && showExecutions && executions.length > 0) {
      void rateExecution(executions[0]!.id, "good");
      return;
    }
    if (input === "b" && showExecutions && executions.length > 0) {
      void rateExecution(executions[0]!.id, "bad");
      return;
    }
  });

  if (loading) {
    return <Text dimColor>Loading templates...</Text>;
  }

  // Create/Edit form
  if (inputMode) {
    return (
      <Box flexDirection="column">
        <Text bold>{mode === "create" ? "Create Template" : "Edit Template"} (Esc to cancel)</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text bold={activeField === "name"} color={activeField === "name" ? "cyan" : undefined}>
              Name:{" "}
            </Text>
            {activeField === "name" ? (
              <TextInput
                value={formData.name}
                onChange={(v) => setFormData((p) => ({ ...p, name: v }))}
                placeholder="template name"
              />
            ) : (
              <Text>{formData.name || "(empty)"}</Text>
            )}
          </Box>
          <Box>
            <Text bold={activeField === "triggerType"} color={activeField === "triggerType" ? "cyan" : undefined}>
              Trigger:{" "}
            </Text>
            <Text>{formData.triggerType}</Text>
            {activeField === "triggerType" && <Text dimColor> (Tab to cycle, Enter to continue)</Text>}
          </Box>
          {formData.triggerType === "cron" && (
            <Box>
              <Text bold={activeField === "cron"} color={activeField === "cron" ? "cyan" : undefined}>
                Cron:{" "}
              </Text>
              {activeField === "cron" ? (
                <TextInput
                  value={formData.cron}
                  onChange={(v) => setFormData((p) => ({ ...p, cron: v }))}
                  placeholder="*/5 * * * *"
                />
              ) : (
                <Text>{formData.cron || "(empty)"}</Text>
              )}
            </Box>
          )}
          {formData.triggerType === "template_complete" && (
            <Box>
              <Text bold={activeField === "targetTemplateId"} color={activeField === "targetTemplateId" ? "cyan" : undefined}>
                Target:{" "}
              </Text>
              <Text>
                {(() => {
                  const tpl = templates.find((t) => t.id === formData.targetTemplateId);
                  return tpl ? tpl.name : formData.targetTemplateId ? `(id: ${formData.targetTemplateId.slice(0, 8)})` : "(Tab to select)";
                })()}
              </Text>
              {activeField === "targetTemplateId" && <Text dimColor> (Tab to cycle)</Text>}
            </Box>
          )}
          <Box>
            <Text bold={activeField === "stepPrompt"} color={activeField === "stepPrompt" ? "cyan" : undefined}>
              Step Prompt:{" "}
            </Text>
            {activeField === "stepPrompt" ? (
              <TextInput
                value={formData.stepPrompt}
                onChange={(v) => setFormData((p) => ({ ...p, stepPrompt: v }))}
                placeholder="What should this template do?"
              />
            ) : (
              <Text>{formData.stepPrompt || "(empty)"}</Text>
            )}
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter: next field / submit | Esc: cancel</Text>
        </Box>
      </Box>
    );
  }

  // List mode
  return (
    <Box flexDirection="column">
      <Text bold>Automations ({templates.length}) (Esc to go back)</Text>
      {message && (
        <Box marginTop={1}>
          <Text
            color={message.type === "success" ? "green" : message.type === "error" ? "red" : "gray"}
          >
            {message.type === "success" ? "✓ " : message.type === "error" ? "✗ " : "→ "}
            {message.text}
          </Text>
        </Box>
      )}
      {templates.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No templates found. Press c to create one.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {templates.map((t, i) => {
            const selected = i === selectedIndex;
            const cronNext =
              t.trigger?.type === "cron" && t.trigger?.cron
                ? nextCronRun(t.trigger.cron)
                : "";
            const uniqueRoles = new Set(t.steps?.filter((s) => s.roleId).map((s) => s.roleId));
            const stepsLabel = t.steps?.length > 1
              ? `${t.steps.length} steps${uniqueRoles.size > 0 ? ` / ${uniqueRoles.size} roles` : ""}`
              : `${t.steps?.length ?? 0} step`;
            return (
              <Box key={t.id} flexDirection="column">
                <Box>
                  <Text color={selected ? "cyan" : undefined} bold={selected}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text color={selected ? "cyan" : undefined} bold={selected}>
                    {pad(t.name, 24)}
                  </Text>
                  <Text dimColor>{pad(t.trigger?.type, 10)}</Text>
                  {!TOGGLEABLE.includes(t.trigger?.type ?? "manual") ? (
                    <Text dimColor>{pad("—", 6)}</Text>
                  ) : (
                    <Text color={t.enabled ? "green" : "gray"}>
                      {pad(t.enabled ? "on" : "off", 6)}
                    </Text>
                  )}
                  <Text dimColor>{pad(stepsLabel, 18)}</Text>
                  {cronNext && <Text dimColor>next: {cronNext}</Text>}
                </Box>
                {selected && (
                  <>
                    {t.config?.delivery && (
                      // TUI editing of this field deferred per Phase 1 plan DP-002 (2026-05-08); see DP-010 in .claude/reviews/dp-log-autonomous-2026-05-08.md.
                      <Box marginLeft={4} marginTop={0}>
                        <Text dimColor>  Delivery: {t.config.delivery.mode}
                        {t.config.delivery.mode === "primary-artifact" && t.config.delivery.primaryArtifact &&
                          ` (${t.config.delivery.primaryArtifact.stepId}/${t.config.delivery.primaryArtifact.key})`}
                        </Text>
                      </Box>
                    )}
                    {t.steps && t.steps.length > 1 && (
                      <Box flexDirection="column" marginLeft={4} marginTop={0}>
                        {t.steps.map((step, si) => (
                          <Box key={step.id}>
                            <Text dimColor>  {si + 1}. </Text>
                            <Text dimColor>{step.id}</Text>
                            {step.roleId && <Text color="yellow"> @{roleNamesById[step.roleId] ?? step.roleId}</Text>}
                            {step.dependsOn && step.dependsOn.length > 0 && (
                              <Text dimColor> (after: {step.dependsOn.join(", ")})</Text>
                            )}
                            {step.consumesFrom && step.consumesFrom.length > 0 && (
                              <Text dimColor> [consumes: {step.consumesFrom.join(", ")}]</Text>
                            )}
                            {step.consumesFromOptional && step.consumesFromOptional.length > 0 && (
                              <Text dimColor> [consumes?: {step.consumesFromOptional.join(", ")}]</Text>
                            )}
                            {step.persona && (
                              <Text dimColor> [speak as: {step.persona.speakAs}{step.persona.voiceConstraints ? ` / ${step.persona.voiceConstraints}` : ""}]</Text>
                            )}
                            {step.outputContract && (
                              <Text dimColor> [
                                {(step.outputContract.contractRules ?? []).map((r) => r.kind).join(" ")}
                                {step.outputContract.mustReferenceArtifacts ? " ref-artifacts" : ""}
                              ]</Text>
                            )}
                            {step.config && (
                              <Text dimColor>
                                {" "}[{[
                                  step.config.timeout !== undefined ? `timeout:${step.config.timeout}s` : "",
                                  step.config.maxTurns !== undefined ? `turns:${step.config.maxTurns}` : "",
                                ].filter(Boolean).join(", ")}]
                              </Text>
                            )}
                          </Box>
                        ))}
                      </Box>
                    )}
                  {selected && showExecutions && (
                    <Box flexDirection="column" marginLeft={4} marginTop={0}>
                      {executions.length === 0 ? (
                        <Text dimColor>  No recent executions</Text>
                      ) : (
                        executions.map((ex, ei) => {
                          const fb = executionFeedback[ex.id];
                          const isLatest = ei === 0;
                          return (
                            <Box key={ex.id}>
                              <Text dimColor>  {isLatest ? ">" : " "} </Text>
                              <Text color={ex.status === "completed" ? "green" : ex.status === "failed" ? "red" : "gray"}>
                                {ex.status.padEnd(10)}
                              </Text>
                              <Text dimColor>{new Date(ex.startedAt).toLocaleString().slice(0, 16)}</Text>
                              <Text dimColor>  {ex.id.slice(0, 8)}</Text>
                              {fb && (
                                <Text color={fb === "good" ? "green" : "red"}>{fb === "good" ? " 👍" : " 👎"}</Text>
                              )}
                            </Box>
                          );
                        })
                      )}
                      {executions.length > 0 && (
                        <Text dimColor>  g:good  b:bad (rates most recent)</Text>
                      )}
                    </Box>
                  )}
                  </>
                )}
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>t:trigger s:toggle d:delete e:edit c:create r:refresh x:executions</Text>
      </Box>
    </Box>
  );
}

function pad(s: string, len: number): string {
  if (!s) return " ".repeat(len);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
