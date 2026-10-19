import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { request } from "../../client.js";
import type { DeliveryLogEntry, NotifyTarget, Task, TaskPlan } from "../../../shared/types.js";

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
}

type DetailSection = "plan" | "result" | "routing" | "error";

interface DetailSections {
  plan: boolean;
  result: boolean;
  routing: boolean;
  error: boolean;
}

const DEFAULT_SECTIONS: DetailSections = {
  plan: true,
  result: false,
  routing: true,
  error: true,
};

const statusColor: Record<string, string> = {
  pending: "gray",
  queued: "gray",
  running: "yellow",
  paused: "yellow",
  completed: "green",
  failed: "red",
  cancelled: "gray",
  blocked: "yellow",
};

export function TaskDetail({ taskId, onBack }: TaskDetailProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [deliveryLog, setDeliveryLog] = useState<DeliveryLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sections, setSections] = useState<DetailSections>(DEFAULT_SECTIONS);
  const [promptExpanded, setPromptExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setTask(null);
    setPlans([]);
    setDeliveryLog([]);
    setError(null);
    setSections(DEFAULT_SECTIONS);
    setPromptExpanded(false);

    request<{ task: Task }>(`/tasks/${taskId}`)
      .then(({ task }) => {
        if (!cancelled) setTask(task);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    request<{ plans: TaskPlan[] }>(`/tasks/${taskId}/plan`)
      .then(({ plans }) => {
        if (!cancelled) setPlans(plans);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });

    request<{ logs: DeliveryLogEntry[] }>(`/tasks/${taskId}/delivery-log?limit=8`)
      .then(({ logs }) => {
        if (!cancelled) setDeliveryLog(logs);
      })
      .catch(() => {
        if (!cancelled) setDeliveryLog([]);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const toggleSection = (section: DetailSection) => {
    setSections((current) => ({ ...current, [section]: !current[section] }));
  };

  useInput((input, key) => {
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    if (input === "1") toggleSection("plan");
    if (input === "2") toggleSection("result");
    if (input === "3") toggleSection("routing");
    if (input === "4") toggleSection("error");
    if (input === "5") setPromptExpanded((current) => !current);
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Task detail failed: {error}</Text>
        <Text dimColor>[b] Back</Text>
      </Box>
    );
  }

  if (!task) {
    return <Text dimColor>Loading task {taskId.slice(0, 8)}...</Text>;
  }

  const plan = plans[0];
  const targetSummary = describeTargets(task.deliverTo, task.reportTo);
  const deliverySummary = deliveryLog.length > 0 ? `${deliveryLog.length} delivery event${deliveryLog.length === 1 ? "" : "s"}` : "No delivery events";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">Task {task.id.slice(0, 8)}</Text>
        <Text dimColor>  •  </Text>
        <Text color={statusColor[task.status] ?? "white"} bold>{task.status.toUpperCase()}</Text>
      </Box>
      <Text dimColor>
        {task.roleId ? `role ${task.roleId}` : "no role"}  •  {formatTimestamp(task.createdAt)}  •  {formatDuration(task.totalDurationMs)}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Summary</Text>
        <Text>{promptExpanded ? task.prompt : compactText(task.prompt, 240)}</Text>
        {task.prompt.length > 240 && (
          <Text dimColor>[5] {promptExpanded ? "collapse prompt" : "expand prompt"}</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Cost: {formatCost(task.costUsd)}</Text>
          <Text dimColor>Turns: {task.numTurns ?? "—"}</Text>
          <Text dimColor>Template: {task.templateId ?? "—"}</Text>
          <Text dimColor>Source Session: {task.sourceSessionId?.slice(0, 8) ?? "—"}</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>[1] Plan {sections.plan ? "hide" : "show"}</Text>
        <Text dimColor>
          {plan
            ? `${plan.plan.steps.length} planned step${plan.plan.steps.length === 1 ? "" : "s"}  •  ${plan.plan.overallRisk} risk  •  ${plan.status}`
            : "No execution plan"}
        </Text>
        {sections.plan && plan && (
          <Box marginTop={1} flexDirection="column">
            {plan.plan.steps.map((step) => (
              <Box key={step.index} flexDirection="column" marginBottom={1}>
                <Text>
                  {step.index}. {step.description}
                </Text>
                <Text dimColor>
                  {step.riskLevel} risk  •  {step.toolsNeeded.join(", ") || "no tools listed"}
                </Text>
                {step.expectedOutput ? <Text dimColor>Expected: {step.expectedOutput}</Text> : null}
              </Box>
            ))}
            {plan.learnedRules && plan.learnedRules.length > 0 && (
              <Box flexDirection="column">
                <Text color="blue" bold>Learned Rules</Text>
                {plan.learnedRules.map((rule, index) => (
                  <Text key={index} dimColor>• {rule}</Text>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>[2] Result {sections.result ? "hide" : "show"}</Text>
        <Text dimColor>{task.result ? "Execution produced output." : "No result captured yet."}</Text>
        {sections.result && (
          <Box marginTop={1}>
            <Text>{task.result ? clipBlock(task.result, 18) : "No result yet."}</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>[3] Routing {sections.routing ? "hide" : "show"}</Text>
        <Text dimColor>{targetSummary}  •  {deliverySummary}</Text>
        {sections.routing && (
          <Box marginTop={1} flexDirection="column">
            <Text color="cyan">Deliver To</Text>
            {renderTargets(task.deliverTo)}
            <Text color="cyan">Report To</Text>
            {renderTargets(task.reportTo)}
            {deliveryLog.length > 0 && (
              <Box marginTop={1} flexDirection="column">
                <Text color="cyan">Recent Delivery</Text>
                {deliveryLog.map((entry) => (
                  <Text key={entry.id} dimColor>
                    {entry.status}  •  {formatDeliveryTarget(entry)}  •  {formatTimestamp(entry.createdAt)}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>[4] Error {sections.error ? "hide" : "show"}</Text>
        <Text dimColor>{task.error ? "Execution returned an error condition." : "No error recorded."}</Text>
        {sections.error && task.error && (
          <Box marginTop={1}>
            <Text color="red">{clipBlock(task.error, 16)}</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>[1] plan  [2] result  [3] routing  [4] error  [5] prompt  [b] back</Text>
      </Box>
    </Box>
  );
}

function renderTargets(targets?: NotifyTarget[]) {
  if (!targets || targets.length === 0) {
    return <Text dimColor>  none</Text>;
  }

  return (
    <Box flexDirection="column">
      {targets.map((target, index) => (
        <Text key={`${target.type}-${index}`} dimColor>
          {target.type === "channel"
            ? `  channel ${target.channelId.slice(0, 8)}${target.chatId ? ` / ${target.chatId.slice(0, 8)}` : ""}`
            : `  session ${target.sessionId.slice(0, 8)}`}
        </Text>
      ))}
    </Box>
  );
}

function clipBlock(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return `${lines.slice(0, maxLines).join("\n")}\n…`;
}

function compactText(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatCost(costUsd?: number): string {
  return costUsd !== undefined ? `$${costUsd.toFixed(4)}` : "—";
}

function formatDuration(totalDurationMs?: number): string {
  if (!totalDurationMs) return "waiting";
  const seconds = Math.max(1, Math.round(totalDurationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function describeTargets(deliverTo?: NotifyTarget[], reportTo?: NotifyTarget[]): string {
  const outputCount = deliverTo?.length ?? 0;
  const reportCount = reportTo?.length ?? 0;
  if (outputCount === 0 && reportCount === 0) return "No delivery targets";
  return `${outputCount} output target${outputCount === 1 ? "" : "s"}  •  ${reportCount} report target${reportCount === 1 ? "" : "s"}`;
}

function formatDeliveryTarget(entry: DeliveryLogEntry): string {
  if (entry.target.type === "webhook") return entry.target.webhookUrl ?? "webhook";
  if (entry.target.type === "channel") return `channel ${entry.target.channelId?.slice(0, 8) ?? "unknown"}`;
  return "unknown target";
}
