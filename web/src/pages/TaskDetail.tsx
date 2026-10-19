import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Ban, Clock, DollarSign, Hash, User, Layers, FileText, ShieldAlert } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card.tsx";
import { Badge, statusVariant } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { api, fetchDeliveryLog } from "@/lib/api.ts";
import { formatDateTime, formatDuration, formatCost } from "@/lib/format.ts";
import type { Task, TaskPlan, StepLog, DeliveryLogEntry, RoleScoreRecord, Artifact } from "@/lib/types.ts";
import { ExecutionTimeline } from "@/components/ExecutionTimeline.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";
import { ArtifactList } from "@/components/artifacts/ArtifactList.tsx";
import { ArtifactDetail } from "@/components/artifacts/ArtifactDetail.tsx";

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [plans, setPlans] = useState<TaskPlan[]>([]);
  const [stepLogs, setStepLogs] = useState<StepLog[]>([]);
  const [deliveryLog, setDeliveryLog] = useState<DeliveryLogEntry[]>([]);
  const [taskScore, setTaskScore] = useState<RoleScoreRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [tab, setTab] = useState<"overview" | "artifacts">("overview");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const diagnosticsSummary = useMemo(() => {
    if (!task) return "No diagnostics yet";
    const parts = [];
    if (task.error) parts.push("error");
    if (stepLogs.length > 0) parts.push(`${stepLogs.length} steps`);
    if (deliveryLog.length > 0) parts.push(`${deliveryLog.length} delivery events`);
    return parts.length > 0 ? parts.join(" · ") : "No diagnostics yet";
  }, [deliveryLog.length, stepLogs.length, task]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      try {
        const data = await api<{ task: Task }>(`/tasks/${id}`);
        if (cancelled) return;
        setTask(data.task);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load task");
      }
    };
    void load();
    api<{ plans: TaskPlan[] }>(`/tasks/${id}/plan`)
      .then((data) => {
        if (!cancelled) setPlans(data.plans);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    api<{ logs: StepLog[] }>(`/tasks/${id}/logs?limit=200`)
      .then((data) => {
        if (!cancelled) setStepLogs(data.logs);
      })
      .catch(() => {
        if (!cancelled) setStepLogs([]);
      });
    fetchDeliveryLog(id)
      .then((logs) => {
        if (!cancelled) setDeliveryLog(logs);
      })
      .catch(() => {
        if (!cancelled) setDeliveryLog([]);
      });
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  useEffect(() => {
    if (!id || tab !== "artifacts") return;
    let cancelled = false;
    setArtifactsLoading(true);
    setArtifactsError(null);
    api<{ artifacts: Artifact[] }>(`/tasks/${id}/artifacts`)
      .then((data) => {
        if (!cancelled) {
          setArtifacts(data.artifacts);
          setArtifactsLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setArtifactsError(e instanceof Error ? e.message : "Failed to load artifacts");
          setArtifactsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [id, tab]);

  useEffect(() => {
    if (!task?.roleId || !id) return;
    let cancelled = false;
    api<{ scores: RoleScoreRecord[] }>(`/roles/${task.roleId}/scores?limit=100`)
      .then((data) => {
        if (cancelled) return;
        const match = data.scores.find(s => s.taskId === id);
        setTaskScore(match ?? null);
      })
      .catch(() => {
        if (!cancelled) setTaskScore(null);
      });
    return () => { cancelled = true; };
  }, [task?.roleId, id]);

  const handleCancel = async () => {
    if (!id) return;
    setCancelling(true);
    try {
      await api(`/tasks/${id}/cancel`, { method: "POST" });
      setTask((t) => (t ? { ...t, status: "cancelled" } : t));
    } finally {
      setCancelling(false);
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/work" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={ICON_SIZE.sm} /> Back to Tasks
        </Link>
        <Card className="text-center text-[var(--app-danger)]">{error}</Card>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="space-y-4">
        <Link to="/work" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={ICON_SIZE.sm} /> Back to Tasks
        </Link>
        <Card className="text-center text-[var(--app-text-subtle)]">Loading...</Card>
      </div>
    );
  }

  const canCancel = ["running", "queued", "pending", "paused"].includes(task.status);
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Task"
        title="Task Detail"
        compact
        description="Summary, execution, result, and diagnostics."
        metrics={[
          { label: "Status", value: <Badge variant={statusVariant(task.status)}>{task.status}</Badge> },
          { label: "Task", value: task.id.slice(0, 8) },
          { label: "Elapsed", value: task.totalDurationMs ? formatDuration(task.totalDurationMs) : task.startedAt ? formatDuration(Date.now() - task.startedAt) : "\u2014" },
          { label: "Spend", value: task.costUsd != null ? formatCost(task.costUsd) : "\u2014" },
        ]}
        actions={
          <>
            <Link to="/work" className="inline-flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
              <ArrowLeft size={ICON_SIZE.sm} /> Back to Tasks
            </Link>
            {canCancel && (
              <Button variant="destructive" size="sm" onClick={() => void handleCancel()} disabled={cancelling}>
                <Ban size={ICON_SIZE.sm} />
                {cancelling ? "Cancelling..." : "Cancel Task"}
              </Button>
            )}
          </>
        }
      />

      {/* Tab toggle */}
      <div className="flex gap-1 border-b border-[var(--app-border)]" data-testid="task-detail-tabs">
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "overview"
              ? "border-[var(--app-accent)] text-[var(--app-accent)]"
              : "border-transparent text-[var(--app-muted)] hover:text-[var(--app-fg)]"
          }`}
          onClick={() => setTab("overview")}
          data-testid="tab-overview"
        >
          Overview
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === "artifacts"
              ? "border-[var(--app-accent)] text-[var(--app-accent)]"
              : "border-transparent text-[var(--app-muted)] hover:text-[var(--app-fg)]"
          }`}
          onClick={() => setTab("artifacts")}
          data-testid="tab-artifacts"
        >
          Artifacts
        </button>
      </div>

      {tab === "artifacts" && (
        <div data-testid="artifacts-tab-content">
          <ArtifactList
            artifacts={artifacts}
            selectedId={selectedArtifactId}
            onSelect={setSelectedArtifactId}
            loading={artifactsLoading}
            error={artifactsError}
          />
          {selectedArtifactId && (() => {
            const selected = artifacts.find((a) => a.id === selectedArtifactId);
            if (!selected) return null;
            return (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                data-testid="artifact-modal-backdrop"
                onClick={() => setSelectedArtifactId(null)}
              >
                <div
                  className="bg-[var(--app-bg)] rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ArtifactDetail
                    artifact={selected}
                    onDeleted={() => {
                      setSelectedArtifactId(null);
                      setArtifacts((prev) => prev.filter((a) => a.id !== selectedArtifactId));
                    }}
                    onRedelivered={() => {}}
                  />
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === "overview" && (
      <>
      {/* Task header */}
      <Card className="surface-accent text-white">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-kicker text-white/70">Summary</p>
            <p className="mt-2 text-base leading-7 text-white">
              {task.prompt.length > 220 && !showPrompt ? `${task.prompt.slice(0, 220)}…` : task.prompt}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {task.prompt.length > 220 ? (
              <Button variant="secondary" size="sm" onClick={() => setShowPrompt((value) => !value)}>
                <FileText size={ICON_SIZE.sm} />
                {showPrompt ? "Collapse prompt" : "Show full prompt"}
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => setShowDiagnostics((value) => !value)}>
              <ShieldAlert size={ICON_SIZE.sm} />
              {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
            </Button>
          </div>
        </div>
      </Card>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetaCard icon={Clock} label="Created" value={formatDateTime(task.createdAt)} />
        <MetaCard
          icon={Clock}
          label="Duration"
          value={task.totalDurationMs ? formatDuration(task.totalDurationMs) : task.startedAt ? formatDuration(Date.now() - task.startedAt) : "\u2014"}
        />
        <MetaCard icon={DollarSign} label="Cost" value={task.costUsd != null ? formatCost(task.costUsd) : "\u2014"} />
        <MetaCard icon={Hash} label="Turns" value={String(task.numTurns ?? "\u2014")} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetaCard icon={User} label="Role" value={task.roleId ?? "\u2014"} mono />
        <MetaCard icon={Layers} label="Parent" value={task.parentId ?? "\u2014"} mono />
        {task.templateId ? (
          <Link to="/work" className="block">
            <MetaCard icon={Layers} label="Template" value={task.templateId} mono />
            <span className="mt-0.5 block text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)]">View in Automations &rarr;</span>
          </Link>
        ) : (
          <MetaCard icon={Layers} label="Template" value={"\u2014"} mono />
        )}
        {task.sourceSessionId && (
          <MetaCard icon={Hash} label="Source Session" value={task.sourceSessionId.slice(0, 8)} mono />
        )}
      </div>

      {/* Delivery targets */}
      {(task.deliverTo || task.reportTo) && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Delivery Targets</CardTitle>
              <CardDescription>Where results and status updates are sent after execution.</CardDescription>
            </div>
          </CardHeader>
          <div className="space-y-3">
            {task.deliverTo && task.deliverTo.length > 0 && (
              <div>
                <p className="text-xs text-[var(--app-text-subtle)] mb-1">Output</p>
                <div className="space-y-1">
                  {task.deliverTo.map((t, i) => (
                    <div key={`d-${i}`} className="flex items-center gap-2 text-sm text-[var(--app-text)]">
                      <Badge variant="outline">{t.type === "channel" ? "Channel" : "Session"}</Badge>
                      {t.type === "channel" ? (
                        <>
                          <span className="font-mono text-xs">{t.channelId.slice(0, 8)}</span>
                          {t.chatId && <span className="text-xs text-[var(--app-text-subtle)]">chat: {t.chatId.slice(0, 8)}</span>}
                        </>
                      ) : (
                        <span className="text-xs text-[var(--app-text-muted)]">session {t.sessionId?.slice(0, 8)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {task.reportTo && task.reportTo.length > 0 && (
              <div>
                <p className="text-xs text-[var(--app-text-subtle)] mb-1">Status Reports</p>
                <div className="space-y-1">
                  {task.reportTo.map((t, i) => (
                    <div key={`r-${i}`} className="flex items-center gap-2 text-sm text-[var(--app-text)]">
                      <Badge variant="outline">{t.type === "channel" ? "Channel" : "Session"}</Badge>
                      {t.type === "channel" ? (
                        <>
                          <span className="font-mono text-xs">{t.channelId.slice(0, 8)}</span>
                          {t.chatId && <span className="text-xs text-[var(--app-text-subtle)]">chat: {t.chatId.slice(0, 8)}</span>}
                        </>
                      ) : (
                        <span className="text-xs text-[var(--app-text-muted)]">session {t.sessionId?.slice(0, 8)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Quality Score */}
      {taskScore && (task.status === "completed" || task.status === "failed") && (
        <ScoreBreakdownCard score={taskScore} />
      )}

      {/* Token usage */}
      {task.tokenUsage && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Token Usage</CardTitle>
              <CardDescription>Input and output token totals for this execution.</CardDescription>
            </div>
          </CardHeader>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-[var(--app-text-subtle)]">Input:</span>{" "}
              <span className="font-mono text-[var(--app-text)]">{task.tokenUsage.input.toLocaleString()}</span>
            </div>
            <div>
              <span className="text-[var(--app-text-subtle)]">Output:</span>{" "}
              <span className="font-mono text-[var(--app-text)]">{task.tokenUsage.output.toLocaleString()}</span>
            </div>
          </div>
        </Card>
      )}

      {/* Execution Plan */}
      {plans.length > 0 && (() => {
        const taskPlan = plans[0];
        const riskColor = taskPlan.plan.overallRisk === "high" ? "destructive"
          : taskPlan.plan.overallRisk === "medium" ? "warning" : "secondary";
        return (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div>
                  <CardTitle>Execution Plan</CardTitle>
                  <CardDescription>Expected steps, risk, and permissions before execution.</CardDescription>
                </div>
                <Badge variant={riskColor as "destructive" | "warning" | "secondary"}>
                  {taskPlan.plan.overallRisk.toUpperCase()} RISK
                </Badge>
                <Badge variant="outline">{taskPlan.status}</Badge>
              </div>
            </CardHeader>

            <h4 className="text-sm font-medium text-[var(--app-text)] mb-2">
              Plan Steps ({taskPlan.plan.steps.length})
            </h4>
            <div className="space-y-2">
              {taskPlan.plan.steps.map((step) => (
                <div key={step.index} className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)]/50 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-[var(--app-text-subtle)]">#{step.index}</span>
                      <span className="text-sm text-[var(--app-text)]">{step.description}</span>
                    </div>
                    <Badge variant={step.riskLevel === "high" ? "destructive" : step.riskLevel === "medium" ? "warning" : "secondary"}>
                      {step.riskLevel}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-[var(--app-text-muted)]">
                    Tools: {step.toolsNeeded.join(", ") || "none"}
                  </div>
                  {step.expectedOutput && (
                    <div className="mt-0.5 text-xs text-[var(--app-text-subtle)]">Expected: {step.expectedOutput}</div>
                  )}
                </div>
              ))}
            </div>

            {Object.keys(taskPlan.plan.requiredPermissions).length > 0 && (
              <div className="mt-2">
                <p className="text-sm font-medium text-[var(--app-text)] mb-1">Required Permissions</p>
                <div className="flex flex-wrap gap-1">
                  {Object.keys(taskPlan.plan.requiredPermissions).map((perm) => (
                    <Badge key={perm} variant="secondary">{perm}</Badge>
                  ))}
                </div>
              </div>
            )}

            {taskPlan.deviationReport && (
              <div className="mt-3 rounded-md border border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg-subtle)] p-3">
                <p className="text-sm font-medium text-[var(--app-warning)] mb-2">Deviation Report</p>
                <div className="text-xs text-[var(--app-text-muted)] mb-2">
                  Planned: {taskPlan.deviationReport.stepsPlanned} |
                  Executed: {taskPlan.deviationReport.stepsExecuted} |
                  Accuracy: {(taskPlan.deviationReport.overallAccuracy * 100).toFixed(0)}%
                </div>
                {taskPlan.deviationReport.deviations.length > 0 && (
                  <div className="space-y-1">
                    {taskPlan.deviationReport.deviations.map((d, i) => (
                      <div key={i} className="text-xs">
                        <span className="text-[var(--app-warning)] font-mono">[{d.deviationType}]</span>
                        <span className="text-[var(--app-text-muted)]"> Step {d.stepIndex}: </span>
                        <span className="text-[var(--app-text)]">{d.actual}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {taskPlan.learnedRules && taskPlan.learnedRules.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-medium text-[var(--app-text)] mb-2">Learned Rules</p>
                <ul className="space-y-1">
                  {taskPlan.learnedRules.map((rule, i) => (
                    <li key={i} className="text-xs text-[var(--app-text-muted)] flex items-start gap-1.5">
                      <span className="text-[var(--app-accent)] mt-0.5">*</span>
                      {rule}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        );
      })()}

      {/* Execution Timeline */}
      {stepLogs.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Execution Timeline ({stepLogs.length} steps)</CardTitle>
              <CardDescription>Ordered execution events, tool calls, and error markers.</CardDescription>
            </div>
          </CardHeader>
          <ExecutionTimeline logs={stepLogs} />
        </Card>
      )}

      {/* Result */}
      {task.result && (
        <Card>
          <CardHeader>
            <div className="flex w-full items-center justify-between gap-3">
              <div>
                <CardTitle>Result</CardTitle>
                <CardDescription>The final task output. Raw text stays collapsed until needed.</CardDescription>
              </div>
              {task.result.length > 360 ? (
                <Button variant="ghost" size="sm" onClick={() => setShowResult((value) => !value)}>
                  {showResult ? "Collapse" : "Expand"}
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--app-panel-elevated)] p-3 font-mono text-xs text-[var(--app-text)]">
            {task.result.length > 360 && !showResult ? `${task.result.slice(0, 360)}…` : task.result}
          </pre>
        </Card>
      )}

      {/* Error */}
      {task.error && (() => {
        const pluginKeywords = ["plugin", "--plugin-dir", "failed to load plugin"];
        const lowerError = task.error.toLowerCase();
        const isPluginError = pluginKeywords.some((kw) => lowerError.includes(kw));
        const pluginLine = isPluginError
          ? task.error.split("\n").find((l) => pluginKeywords.some((kw) => l.toLowerCase().includes(kw)))
          : null;

        return (
          <Card className={isPluginError ? "border-[var(--app-danger)]" : ""}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <div>
                  <CardTitle>Error</CardTitle>
                  <CardDescription>Execution failed or returned an error condition.</CardDescription>
                </div>
                {isPluginError && <Badge variant="warning">Plugin Issue</Badge>}
              </div>
            </CardHeader>
            {isPluginError && pluginLine && (
              <div className="mb-2 rounded bg-[var(--app-warning-soft-bg-subtle)] px-2 py-1 text-xs text-[var(--app-warning)]">
                {pluginLine}
              </div>
            )}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--app-danger-soft-bg-subtle)] p-3 font-mono text-xs text-[var(--app-danger)]">
              {task.error}
            </pre>
          </Card>
        );
      })()}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>{diagnosticsSummary}</CardDescription>
          </div>
        </CardHeader>
        {showDiagnostics ? (
          deliveryLog.length > 0 ? (
            <div className="space-y-4">
              <SectionHeader title="Delivery Log" description="Recent delivery attempts and outcomes." />
              <div className="space-y-2">
                {deliveryLog.map((entry) => {
                  const deliveryVariant = entry.status === "delivered" ? "success" as const
                    : entry.status === "pending" ? "secondary" as const
                    : "destructive" as const;
                  const targetLabel = entry.target.type === "webhook"
                    ? entry.target.webhookUrl
                    : entry.target.type === "channel"
                      ? `channel ${entry.target.channelId.slice(0, 8)}`
                      : `session ${entry.target.sessionId?.slice(0, 8)}`;
                  return (
                    <div key={entry.id} className="surface-panel-muted rounded-lg px-3 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={deliveryVariant}>{entry.status}</Badge>
                        <span className="font-mono text-xs text-[var(--app-text-subtle)]">{targetLabel}</span>
                        {entry.messageType ? (
                          <span className="text-xs text-[var(--app-text-subtle)]">({entry.messageType})</span>
                        ) : null}
                      </div>
                      {entry.error ? (
                        <p className="mt-2 text-xs text-[var(--app-danger-soft-text)]">{entry.error}</p>
                      ) : null}
                      <p className="mt-2 text-xs text-[var(--app-text-subtle)]">
                        {formatDateTime(entry.createdAt)}
                        {entry.deliveredAt && ` \u2192 ${formatDateTime(entry.deliveredAt)}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="surface-panel-muted rounded-lg px-4 py-4 text-sm text-[var(--app-text-subtle)]">
              No delivery events recorded yet.
            </div>
          )
        ) : (
          <div className="surface-panel-muted rounded-lg px-4 py-4 text-sm text-[var(--app-text-subtle)]">
            Diagnostics are hidden by default because this section can contain raw execution details and operational data.
          </div>
        )}
      </Card>
      </>
      )}
    </div>
  );
}

function ScoreBreakdownCard({ score }: { score: RoleScoreRecord }) {
  const dims = [
    { label: "Task Success", value: score.scores.taskSuccess, weight: "25%" },
    { label: "Plan Accuracy", value: score.scores.planAccuracy, weight: "20%" },
    { label: "Permission Compliance", value: score.scores.permissionCompliance, weight: "20%" },
    { label: "Efficiency", value: score.scores.efficiency, weight: "15%" },
    { label: "Intent Fulfillment", value: score.scores.intentFulfillment, weight: "20%", pending: score.scores.intentFulfillment == null },
  ];

  return (
    <Card>
      <CardHeader><CardTitle>Quality Score</CardTitle></CardHeader>
      <div className="space-y-3">
        {dims.map((d) => (
          <div key={d.label}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-[var(--app-text-muted)]">{d.label} <span className="text-[var(--app-text-subtle)]">({d.weight})</span></span>
              {d.pending ? (
                <span className="text-[var(--app-text-subtle)]" title="Intent eval pending or failed">—</span>
              ) : (
                <span className="font-mono text-[var(--app-text)]">{((d.value ?? 0) * 100).toFixed(0)}%</span>
              )}
            </div>
            {!d.pending && d.value != null && (
              <div className="h-1.5 w-full rounded-full bg-[var(--app-panel-elevated)]">
                <div className={`h-full rounded-full ${d.value < 0.4 ? "bg-[var(--app-danger)]" : "bg-[var(--app-accent)]"}`} style={{ width: `${d.value * 100}%` }} />
              </div>
            )}
          </div>
        ))}
        <div className="mt-2 flex items-center justify-between border-t border-[var(--app-border)] pt-2">
          <span className="text-sm text-[var(--app-text)]">Weighted Score</span>
          <span className="font-mono text-sm font-semibold text-[var(--app-text)]">{(score.scores.weighted * 100).toFixed(0)}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--app-text)]">EMA (after this task)</span>
          <span className={`font-mono text-sm font-semibold ${score.emaScore < 0.4 ? "text-[var(--app-danger)]" : "text-[var(--app-success)]"}`}>
            {(score.emaScore * 100).toFixed(0)}%
          </span>
        </div>
      </div>
    </Card>
  );
}

function MetaCard({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[var(--app-text-subtle)]">
        <Icon size={12} />
        <span className="text-xs">{label}</span>
      </div>
      <span className={`text-sm text-[var(--app-text)] truncate ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </Card>
  );
}
