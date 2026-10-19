import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Ban, Check, ListTodo, Plus, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge, statusVariant } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { timeAgo, truncate, formatCost } from "@/lib/format.ts";
import { api } from "@/lib/api.ts";
import type { TaskStatus } from "@/lib/types.ts";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { useIsMobileLayout } from "@/lib/useIsMobileLayout.ts";
import { ICON_SIZE } from "@/lib/ui.ts";

const STATUS_FILTERS: Array<{ label: string; value: TaskStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Running", value: "running" },
  { label: "Pending", value: "pending" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Blocked", value: "blocked" },
];

const CANCELLABLE = new Set<string>(["pending", "queued", "running", "paused"]);

export function Tasks() {
  const tasks = useAppStore((s) => s.tasks);
  const fetchTasks = useAppStore((s) => s.fetchTasks);
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);
  const isMobile = useIsMobileLayout();

  useEffect(() => {
    const status = filter === "all" ? undefined : filter;
    void fetchTasks(status);
    const interval = setInterval(() => void fetchTasks(status), 5000);
    return () => clearInterval(interval);
  }, [fetchTasks, filter]);

  // Clear selection when filter changes
  useEffect(() => {
    setSelected(new Set());
  }, [filter]);

  const handleCreate = async () => {
    if (!prompt.trim()) return;
    setCreating(true);
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      setPrompt("");
      setShowCreate(false);
      void fetchTasks(filter === "all" ? undefined : filter);
    } finally {
      setCreating(false);
    }
  };

  const toggleSelect = (taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const selectAllCancellable = () => {
    const cancellableIds = sortedTasks.filter((t) => CANCELLABLE.has(t.status)).map((t) => t.id);
    setSelected(new Set(cancellableIds));
  };

  const handleBatchCancel = async () => {
    if (selected.size === 0) return;
    setCancelling(true);
    try {
      await api<{ cancelled: number }>("/tasks/batch-cancel", {
        method: "POST",
        body: JSON.stringify({ taskIds: Array.from(selected) }),
      });
      setSelected(new Set());
      void fetchTasks(filter === "all" ? undefined : filter);
    } finally {
      setCancelling(false);
    }
  };

  const sortedTasks = [...tasks].sort((a, b) => b.createdAt - a.createdAt);
  const selectedCancellable = Array.from(selected).filter((id) => {
    const task = tasks.find((t) => t.id === id);
    return task && CANCELLABLE.has(task.status);
  });
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Tasks"
        description="Review active execution, cancel work, or create the next task."
        compact
        action={
          <div className="flex gap-2">
            {selected.size > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleBatchCancel()}
                disabled={cancelling || selectedCancellable.length === 0}
              >
                <Ban size={ICON_SIZE.sm} />
                {cancelling ? "Cancelling..." : `Cancel ${selectedCancellable.length} task${selectedCancellable.length !== 1 ? "s" : ""}`}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => void fetchTasks(filter === "all" ? undefined : filter)}>
              <RefreshCw size={ICON_SIZE.sm} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
              <Plus size={ICON_SIZE.sm} />
              New Task
            </Button>
          </div>
        }
      />

      {/* Create task form */}
      {showCreate && (
        <Card className="flex gap-2">
          <input
            className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Enter task prompt..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
          />
          <Button onClick={() => void handleCreate()} disabled={creating || !prompt.trim()}>
            {creating ? "Creating..." : "Create"}
          </Button>
          <Button variant="ghost" onClick={() => setShowCreate(false)}>
            Cancel
          </Button>
        </Card>
      )}

      {/* Status filter */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? "bg-[var(--app-panel-elevated)] text-[var(--app-text)]"
                  : "text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {sortedTasks.some((t) => CANCELLABLE.has(t.status)) && (
            <button
              onClick={selectAllCancellable}
              className="text-xs text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
            >
              Select all cancellable
            </button>
          )}
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
            >
              Clear selection ({selected.size})
            </button>
          )}
        </div>
      </div>

      {/* Task table */}
      {sortedTasks.length === 0 ? (
        <Card padding={false}>
          <EmptyState
            icon={<ListTodo size={32} />}
            title="No tasks found"
            description={filter !== "all" ? `No tasks with status "${filter}"` : "Create a task to get started"}
          />
        </Card>
      ) : isMobile ? (
        <div className="space-y-3">
          {sortedTasks.map((task) => (
            <Card key={task.id} className={selected.has(task.id) ? "border-[var(--app-accent)]/40 bg-[var(--app-accent)]/8" : ""}>
              <div className="flex items-start gap-3">
                <div className="pt-1">
                  {CANCELLABLE.has(task.status) ? (
                    <button
                      onClick={() => toggleSelect(task.id)}
                      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                        selected.has(task.id)
                          ? "border-[var(--app-accent-strong)] bg-[var(--app-accent)] text-white"
                          : "border-[var(--app-border-strong)] bg-transparent hover:border-[var(--app-text-muted)]"
                      }`}
                    >
                      {selected.has(task.id) && <Check size={12} />}
                    </button>
                  ) : (
                    <span className="inline-block h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <Link
                        to={`/tasks/${task.id}`}
                        className="break-all font-mono text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)]"
                      >
                        {task.id.slice(0, 8)}
                      </Link>
                      <p className="break-words text-sm font-medium leading-6 text-[var(--app-text)]">{truncate(task.prompt, 140)}</p>
                    </div>
                    <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                  </div>
                  <div className="grid gap-2 text-xs text-[var(--app-text-subtle)] sm:grid-cols-3">
                    <div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Role</span>
                      <div className="mt-1 font-mono text-[var(--app-text)]">{task.roleId ? task.roleId.slice(0, 12) : "\u2014"}</div>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Cost</span>
                      <div className="mt-1 font-mono text-[var(--app-text)]">{task.costUsd != null ? formatCost(task.costUsd) : "\u2014"}</div>
                    </div>
                    <div>
                      <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Created</span>
                      <div className="mt-1 text-[var(--app-text)]">{timeAgo(task.createdAt)}</div>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card padding={false}>
          <Table>
            <Thead>
              <Tr>
                <Th className="w-8">
                  <button
                    onClick={() => {
                      if (selected.size > 0 && selected.size === sortedTasks.filter((t) => CANCELLABLE.has(t.status)).length) {
                        setSelected(new Set());
                      } else {
                        selectAllCancellable();
                      }
                    }}
                    className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                      selected.size > 0 && selected.size === sortedTasks.filter((t) => CANCELLABLE.has(t.status)).length
                        ? "border-[var(--app-accent-strong)] bg-[var(--app-accent)] text-white"
                        : "border-[var(--app-border-strong)] bg-transparent hover:border-[var(--app-text-muted)]"
                    }`}
                  >
                    {selected.size > 0 && selected.size === sortedTasks.filter((t) => CANCELLABLE.has(t.status)).length && <Check size={12} />}
                  </button>
                </Th>
                <Th>ID</Th>
                <Th>Prompt</Th>
                <Th>Status</Th>
                <Th>Role</Th>
                <Th>Cost</Th>
                <Th>Created</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sortedTasks.map((task) => (
                <Tr key={task.id} className={selected.has(task.id) ? "bg-[var(--app-panel-elevated)]/50" : ""}>
                  <Td>
                    {CANCELLABLE.has(task.status) ? (
                      <button
                        onClick={() => toggleSelect(task.id)}
                        className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                          selected.has(task.id)
                            ? "border-[var(--app-accent-strong)] bg-[var(--app-accent)] text-white"
                            : "border-[var(--app-border-strong)] bg-transparent hover:border-[var(--app-text-muted)]"
                        }`}
                      >
                        {selected.has(task.id) && <Check size={12} />}
                      </button>
                    ) : (
                      <span className="inline-block w-4" />
                    )}
                  </Td>
                  <Td>
                    <Link
                      to={`/tasks/${task.id}`}
                      className="font-mono text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)]"
                    >
                      {task.id.slice(0, 8)}
                    </Link>
                  </Td>
                  <Td>
                    <div className="space-y-1">
                      <div className="break-words font-medium text-[var(--app-text)]">{truncate(task.prompt, 120)}</div>
                      <div className="text-xs text-[var(--app-text-subtle)]">
                        {task.totalDurationMs ? formatCost(task.costUsd ?? 0) : "Awaiting completion"} · {timeAgo(task.createdAt)}
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-[var(--app-text-subtle)]">
                      {task.roleId ? task.roleId.slice(0, 12) : "\u2014"}
                    </span>
                  </Td>
                  <Td className="font-mono text-xs">
                    {task.costUsd != null ? formatCost(task.costUsd) : "\u2014"}
                  </Td>
                  <Td className="text-xs text-[var(--app-text-subtle)]">{timeAgo(task.createdAt)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
