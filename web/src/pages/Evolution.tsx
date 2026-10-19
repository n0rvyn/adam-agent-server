import { useEffect, useState, useCallback } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { api } from "@/lib/api.ts";
import { timeAgo } from "@/lib/format.ts";

interface EvolutionRecord {
  id: string;
  timestamp: number;
  oldRules: string;
  newRules: string;
  diff: string;
  triggerTaskId?: string;
  roleId?: string;
}

export function Evolution() {
  const roles = useAppStore((s) => s.roles);
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const [records, setRecords] = useState<EvolutionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<string>("all");

  useEffect(() => {
    void fetchRoles();
  }, [fetchRoles]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (roleFilter !== "all") params.set("roleId", roleFilter);
      const data = await api<EvolutionRecord[]>(`/evolution-audit?${params}`);
      setRecords(data);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [roleFilter]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const getRoleName = (roleId?: string) => {
    if (!roleId) return "System";
    return roles.find((r) => r.id === roleId)?.name ?? roleId.slice(0, 8);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Learning"
        title="Evolution Audit"
        compact
        description="Rule mutations and diagnostic reports across roles."
        metrics={[
          { label: "Visible", value: records.length },
          { label: "Role Filter", value: roleFilter === "all" ? "All" : getRoleName(roleFilter) },
          { label: "Catalog", value: roles.length },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">All roles</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <Button variant="ghost" size="sm" onClick={() => void loadRecords()}>
              <RefreshCw size={14} />
            </Button>
          </div>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
          </div>
        ) : records.length === 0 ? (
          <EmptyState
            icon={<GitBranch size={32} />}
            title="No evolution records"
            description="Evolution occurs when roles accumulate enough task experience."
            className="py-8"
          />
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-[var(--app-text-subtle)]">{records.length} records</p>
            {records.map((record) => (
              <div key={record.id} className="rounded border border-[var(--app-border)] p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="info">{getRoleName(record.roleId)}</Badge>
                  <span className="text-xs text-[var(--app-text-subtle)]">{timeAgo(record.timestamp)}</span>
                  {record.triggerTaskId && (
                    <span className="text-[10px] text-[var(--app-text-subtle)]">
                      triggered by task {record.triggerTaskId.slice(0, 8)}
                    </span>
                  )}
                </div>
                {record.diff.includes("--- Diagnostic Report ---") ? (
                  <div className="space-y-2">
                    <div className="rounded bg-[var(--app-canvas)] p-2">
                      <p className="mb-1 text-[10px] font-medium text-[var(--app-text-muted)]">Diagnostic Report</p>
                      <pre className="whitespace-pre-wrap font-mono text-xs text-[var(--app-text-muted)]">
                        {record.diff.split("--- Rules Diff ---")[0]?.replace("--- Diagnostic Report ---\n", "").trim()}
                      </pre>
                    </div>
                    <div className="rounded bg-[var(--app-canvas)] p-2">
                      <p className="mb-1 text-[10px] font-medium text-[var(--app-text-muted)]">Rules Changes</p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">
                        {(record.diff.split("--- Rules Diff ---")[1] ?? "").trim().split("\n").map((line, i) => (
                          <span
                            key={i}
                            className={
                              line.startsWith("+")
                                ? "text-[var(--app-success)]"
                                : line.startsWith("-")
                                  ? "text-[var(--app-danger)]"
                                  : "text-[var(--app-text-muted)]"
                            }
                          >
                            {line}
                            {"\n"}
                          </span>
                        ))}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--app-canvas)] p-2 font-mono text-xs">
                    {record.diff.split("\n").map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith("+")
                            ? "text-[var(--app-success)]"
                            : line.startsWith("-")
                              ? "text-[var(--app-danger)]"
                              : "text-[var(--app-text-muted)]"
                        }
                      >
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
