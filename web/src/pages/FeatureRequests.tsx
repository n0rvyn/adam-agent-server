import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { api } from "@/lib/api.ts";
import type { FeatureRequestStatus } from "@/lib/api.ts";

interface FeatureRequest {
  id: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  extractedAt: number;
  extractedByRoleId?: string;
  content: string;
  summary?: string;
  status: FeatureRequestStatus;
  tags?: string[];
  evidenceQuote?: string;
  createdAt: number;
  updatedAt: number;
}

const STATUS_VARIANTS: Record<FeatureRequestStatus, "success" | "secondary" | "destructive" | "warning" | "muted"> = {
  new: "muted",
  reviewed: "success",
  dismissed: "secondary",
  converted: "warning",
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

export function FeatureRequests() {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FeatureRequestStatus | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (filterStatus !== "all") params.set("status", filterStatus);
      const data = await api<{ featureRequests: FeatureRequest[] }>(
        `/feature-requests?${params}`,
      );
      setRequests(data.featureRequests);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  const handleStatusChange = async (id: string, status: FeatureRequestStatus) => {
    setUpdating(id);
    try {
      await api(`/feature-requests/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await fetchRequests();
    } finally {
      setUpdating(null);
    }
  };

  const statuses: Array<FeatureRequestStatus | "all"> = ["all", "new", "reviewed", "dismissed", "converted"];

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Feature Requests"
        description="Unmet user needs identified by the Feature Miner role."
        compact
        action={
          <Button variant="ghost" size="sm" onClick={() => void fetchRequests()}>
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
      ) : requests.length === 0 ? (
        <Card>
          <EmptyState
            title="No feature requests"
            description="Run the Feature Mining template to extract unmet needs from chat sessions."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {requests.map((req) => (
            <Card key={req.id} padding={false}>
              <div
                className="p-4 cursor-pointer hover:bg-black/[0.02]"
                onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") setExpandedId(expandedId === req.id ? null : req.id); }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANTS[req.status]}>{req.status}</Badge>
                      <span className="text-xs text-[var(--app-text-subtle)]">{timeAgo(req.extractedAt)}</span>
                      {req.tags && req.tags.length > 0 && (
                        <div className="flex gap-1">
                          {req.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-muted)]"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {req.summary ? (
                      <p className="text-sm font-medium text-[var(--app-text)]">{req.summary}</p>
                    ) : null}
                    <p className="text-sm text-[var(--app-text-muted)] line-clamp-2">{req.content}</p>
                  </div>
                </div>
              </div>

              {/* Expanded detail */}
              {expandedId === req.id && (
                <div className="border-t border-[var(--app-border)] p-4 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">Content</p>
                    <p className="text-sm text-[var(--app-text)]">{req.content}</p>
                  </div>
                  {req.evidenceQuote && (
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">Evidence Quote</p>
                      <blockquote className="border-l-2 border-[var(--app-border)] pl-3 text-sm text-[var(--app-text-muted)] italic">
                        {req.evidenceQuote}
                      </blockquote>
                    </div>
                  )}
                  {req.tags && req.tags.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-[var(--app-text-subtle)] uppercase tracking-[0.14em] mb-1">Tags</p>
                      <div className="flex flex-wrap gap-1">
                        {req.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-0.5 text-xs text-[var(--app-text)]"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <p className="text-xs text-[var(--app-text-subtle)]">
                      Extracted: {new Date(req.extractedAt).toLocaleString()}
                    </p>
                    {req.sourceSessionId && (
                      <p className="text-xs text-[var(--app-text-subtle)]">
                        Session: {req.sourceSessionId.slice(0, 8)}
                      </p>
                    )}
                  </div>
                  {/* Status actions */}
                  <div className="flex gap-2 pt-1">
                    {(["new", "reviewed", "dismissed", "converted"] as FeatureRequestStatus[]).map((s) => (
                      <Button
                        key={s}
                        variant={req.status === s ? "default" : "ghost"}
                        size="sm"
                        disabled={updating === req.id || req.status === s}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleStatusChange(req.id, s);
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
