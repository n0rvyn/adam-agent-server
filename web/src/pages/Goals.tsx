import { useEffect, useState, type ReactNode } from "react";
import { Target, Plus, RefreshCw, Pencil, Trash2, Play, X, Pause } from "lucide-react";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card.tsx";
import { Badge, statusVariant } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/AlertDialog";
import { useAppStore } from "@/store/useAppStore.ts";
import { formatDateTime, formatCost } from "@/lib/format.ts";
import { api } from "@/lib/api.ts";
import type { GoalStatus, NotifyTarget } from "@/lib/types.ts";
import { NotifyTargetSelector } from "@/components/ui/NotifyTargetSelector.tsx";

const nextStatus: Record<GoalStatus, GoalStatus> = {
  active: "paused",
  paused: "active",
  completed: "active",
  failed: "active",
};

const statusIcon: Partial<Record<GoalStatus, ReactNode>> = {
  active: <Pause size={12} />,
  paused: <Play size={12} />,
  completed: <RefreshCw size={12} />,
  failed: <RefreshCw size={12} />,
};

export function Goals() {
  const goals = useAppStore((s) => s.goals);
  const fetchGoals = useAppStore((s) => s.fetchGoals);
  const storeUpdateGoal = useAppStore((s) => s.updateGoal);
  const storeDeleteGoal = useAppStore((s) => s.deleteGoal);
  const [showCreate, setShowCreate] = useState(false);
  const [input, setInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDeliverTo, setEditDeliverTo] = useState<NotifyTarget[]>([]);
  const [editReportTo, setEditReportTo] = useState<NotifyTarget[]>([]);
  const [deliverTo, setDeliverTo] = useState<NotifyTarget[]>([]);
  const [reportTo, setReportTo] = useState<NotifyTarget[]>([]);
  const activeCount = goals.filter((goal) => goal.status === "active").length;
  const pausedCount = goals.filter((goal) => goal.status === "paused").length;
  const completedCount = goals.filter((goal) => goal.status === "completed").length;

  useEffect(() => {
    void fetchGoals();
    const interval = setInterval(() => void fetchGoals(), 10_000);
    return () => clearInterval(interval);
  }, [fetchGoals]);

  const handleCreate = async () => {
    if (!input.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api("/goals", {
        method: "POST",
        body: JSON.stringify({ input: input.trim(), deliverTo: deliverTo.length > 0 ? deliverTo : undefined, reportTo: reportTo.length > 0 ? reportTo : undefined }),
      });
      setInput("");
      setShowCreate(false);
      void fetchGoals();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create goal");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations"
        title="Goals"
        compact
        description="Long-running outcomes, budgets, and delivery targets."
        metrics={[
          { label: "Active", value: activeCount },
          { label: "Paused", value: pausedCount },
          { label: "Completed", value: completedCount },
        ]}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void fetchGoals()}>
              <RefreshCw size={14} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
              <Plus size={14} />
              New Goal
            </Button>
          </div>
        }
      />

      {showCreate && (
        <Card className="space-y-3">
          <textarea
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-2 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Describe your goal in natural language..."
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <NotifyTargetSelector
            value={deliverTo}
            onChange={setDeliverTo}
            label="Deliver To (results)"
          />
          <NotifyTargetSelector
            value={reportTo}
            onChange={setReportTo}
            label="Report To (status)"
          />
          {createError && (
            <p className="text-xs text-[var(--app-danger)]">{createError}</p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => void handleCreate()} disabled={creating || !input.trim()}>
              {creating ? "Creating..." : "Create"}
            </Button>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {goals.length === 0 ? (
        <EmptyState
          icon={<Target size={32} />}
          title="No goals"
          description="Create a goal to start goal-driven task orchestration"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((goal) => {
            const progress = goal.targetValue > 0
              ? Math.min(100, Math.round((goal.currentValue / goal.targetValue) * 100))
              : 0;
            const deadlineDate = new Date(goal.deadline);
            const isOverdue = deadlineDate.getTime() < Date.now() && goal.status !== "completed";
            const isEditing = editingId === goal.id;

            return (
              <Card key={goal.id}>
                <CardHeader>
                  {isEditing ? (
                    <input
                      className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                  ) : (
                    <CardTitle className="max-w-full text-[var(--app-text)] text-sm font-medium truncate sm:max-w-[180px]">
                      {goal.name}
                    </CardTitle>
                  )}
                  <Badge variant={statusVariant(goal.status)}>{goal.status}</Badge>
                </CardHeader>

                {isEditing ? (
                  <textarea
                    className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-1 text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none mb-3"
                    placeholder="Description..."
                    rows={2}
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                  />
                ) : goal.description ? (
                  <p className="text-xs text-[var(--app-text-muted)] mb-3 line-clamp-2">{goal.description}</p>
                ) : null}

                {isEditing && (
                  <div className="mb-3 space-y-2">
                    <NotifyTargetSelector value={editDeliverTo} onChange={setEditDeliverTo} label="Deliver To (results)" />
                    <NotifyTargetSelector value={editReportTo} onChange={setEditReportTo} label="Report To (status)" />
                  </div>
                )}

                {/* Progress bar */}
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-[var(--app-text-subtle)]">Progress</span>
                    <span className="font-mono text-xs text-[var(--app-text)]">{progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--app-panel-elevated)]">
                    <div
                      className={`h-full rounded-full transition-[width] ${
                        progress >= 100 ? "bg-[var(--app-success)]" : "bg-[var(--app-accent)]"
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="font-mono text-[10px] text-[var(--app-text-subtle)]">
                      {goal.currentValue} / {goal.targetValue}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--app-text-subtle)]">{goal.metricType}</span>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--app-text-subtle)]">Role</span>
                    <Badge variant="muted" className="text-[10px]">{goal.roleId}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--app-text-subtle)]">Budget</span>
                    <span className="font-mono text-[var(--app-text)]">{formatCost(goal.budgetUsd)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className={`text-[var(--app-text-subtle)] ${isOverdue ? "text-[var(--app-danger)]" : ""}`}>Deadline</span>
                    <span className={`text-[var(--app-text)] ${isOverdue ? "text-[var(--app-danger)]" : ""}`}>
                      {formatDateTime(goal.deadline)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--app-text-subtle)]">Created</span>
                    <span className="text-[var(--app-text-muted)]">{formatDateTime(goal.createdAt)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 mt-3 pt-3 border-t border-[var(--app-border)]">
                  {isEditing ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await storeUpdateGoal(goal.id, {
                              name: editName,
                              description: editDescription,
                              deliverTo: editDeliverTo,
                              reportTo: editReportTo,
                            });
                            setEditingId(null);
                            toast.success("Goal updated");
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed to update");
                          }
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X size={14} />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Edit"
                        onClick={() => {
                          setEditingId(goal.id);
                          setEditName(goal.name);
                          setEditDescription(goal.description ?? "");
                          setEditDeliverTo(goal.deliverTo ?? []);
                          setEditReportTo(goal.reportTo ?? []);
                        }}
                      >
                        <Pencil size={14} />
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        title={`Change to ${nextStatus[goal.status]}`}
                        onClick={async () => {
                          try {
                            await storeUpdateGoal(goal.id, { status: nextStatus[goal.status] });
                            toast.success(`Status changed to ${nextStatus[goal.status]}`);
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : "Failed to update status");
                          }
                        }}
                      >
                        {statusIcon[goal.status] ?? <Play size={12} />}
                        <span className="text-xs">{nextStatus[goal.status]}</span>
                      </Button>

                      <div className="ml-auto">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button size="sm" variant="ghost" title="Delete" className="text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]">
                              <Trash2 size={14} />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete goal</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete "{goal.name}". This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-[var(--app-danger)] hover:bg-[var(--app-danger-strong)]"
                                onClick={async () => {
                                  try {
                                    await storeDeleteGoal(goal.id);
                                    toast.success("Goal deleted");
                                  } catch (e) {
                                    toast.error(e instanceof Error ? e.message : "Failed to delete");
                                  }
                                }}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
