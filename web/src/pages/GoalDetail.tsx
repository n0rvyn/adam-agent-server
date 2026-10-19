import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Target, Clock, DollarSign, Layers } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { api } from "@/lib/api.ts";
import type { Goal } from "@/lib/types.ts";
import { formatDateTime } from "@/lib/format.ts";

interface Strategy {
  id: string;
  name: string;
  role: string;
  taskType: string;
}

export function GoalDetail() {
  const { id } = useParams<{ id: string }>();
  const [goal, setGoal] = useState<Goal | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        const data = await api<{ goal: Goal }>(`/goals/${id}`);
        setGoal(data.goal);
        setError(null);
        // Fetch strategies filtered by goal's role
        try {
          const sData = await api<{ strategies: Strategy[] }>(`/strategies?role=${data.goal.roleId}`);
          setStrategies(sData.strategies ?? []);
        } catch { /* strategies fetch is non-fatal */ }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load goal");
      }
    };
    void load();
  }, [id]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/goals" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Goals
        </Link>
        <Card className="text-center text-[var(--app-danger)]">{error}</Card>
      </div>
    );
  }

  if (!goal) {
    return (
      <div className="space-y-4">
        <Link to="/goals" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Goals
        </Link>
        <Card className="text-center text-[var(--app-text-subtle)]">Loading...</Card>
      </div>
    );
  }

  const progress = goal.targetValue > 0 ? Math.min(100, (goal.currentValue / goal.targetValue) * 100) : 0;
  const isOverdue = goal.deadline > 0 && goal.deadline < Date.now() && goal.status !== "completed";

  const statusVariant = (s: string) => {
    if (s === "completed") return "success";
    if (s === "executing" || s === "evaluating") return "warning";
    if (s === "failed") return "destructive";
    return "secondary";
  };

  return (
    <div className="space-y-5">
      <Link to="/goals" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
        <ArrowLeft size={14} /> Back to Goals
      </Link>

      <PageHeader
        eyebrow="Goal"
        title={goal.name}
        compact
        description={goal.description || "Progress, delivery targets, and strategy support before raw metrics."}
        metrics={[
          { label: "Status", value: <Badge variant={statusVariant(goal.status) as "success" | "warning" | "destructive" | "secondary"}>{goal.status}</Badge> },
          { label: "Role", value: goal.roleId },
          { label: "Metric", value: goal.metricType },
          { label: "Progress", value: `${progress.toFixed(1)}%` },
        ]}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <Card className="surface-panel-muted">
          <p className="text-section-label">Goal ID</p>
          <p className="mt-2 truncate font-mono text-sm text-[var(--app-text)]">{goal.id}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Current delta</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{Math.max(goal.targetValue - goal.currentValue, 0)}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Strategies in play</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{strategies.length}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Deadline state</p>
          <p className={`mt-2 text-sm font-medium ${isOverdue ? "text-[var(--app-danger-soft-text)]" : "text-[var(--app-text)]"}`}>
            {isOverdue ? "Overdue" : "On track"}
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetaCard icon={Target} label="Progress" value={`${goal.currentValue} / ${goal.targetValue}`} />
        <MetaCard icon={Clock} label={isOverdue ? "Overdue" : "Deadline"} value={formatDateTime(goal.deadline)} mono />
        <MetaCard icon={DollarSign} label="Budget" value={`$${goal.budgetUsd.toFixed(2)}`} />
        <MetaCard icon={Layers} label="Created" value={formatDateTime(goal.createdAt)} mono />
      </div>

      <SectionHeader
        title="Progress"
        compact
        description="Completion first, then delivery targets and strategy support."
      />

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
        </CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-3 rounded-full bg-[var(--app-panel-muted)] overflow-hidden">
            <div
              className={`h-full rounded-full transition-[width] ${isOverdue ? "bg-[var(--app-danger)]" : "bg-[var(--app-accent)]"}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-[var(--app-text)] font-mono">{progress.toFixed(1)}%</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-[var(--app-text-subtle)]">
          <span>{goal.currentValue} current</span>
          <span>{goal.targetValue} target</span>
        </div>
      </Card>

      {(goal.deliverTo ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Delivery Targets</CardTitle>
          </CardHeader>
          <div className="space-y-1.5">
            {(goal.deliverTo ?? []).map((target, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-[var(--app-text)]">
                {target.type === "channel" ? (
                  <>
                    <Badge variant="outline">Channel</Badge>
                    <span className="font-mono text-xs">{target.channelId.slice(0, 8)}</span>
                    {target.chatId && (
                      <span className="text-xs text-[var(--app-text-subtle)]">chat: {target.chatId.slice(0, 8)}</span>
                    )}
                  </>
                ) : (
                  <>
                    <Badge variant="outline">Session</Badge>
                    <span className="text-xs text-[var(--app-text-muted)]">Chat session</span>
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {strategies.length > 0 && (
        <>
          <SectionHeader
            title="Strategy Support"
            compact
            description="Strategy candidates already associated with the goal's role."
          />
          <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Layers size={14} /> Strategies ({strategies.length})</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            {strategies.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-sm border-b border-[var(--app-border)] pb-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[var(--app-text)]">{s.name}</span>
                  <span className="text-xs text-[var(--app-text-subtle)]">{s.taskType}</span>
                </div>
              </div>
            ))}
          </div>
          </Card>
        </>
      )}
    </div>
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
