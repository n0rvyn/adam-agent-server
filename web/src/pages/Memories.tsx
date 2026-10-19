import { useEffect, useState, useCallback } from "react";
import { Brain, Search, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { api } from "@/lib/api.ts";
import { timeAgo } from "@/lib/format.ts";

interface MemoryNode {
  id: string;
  agentId: string;
  type: string;
  content: string;
  keywords: string[];
  importance: number;
  sourceType: string;
  sourceTaskId?: string;
  evidence?: string[];
  createdAt: number;
  lastAccessed: number;
  retrievedCount: number;
  score?: number;
}

export function Memories() {
  const roles = useAppStore((s) => s.roles);
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [importanceFilter, setImportanceFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [expandedEvidence, setExpandedEvidence] = useState<Set<string>>(new Set());

  useEffect(() => {
    void fetchRoles();
  }, [fetchRoles]);

  // Auto-select first role
  useEffect(() => {
    if (!selectedAgentId && roles.length > 0) {
      setSelectedAgentId(roles[0].id);
    }
  }, [roles, selectedAgentId]);

  const loadMemories = useCallback(async () => {
    if (!selectedAgentId) return;
    setLoading(true);
    try {
      const data = await api<{ memories: MemoryNode[] }>(`/memories/${selectedAgentId}?limit=100`);
      setMemories(data.memories);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  useEffect(() => {
    if (selectedAgentId) {
      void loadMemories();
    }
  }, [selectedAgentId, loadMemories]);

  const handleSearch = async () => {
    if (!searchQuery.trim() || !selectedAgentId) return;
    setIsSearching(true);
    try {
      const data = await api<{ memories: MemoryNode[] }>("/memories/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          prompt: searchQuery.trim(),
          topK: 20,
        }),
      });
      setMemories(data.memories);
    } catch {
      setMemories([]);
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    void loadMemories();
  };

  const filteredMemories = memories.filter((m) => {
    if (importanceFilter === "high") return m.importance > 3;
    if (importanceFilter === "medium") return m.importance === 3;
    if (importanceFilter === "low") return m.importance < 3;
    return true;
  });

  const importanceColor = (imp: number) => {
    if (imp >= 4) return "text-[var(--app-danger)]";
    if (imp === 3) return "text-[var(--app-warning)]";
    return "text-[var(--app-text-subtle)]";
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Knowledge"
        title="Memories"
        compact
        description="What each role is retaining and how retrieval changes the visible recall set."
        metrics={[
          { label: "Role", value: roles.find((role) => role.id === selectedAgentId)?.name ?? "None" },
          { label: "Visible", value: filteredMemories.length },
          { label: "High Importance", value: memories.filter((memory) => memory.importance > 3).length },
        ]}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void loadMemories()}>
            <RefreshCw size={14} />
          </Button>
        }
      />

      <SectionHeader
        title="Recall Controls"
        compact
        description="Switch role context, run a retrieval query, or narrow by importance."
      />

      {/* Controls */}
      <Card className="surface-panel-muted">
        <div className="flex flex-wrap items-center gap-3">
        <select
          className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>

        <div className="flex items-center gap-1.5">
          <input
            className="w-64 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] placeholder-slate-600 focus:border-[var(--app-accent)] focus:outline-none"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
            placeholder="Search memories..."
          />
          <Button size="sm" variant="ghost" onClick={() => void handleSearch()} disabled={isSearching}>
            <Search size={14} />
          </Button>
          {searchQuery && (
            <Button size="sm" variant="ghost" onClick={clearSearch}>
              Clear
            </Button>
          )}
        </div>

        <div className="flex gap-1">
          {(["all", "high", "medium", "low"] as const).map((level) => (
            <button
              key={level}
              className={`rounded px-2 py-1 text-xs transition-colors ${
                importanceFilter === level
                  ? "bg-[var(--app-accent)] text-white"
                  : "bg-[var(--app-panel-elevated)] text-[var(--app-text-muted)] hover:bg-[var(--app-panel-muted)]"
              }`}
              onClick={() => setImportanceFilter(level)}
            >
              {level}
            </button>
          ))}
        </div>
        </div>
      </Card>

      {/* Memory list */}
      <Card>
        {loading || isSearching ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
          </div>
        ) : filteredMemories.length === 0 ? (
          <EmptyState
            icon={<Brain size={32} />}
            title="No memories"
            description={searchQuery ? "No results for this query" : "This agent has no memories yet"}
            className="py-8"
          />
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-[var(--app-text-subtle)]">{filteredMemories.length} memories</p>
            {filteredMemories.map((mem) => (
              <div key={mem.id} className="rounded border border-[var(--app-border)] p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge variant={mem.type === "reflection" ? "info" : mem.type === "thought" ? "warning" : "muted"}>
                    {mem.type}
                  </Badge>
                  <Badge variant="muted">{mem.sourceType}</Badge>
                  <span className={`text-xs font-medium ${importanceColor(mem.importance)}`}>
                    {"*".repeat(mem.importance)}
                  </span>
                  {mem.score != null && (
                    <span className="text-[10px] text-[var(--app-text-subtle)]">score: {mem.score.toFixed(3)}</span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm text-[var(--app-text)]">{mem.content}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {mem.keywords.map((kw) => (
                    <span key={kw} className="rounded bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-subtle)]">{kw}</span>
                  ))}
                </div>
                {mem.type === "reflection" && mem.evidence && mem.evidence.length > 0 && (
                  <div className="mt-2">
                    <button
                      className="text-[10px] text-[var(--app-accent)] hover:text-[var(--app-accent)]"
                      onClick={() => setExpandedEvidence(prev => {
                        const next = new Set(prev);
                        next.has(mem.id) ? next.delete(mem.id) : next.add(mem.id);
                        return next;
                      })}
                    >
                      {expandedEvidence.has(mem.id) ? "Hide" : "Show"} evidence ({mem.evidence.length} memories)
                    </button>
                    {expandedEvidence.has(mem.id) && (
                      <div className="mt-1.5 space-y-1 border-l-2 border-[var(--app-border)] pl-2">
                        {mem.evidence.map((evidenceId) => {
                          const evidenceMem = memories.find(m => m.id === evidenceId);
                          return (
                            <div key={evidenceId} className="text-xs text-[var(--app-text-subtle)]">
                              {evidenceMem
                                ? evidenceMem.content.slice(0, 120) + (evidenceMem.content.length > 120 ? "..." : "")
                                : <span className="italic">Memory {evidenceId.slice(0, 8)} (not in current view)</span>
                              }
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                <p className="mt-1.5 text-[10px] text-[var(--app-text-subtle)]">
                  {timeAgo(mem.createdAt)} | accessed {mem.retrievedCount}x | last: {timeAgo(mem.lastAccessed)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
