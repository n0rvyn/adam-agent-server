import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Plus, X } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { timeAgo } from "@/lib/format.ts";
import { toast } from "sonner";
import { useIsMobileLayout } from "@/lib/useIsMobileLayout.ts";


export function Roles() {
  const roles = useAppStore((s) => s.roles);
  const fetchRoles = useAppStore((s) => s.fetchRoles);
  const createRole = useAppStore((s) => s.createRole);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCagPrompt, setCreateCagPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const isMobile = useIsMobileLayout();

  const load = useCallback(async () => {
    setLoading(true);
    await fetchRoles();
    setLoading(false);
  }, [fetchRoles]);

  const resetCreateForm = () => {
    setCreateName("");
    setCreateCagPrompt("");
    setCreateError(null);
    setCreating(false);
  };

  const handleCreateRole = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError("Name is required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await createRole({ name, cagPrompt: createCagPrompt.trim() });
      await fetchRoles();
      setShowCreate(false);
      resetCreateForm();
      toast.success("Role created");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create role");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const statusVariant = (s: string): "success" | "secondary" | "destructive" | "warning" => {
    if (s === "active") return "success";
    if (s === "inactive") return "secondary";
    if (s === "retired") return "destructive";
    if (s === "probation") return "warning";
    return "secondary";
  };

  const activeRoles = roles.filter((role) => role.status === "active").length;
  const probationRoles = roles.filter((role) => role.status === "probation").length;
  const linkedStreams = roles.filter((role) => role.memoryStreamId).length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Identities"
        title="Roles"
        description="Registry for role status, memory linkage, and edit actions."
        metrics={[
          { label: "Active", value: activeRoles },
          { label: "Probation", value: probationRoles },
          { label: "Linked Memory", value: linkedStreams },
        ]}
        compact
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} />
              New Role
            </Button>
          </>
        }
      />

      <SectionHeader
        title="Registry"
        description="Open a role to inspect prompts, performance, and bindings."
        compact
        action={<div className="text-xs text-[var(--app-text-subtle)]">{roles.length} role{roles.length === 1 ? "" : "s"}</div>}
      />

      {roles.length === 0 && !loading ? (
        <Card>
          <EmptyState
            title="No roles yet"
            description="Create a role to define agent behavior and bind plugins."
          />
        </Card>
      ) : (
        isMobile ? (
          <div className="space-y-3">
            {roles.map((role) => (
              <Card key={role.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      to={`/roles/${role.id}`}
                      className="font-medium text-[var(--app-accent)] hover:text-[var(--app-accent)]"
                    >
                      {role.name}
                    </Link>
                    {role.presetId && (
                      <Badge variant="info">Preset</Badge>
                    )}
                    <p className="text-xs text-[var(--app-text-subtle)]">{timeAgo(role.createdAt)}</p>
                  </div>
                  <Badge variant={statusVariant(role.status)}>{role.status}</Badge>
                </div>
                <div className="mt-4 grid gap-2 text-xs text-[var(--app-text-subtle)] sm:grid-cols-2">
                  <div>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Score</span>
                    <div className="mt-1 font-mono text-[var(--app-text)]">
                      {role.performanceScore != null ? `${(role.performanceScore * 100).toFixed(0)}%` : "\u2014"}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Memory</span>
                    <div className="mt-1 text-[var(--app-text)]">{role.memoryStreamId ? role.memoryStreamId.slice(0, 8) : "\u2014"}</div>
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
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Score</Th>
                  <Th>Memories</Th>
                  <Th>Created</Th>
                </Tr>
              </Thead>
              <Tbody>
                {roles.map((role) => (
                  <Tr key={role.id}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/roles/${role.id}`}
                          className="font-medium text-[var(--app-accent)] hover:text-[var(--app-accent)]"
                        >
                          {role.name}
                        </Link>
                        {role.presetId && (
                          <Badge variant="info">Preset</Badge>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <Badge variant={statusVariant(role.status)}>{role.status}</Badge>
                    </Td>
                    <Td>
                      {role.performanceScore != null ? (
                        <span className="font-mono text-xs text-[var(--app-text)]">
                          {(role.performanceScore * 100).toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-[var(--app-text-subtle)]">—</span>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-[var(--app-text-muted)]">
                        {role.memoryStreamId ? role.memoryStreamId.slice(0, 8) : "\u2014"}
                      </span>
                    </Td>
                    <Td className="text-xs text-[var(--app-text-subtle)]">{timeAgo(role.createdAt)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Card>
        )
      )}

      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowCreate(false); resetCreateForm(); } }}
        >
          <div className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--app-text)]">Create Role</h2>
              <button
                className="text-[var(--app-text-muted)] hover:text-[var(--app-text)]"
                onClick={() => { setShowCreate(false); resetCreateForm(); }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--app-text)]" htmlFor="role-name">
                  Name <span className="text-[var(--app-danger)]">*</span>
                </label>
                <input
                  id="role-name"
                  className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-2 text-sm text-[var(--app-text)] placeholder-slate-500 focus:border-[var(--app-accent)] focus:outline-none"
                  placeholder="e.g. Engineer, Reviewer"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleCreateRole(); }}
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--app-text)]" htmlFor="role-cag-prompt">
                  CAG Prompt
                </label>
                <textarea
                  id="role-cag-prompt"
                  className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-2 text-sm text-[var(--app-text)] placeholder-slate-500 focus:border-[var(--app-accent)] focus:outline-none"
                  placeholder="Character and Guidance prompt for this role..."
                  rows={5}
                  value={createCagPrompt}
                  onChange={(e) => setCreateCagPrompt(e.target.value)}
                />
              </div>

              {createError && (
                <p className="text-sm text-[var(--app-danger)]">{createError}</p>
              )}

              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setShowCreate(false); resetCreateForm(); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleCreateRole()}
                  disabled={creating}
                >
                  {creating ? "Creating..." : "Create"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
