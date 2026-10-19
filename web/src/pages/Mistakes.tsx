import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import {
  listMistakePatterns,
  updateMistakePattern,
  type MistakePattern,
  type MistakePatternStatus,
} from "@/lib/api.ts";

const STATUS_VARIANTS: Record<MistakePatternStatus, "success" | "secondary" | "destructive" | "warning" | "muted"> = {
  new: "muted",
  acknowledged: "success",
  dismissed: "secondary",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86_400_000);
  return `${days}d ago`;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function Mistakes() {
  const [patterns, setPatterns] = useState<MistakePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<MistakePatternStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchPatterns = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listMistakePatterns(filterStatus === "all" ? undefined : filterStatus);
      setPatterns(data);
    } catch {
      setPatterns([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    void fetchPatterns();
  }, [fetchPatterns]);

  const handleStatusChange = async (id: string, status: MistakePatternStatus) => {
    setUpdating(id);
    try {
      await updateMistakePattern(id, status);
      await fetchPatterns();
    } finally {
      setUpdating(null);
    }
  };

  const statuses: Array<MistakePatternStatus | "all"> = ["all", "new", "acknowledged", "dismissed"];

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Mistake Patterns"
        description="Cross-role failure patterns extracted from audit data."
        compact
        action={
          <Button variant="ghost" size="sm" onClick={() => void fetchPatterns()}>
            Refresh
          </Button>
        }
      />

      {/* Status filter */}
      <div className="flex gap-2">
        {statuses.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilterStatus(s)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              filterStatus === s
                ? "bg-[var(--app-accent)] text-white"
                : "bg-[var(--app-panel-elevated)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
            }`}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <Card>
          <p className="text-sm text-[var(--app-text-muted)]">Loading...</p>
        </Card>
      ) : patterns.length === 0 ? (
        <Card>
          <EmptyState
            title="No mistake patterns"
            description="Run the Mistake Digest template to aggregate failure signals from audit data."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => (
            <Card key={p.id} padding={false}>
              <div
                className="p-4 cursor-pointer hover:bg-black/[0.02]"
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setExpandedId(expandedId === p.id ? null : p.id); }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={STATUS_VARIANTS[p.status]}>{p.status}</Badge>
                      <span className="text-xs text-[var(--app-text-subtle)]">{timeAgo(p.lastSeen)}</span>
                      <span className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-muted)] font-mono">
                        {p.dimensionType}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-[var(--app-text)]">
                      {p.dimensionValue}
                    </p>
                    <p className="text-xs text-[var(--app-text-muted)]">
                      {p.count} occurrence{p.count !== 1 ? "s" : ""} across {p.roleIds.length} role{p.roleIds.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === p.id && (
                <div className="border-t border-[var(--app-border)] p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">
                        Dimension
                      </p>
                      <p className="text-sm text-[var(--app-text)] font-mono">{p.dimensionType}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">
                        Dimension Value
                      </p>
                      <p className="text-sm text-[var(--app-text)] font-mono break-all">{p.dimensionValue}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">
                        Affected Roles
                      </p>
                      <p className="text-sm text-[var(--app-text)]">
                        {p.roleIds.length > 0 ? p.roleIds.join(", ") : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">
                        Evidence Items
                      </p>
                      <p className="text-sm text-[var(--app-text)]">
                        {p.sampleEvidenceIds.length > 0 ? (
                          <span className="flex flex-col gap-0.5">
                            {p.sampleEvidenceIds.slice(0, 5).map((ev) => (
                              <span key={ev.id} className="text-xs">
                                <span className="rounded border border-[var(--app-border)] px-1 py-0.5 text-[10px] font-mono">
                                  {ev.source}
                                </span>{" "}
                                {ev.id}
                              </span>
                            ))}
                            {p.sampleEvidenceIds.length > 5 && (
                              <span className="text-xs text-[var(--app-text-subtle)]">
                                +{p.sampleEvidenceIds.length - 5} more
                              </span>
                            )}
                          </span>
                        ) : "—"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 pt-1">
                    <p className="text-xs text-[var(--app-text-subtle)]">
                      First seen: {formatTs(p.firstSeen)}
                    </p>
                    <p className="text-xs text-[var(--app-text-subtle)]">
                      Last seen: {formatTs(p.lastSeen)}
                    </p>
                  </div>
                  {/* Status actions */}
                  <div className="flex gap-2 pt-1">
                    {(["new", "acknowledged", "dismissed"] as MistakePatternStatus[]).map((s) => (
                      <Button
                        key={s}
                        variant={p.status === s ? "default" : "ghost"}
                        size="sm"
                        disabled={updating === p.id || p.status === s}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleStatusChange(p.id, s);
                        }}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
