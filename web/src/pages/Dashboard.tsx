import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  ListTodo,
  AlertCircle,
  CircleDollarSign,
  Activity,
  Circle,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card.tsx";
import { Badge, statusVariant } from "@/components/ui/Badge.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { useShallow } from "zustand/react/shallow";
import { timeAgo, truncate, formatCost } from "@/lib/format.ts";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";

export function Dashboard() {
  const statusMarkerSize = 10;
  const { tasks, goals, roles, stats, readiness, executionPool } = useAppStore(
    useShallow((s) => ({
      tasks: s.tasks,
      goals: s.goals,
      roles: s.roles,
      stats: s.stats,
      readiness: s.readiness,
      executionPool: s.executionPool,
    })),
  );
  const fetchTasks = useAppStore((s) => s.fetchTasks);
  const fetchGoals = useAppStore((s) => s.fetchGoals);
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const fetchExecutionPool = useAppStore((s) => s.fetchExecutionPool);

  useEffect(() => {
    void fetchTasks();
    void fetchGoals();
    void fetchRoles();
    void fetchExecutionPool();
    const interval = setInterval(() => {
      void fetchTasks();
      void fetchExecutionPool();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks, fetchGoals, fetchRoles, fetchExecutionPool]);

  const activeTasks = tasks.filter((t) => t.status === "running").length;
  const queuedTasks = tasks.filter((t) => t.status === "queued" || t.status === "pending").length;
  const failedTasks = tasks.filter((t) => t.status === "failed").length;
  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => b.createdAt - a.createdAt), [tasks]);
  const recentTasks = useMemo(() => sortedTasks.slice(0, 4), [sortedTasks]);
  const urgentTask = useMemo(() => {
    const failed = sortedTasks.find((task) => task.status === "failed");
    if (failed) return failed;
    const running = sortedTasks.find((task) => task.status === "running");
    if (running) return running;
    return sortedTasks[0];
  }, [sortedTasks]);
  const healthChecks = useMemo(
    () => (readiness ? Object.entries(readiness.checks) : []),
    [readiness],
  );
  const healthyChecks = useMemo(
    () => healthChecks.filter(([, ok]) => ok).length,
    [healthChecks],
  );
  const urgentRoleName = urgentTask?.roleId
    ? roles.find((r) => r.id === urgentTask.roleId)?.name ?? urgentTask.roleId.slice(0, 8)
    : "Unassigned";
  const heroCta = urgentTask ? `/tasks/${urgentTask.id}` : "/work";
  const heroCtaLabel = urgentTask ? "Open task" : "Open work";
  const heroSummary =
    !urgentTask
      ? "Queue work, review recent runs, or launch an automation."
      : urgentTask.status === "failed"
        ? "Review the failed task before queueing more work."
        : urgentTask.status === "running"
          ? "Track this active run and its next result."
          : "Use the latest completed run as the starting point for follow-up work.";

  const heroSurface = !urgentTask
    ? "surface-panel-muted"
    : urgentTask.status === "failed"
      ? "surface-critical"
      : urgentTask.status === "running"
        ? "surface-accent"
        : "surface-panel-elevated";

  const heroTone: "accent" | "critical" | "neutral" =
    heroSurface === "surface-critical"
      ? "critical"
      : heroSurface === "surface-accent"
        ? "accent"
        : "neutral";

  const heroIsInverted = heroTone === "accent" || heroTone === "critical";
  const heroTitleClass = heroIsInverted ? "text-white" : "text-[var(--app-text)]";
  const heroKickerClass = heroIsInverted ? "text-white/70" : "text-[var(--app-text-subtle)]";
  const heroDescriptionClass = heroIsInverted ? "text-white/76" : "text-[var(--app-text-muted)]";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Queue health, execution readiness, and the next task that needs attention."
        metrics={[
          { label: "Server", value: readiness?.status === "ready" ? "Ready" : "Attention" },
          { label: "Running", value: stats.activeTasks || activeTasks },
          { label: "Queued", value: stats.queuedTasks || queuedTasks },
          { label: "Goals", value: goals.length },
          { label: "Execution Pool", value: `${executionPool.active}/${executionPool.max} | ${executionPool.queued} queued` },
        ]}
        compact
        className="px-4 py-3 lg:px-4 lg:py-3"
        actions={
          readiness ? (
            <span role="status" aria-live="polite">
              <Badge variant={readiness.status === "ready" ? "success" : "destructive"}>
                {readiness.status === "ready" ? "Server Ready" : "Not Ready"}
              </Badge>
            </span>
          ) : null
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card className={`${heroSurface} self-start ${heroIsInverted ? "text-white" : ""}`}>
          <CardHeader className="mb-2">
            <div>
              <p className={`text-kicker ${heroKickerClass}`}>Current Focus</p>
              <CardTitle className={`mt-2 ${heroTitleClass}`}>
                {urgentTask ? truncate(urgentTask.prompt, 92) : "No active blockers"}
              </CardTitle>
            </div>
            {urgentTask ? <Badge variant={statusVariant(urgentTask.status)}>{urgentTask.status}</Badge> : null}
          </CardHeader>
          <CardDescription className={heroDescriptionClass}>{heroSummary}</CardDescription>
          <div className="mt-4 grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
            <FocusMetric tone={heroTone} label="Created" value={urgentTask ? timeAgo(urgentTask.createdAt) : "Idle"} />
            <FocusMetric tone={heroTone} label="Cost" value={urgentTask?.costUsd != null ? formatCost(urgentTask.costUsd) : "No cost"} />
            <FocusMetric tone={heroTone} label="Role" value={urgentRoleName} />
            <Link
              to={heroCta}
              className={`inline-flex items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                heroIsInverted
                  ? "border-white/20 bg-white/10 text-white hover:bg-white/14"
                  : "border-[var(--app-border)] bg-white/[0.05] text-[var(--app-text)] hover:border-[var(--app-border-strong)]"
              }`}
            >
              {heroCtaLabel}
            </Link>
          </div>
        </Card>

        <Card className="surface-panel-elevated self-start">
          <SectionHeader
            title="System Checks"
            description={`${healthyChecks}/${healthChecks.length || 0} checks passing`}
            compact
          />
          {readiness ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {Object.entries(readiness.checks).map(([name, ok]) => (
                <div
                  key={name}
                  className="surface-panel-muted flex items-center justify-between rounded-lg px-3 py-3"
                >
                  <div className="flex items-center gap-2">
                    {/* status marker - non-icon size, intentionally 10px */}
                    <Circle
                      size={statusMarkerSize}
                      className={ok ? "fill-[var(--app-success)] text-[var(--app-success)]" : "fill-[var(--app-danger)] text-[var(--app-danger)]"}
                    />
                    <span className="text-sm capitalize text-[var(--app-text)]">{name}</span>
                  </div>
                  <span className="text-xs text-[var(--app-text-subtle)]">{ok ? "healthy" : "attention"}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-xs text-[var(--app-text-subtle)]">Loading...</span>
          )}
        </Card>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="region" aria-label="Server statistics">
        <StatCard icon={ListTodo} label="Active Tasks" value={stats.activeTasks || activeTasks} color="text-[var(--app-accent)]" />
        {(() => {
          const activeCount = roles.filter(r => r.status === "active").length;
          const total = roles.length;
          const probationCount = roles.filter(r => r.status === "probation").length;
          const retiredCount = roles.filter(r => r.status === "retired").length;
          const exceptions = [
            probationCount > 0 ? `${probationCount} probation` : "",
            retiredCount > 0 ? `${retiredCount} retired` : "",
          ].filter(Boolean).join(" · ");
          const value = exceptions ? `${activeCount}/${total} | ${exceptions}` : `${activeCount}/${total}`;
          return (
            <StatCard icon={Activity} label="Role Health" value={value}
              color={retiredCount > 0 ? "text-[var(--app-danger)]" : probationCount > 0 ? "text-[var(--app-warning)]" : "text-[var(--app-success)]"} />
          );
        })()}
        <StatCard icon={AlertCircle} label="Failed" value={failedTasks} color="text-[var(--app-danger)]" />
        <StatCard icon={CircleDollarSign} label="Cost Today" value={formatCost(stats.totalCostToday)} color="text-[var(--app-accent-strong)]" />
      </div>

      {/* Recent tasks */}
      <Card padding={false}>
        <div className="px-4 pt-4">
          <SectionHeader
            title="Recent Tasks"
            description="Latest executions across the control plane."
            action={
              <Link to="/work" className="text-sm font-medium text-[var(--app-accent-strong)] hover:underline">
                View all
              </Link>
            }
          />
        </div>
        <div className="mt-4 space-y-3 px-4 pb-4">
          {recentTasks.length === 0 ? (
            <div className="surface-panel-muted rounded-lg px-4 py-6 text-sm text-[var(--app-text-subtle)]">
              No tasks yet
            </div>
          ) : (
            recentTasks.map((task) => (
              <Link
                key={task.id}
                to={`/tasks/${task.id}`}
                className="surface-panel-muted flex flex-col gap-3 rounded-lg px-4 py-4 transition-colors hover:border-[var(--app-border-strong)] hover:bg-white/[0.05] lg:flex-row lg:items-start lg:justify-between"
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                    <span className="font-mono text-xs text-[var(--app-text-subtle)]">{task.id.slice(0, 8)}</span>
                    {task.roleId ? <span className="text-xs text-[var(--app-text-subtle)]">role {task.roleId.slice(0, 12)}</span> : null}
                  </div>
                  <div className="text-sm font-medium text-[var(--app-text)]">{truncate(task.prompt, 128)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--app-text-subtle)]">
                  <span>{timeAgo(task.createdAt)}</span>
                  <span>{task.costUsd != null ? formatCost(task.costUsd) : "no cost"}</span>
                </div>
              </Link>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof ListTodo;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <Card className="surface-panel-muted flex items-center gap-3">
      <div className={`rounded-lg bg-white/[0.05] p-3 ${color}`}>
        <Icon size={16} />
      </div>
      <div>
        <div className="text-xl font-semibold text-[var(--app-text)]">{value}</div>
        <div className="text-xs uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">{label}</div>
      </div>
    </Card>
  );
}

function FocusMetric({
  label,
  value,
  tone = "accent",
}: {
  label: string;
  value: string | number;
  tone?: "accent" | "critical" | "neutral";
}) {
  const isInverted = tone === "accent" || tone === "critical";
  const containerClass = isInverted
    ? "rounded-lg border border-white/12 bg-black/10 px-3 py-3"
    : "surface-focus-metric rounded-lg px-3 py-3";
  const labelClass = isInverted
    ? "text-[10px] uppercase tracking-[0.16em] text-white/62"
    : "text-[10px] uppercase tracking-[0.16em] text-[var(--app-text-subtle)]";
  const valueClass = isInverted
    ? "mt-1 text-lg font-semibold text-white"
    : "mt-1 text-lg font-semibold text-[var(--app-text)]";
  return (
    <div className={containerClass}>
      <div className={labelClass}>{label}</div>
      <div className={valueClass}>{value}</div>
    </div>
  );
}
