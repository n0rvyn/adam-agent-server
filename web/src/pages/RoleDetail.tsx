import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft, Plus, Lock } from "lucide-react";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { RoleProjectPlugins } from "@/components/plugins/RoleProjectPlugins.tsx";
import { EnvVarEditor } from "@/components/EnvVarEditor.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { Switch } from "@/components/ui/Switch.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { LineChart, Line, XAxis, YAxis, ReferenceLine, Tooltip, ResponsiveContainer } from "recharts";
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
import { api, listRoleExtensions, bindRoleExtension, unbindRoleExtension, patchRoleExtension, listExtensions, type RoleExtensionBinding, type ExtensionHealth } from "@/lib/api.ts";
import type { Extension } from "@/lib/api.ts";
import { usePluginMutations } from "@/hooks/usePluginMutations.ts";
import { usePluginsWithUsage } from "@/hooks/usePluginsWithUsage.ts";
import { useAppStore } from "@/store/useAppStore.ts";
import { useIsMobileLayout } from "@/lib/useIsMobileLayout.ts";
import { ICON_SIZE } from "@/lib/ui.ts";
import type {
  Role,
  Task,
  RoleScoreRecord,
  AdditionalDirectoryEntry,
  ResolvedOsCapabilityMeta,
  RoleConfigCapabilities,
  LearnedRules,
} from "@/lib/types.ts";
import { formatDateTime, timeAgo, formatCost } from "@/lib/format.ts";
import { BUILT_IN_TOOLS } from "@/lib/constants.ts";

const AUTOMATION_TARGET_BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

interface ConfigResponse {
  config: Record<string, { value: unknown; mutable: boolean }>;
  mutable: string[];
  restartRequired: string[];
  sandbox: { platform: string; available: boolean };
  osCapabilities: RoleConfigCapabilities;
}

function SandboxStatusBar() {
  const [sandboxInfo, setSandboxInfo] = useState<{ platform: string; available: boolean } | null>(null);

  useEffect(() => {
    api<ConfigResponse>("/config")
      .then(({ sandbox }) => {
        if (sandbox) setSandboxInfo(sandbox);
      })
      .catch(() => {/* ignore */});
  }, []);

  if (!sandboxInfo) return null;

  const label =
    sandboxInfo.platform === "sandbox-exec"
      ? "macOS sandbox-exec"
      : sandboxInfo.platform === "landlock"
      ? "Linux Landlock"
      : "unavailable";

  const active = sandboxInfo.available;
  return (
    <div className={`px-4 py-2 text-xs font-medium border-b ${
      active
        ? "border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] text-[var(--app-success-soft-text)]"
        : "border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] text-[var(--app-warning-soft-text)]"
    }`}>
      {active ? "🔒" : "⚠️"} Sandbox:{" "}
      {active ? `active (${label})` : `${label} — filesystem isolation not enforced`}
    </div>
  );
}

interface DiscoveredPlugin {
  id: string;
  name: string;
  version: string;
  scope: string;
  installPath: string;
  enabled: boolean;
}

interface EvolutionEntry {
  id: string;
  roleId: string;
  source: string;
  trigger?: string;
  previousScore?: number;
  newScore?: number;
  diffSummary?: string;
  createdAt: number;
}

interface MemoryEntry {
  id: string;
  roleId?: string;
  content: string;
  importance?: number;
  createdAt: number;
}

interface BeliefEntry {
  id: string;
  roleId: string;
  content: string;
  successEma?: number;
  injectCount: number;
  status: "active" | "archived";
  isAnti: boolean;
  lastUsedAt: number;
  createdAt: number;
}

export function RoleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobileLayout();
  const [role, setRole] = useState<Role | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string>("");
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [beliefs, setBeliefs] = useState<BeliefEntry[]>([]);
  const [evolution, setEvolution] = useState<EvolutionEntry[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scores, setScores] = useState<RoleScoreRecord[]>([]);
  const [contractCompliance, setContractCompliance] = useState<{
    emaScore: number | null;
    recentViolations: import("@/lib/types").AuditViolation[];
    contractsCheckedRowCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingCag, setEditingCag] = useState(false);
  const [cagValue, setCagValue] = useState("");
  const [savingCag, setSavingCag] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoringPreset, setRestoringPreset] = useState(false);
  const updateRole = useAppStore((s) => s.updateRole);
  const deleteRole = useAppStore((s) => s.deleteRole);
  const { rawPlugins } = usePluginsWithUsage();

  const loadRole = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<{ role: Role; projectPlugins: DiscoveredPlugin[]; workspacePath: string }>(`/roles/${id}`);
      setRole(data.role);
      setCagValue(data.role.cagPrompt);
      setWorkspacePath(data.workspacePath);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load role");
    }
  }, [id]);

  const loadMemories = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<{ memories: MemoryEntry[] }>(`/memories/${id}`);
      setMemories(data.memories ?? []);
    } catch {
      setMemories([]);
    }
  }, [id]);

  const loadBeliefs = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<{ beliefs: BeliefEntry[] }>(`/roles/${id}/beliefs`);
      setBeliefs(data.beliefs ?? []);
    } catch {
      setBeliefs([]);
    }
  }, [id]);

  const loadEvolution = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<EvolutionEntry[] | { entries: EvolutionEntry[] }>(`/evolution-audit?roleId=${id}`);
      setEvolution(Array.isArray(data) ? data : (data.entries ?? []));
    } catch {
      setEvolution([]);
    }
  }, [id]);

  const loadScores = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<{
        scores: RoleScoreRecord[];
        latestEma: number | null;
        contractCompliance: {
          emaScore: number | null;
          recentViolations: import("@/lib/types").AuditViolation[];
          contractsCheckedRowCount: number;
        };
      }>(`/roles/${id}/scores?limit=50`);
      setScores(data.scores ?? []);
      setContractCompliance(data.contractCompliance ?? null);
    } catch {
      setScores([]);
      setContractCompliance(null);
    }
  }, [id]);

  const loadTasks = useCallback(async () => {
    try {
      const data = await api<{ tasks: Task[] }>("/tasks");
      setTasks(data.tasks ?? []);
    } catch {
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    void loadRole();
  }, [loadRole]);

  useEffect(() => {
    void loadMemories();
    void loadBeliefs();
    void loadEvolution();
    void loadTasks();
    void loadScores();
  }, [loadMemories, loadBeliefs, loadEvolution, loadTasks, loadScores]);

  // Client-side filter: tasks with this roleId
  const roleTasks = tasks.filter((t) => t.roleId === id);
  const projectScopePluginCount = rawPlugins.filter(
    (plugin) => plugin.scope === "project" && plugin.projectPath === workspacePath,
  ).length;

  const handleSaveCag = async () => {
    if (!id) return;
    setSavingCag(true);
    try {
      await updateRole(id, { cagPrompt: cagValue });
      await loadRole();
      setEditingCag(false);
      toast.success("CAG prompt updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingCag(false);
    }
  };

  const [deleteWithForce, setDeleteWithForce] = useState(false);

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await deleteRole(id);
      navigate("/roles");
    } catch (e) {
      // Check if this is the ROLE_HAS_ACTIVE_TASKS 409 — surface confirm dialog
      const apiErr = e as Error & { status?: number; activeTaskCount?: number; taskStatuses?: string[] };
      if (apiErr.status === 409) {
        setDeleting(false);
        setDeleteWithForce(true);
        return;
      }
      toast.error(e instanceof Error ? e.message : "Failed to delete role");
      setDeleting(false);
    }
  };

  const handleForceDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setDeleteWithForce(false);
    try {
      await deleteRole(id, true);
      navigate("/roles");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete role");
      setDeleting(false);
    }
  };

  const handleRestorePreset = async () => {
    if (!id || !role?.presetId) return;
    setRestoringPreset(true);
    try {
      await api(`/presets/role/${role.presetId}/restore`, { method: "POST" });
      toast.success("Preset restored");
      await loadRole();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to restore preset");
    } finally {
      setRestoringPreset(false);
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/roles" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Roles
        </Link>
        <Card className="text-center text-[var(--app-danger)]">{error}</Card>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="space-y-4">
        <Link to="/roles" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Roles
        </Link>
        <Card className="text-center text-[var(--app-text-subtle)]">Loading...</Card>
      </div>
    );
  }

  const statusVariant = (s: string): "success" | "secondary" | "destructive" | "warning" => {
    if (s === "active") return "success";
    if (s === "inactive") return "secondary";
    if (s === "retired") return "destructive";
    if (s === "probation") return "warning";
    return "secondary";
  };

  return (
    <div className="space-y-5">
      <Link to="/roles" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
        <ArrowLeft size={14} /> Back to Roles
      </Link>

      <PageHeader
        eyebrow="Role"
        title={role.name}
        compact
        description="Behavior, permissions, plugins, and execution history."
        metrics={[
          { label: "Status", value: <Badge variant={statusVariant(role.status)}>{role.status}</Badge> },
          { label: "Performance", value: role.performanceScore != null ? `${(role.performanceScore * 100).toFixed(0)}%` : "—" },
          { label: "Tasks", value: roleTasks.length },
          { label: "Stored", value: memories.length },
          ...(role.presetId ? [{ label: "Preset", value: <Badge variant="info">{role.presetId}</Badge> }] : []),
        ]}
        actions={
          <div className="flex items-center gap-2">
            {role.presetId && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestorePreset}
                disabled={restoringPreset}
              >
                {restoringPreset ? "Restoring..." : "Restore Preset"}
              </Button>
            )}
            <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-[var(--app-danger-soft-text)] hover:text-[var(--app-danger)]">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Role</AlertDialogTitle>
                {deleteWithForce ? (
                  <AlertDialogDescription>
                    This role has active tasks (running or pending). Deleting it now will remove the role workspace while tasks continue running — they may fail. Proceed?
                  </AlertDialogDescription>
                ) : (
                  <AlertDialogDescription>
                    Are you sure you want to delete &quot;{role.name}&quot;? This action cannot be undone.
                  </AlertDialogDescription>
                )}
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setDeleteWithForce(false)}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-[var(--app-danger)] text-white hover:bg-[var(--app-danger-strong)]"
                  onClick={() => void (deleteWithForce ? handleForceDelete() : handleDelete())}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Delete Anyway"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-4">
        <Card className="surface-panel-muted">
          <p className="text-section-label">Role ID</p>
          <p className="mt-2 truncate font-mono text-sm text-[var(--app-text)]">{role.id}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Learned rules</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{role.learnedRules.stylePreferences.length + role.learnedRules.avoidedActions.length + role.learnedRules.pinnedParameters.length}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Bound plugins</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{projectScopePluginCount}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Last updated</p>
          <p className="mt-2 text-sm font-medium text-[var(--app-text)]">{timeAgo(role.updatedAt ?? role.createdAt)}</p>
        </Card>
      </div>

      <SectionHeader
        title="Behavior"
        compact
        description="Prompting, learned rules, and scoring signal stay visible before runtime controls."
      />

      {/* CAG Prompt section */}
      <Card>
        <CardHeader>
          <CardTitle>CAG Prompt</CardTitle>
        </CardHeader>
        {editingCag ? (
          <div className="space-y-2">
            <textarea
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              rows={8}
              value={cagValue}
              onChange={(e) => setCagValue(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="scale-75" onClick={() => { setEditingCag(false); setCagValue(role.cagPrompt); }}>
                Cancel
              </Button>
              {cagValue !== role.cagPrompt && (
                <Button className="scale-75" onClick={() => void handleSaveCag()} disabled={savingCag}>
                  {savingCag ? "Saving..." : "Save"}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <pre className="whitespace-pre-wrap text-sm text-[var(--app-text)]">{role.cagPrompt || "(no CAG prompt)"}</pre>
            <Button variant="ghost" className="scale-75" onClick={() => setEditingCag(true)}>
              Edit
            </Button>
          </div>
        )}
      </Card>

      {/* Learned Rules section — three slots */}
      <LearnedRulesSection roleId={role.id} learnedRules={role.learnedRules} onSave={() => void loadRole()} />

      {/* Performance Trend section */}
      <PerformanceTrendCard scores={scores} currentEma={role.performanceScore} />

      {/* Contract Compliance section */}
      <ContractComplianceCard compliance={contractCompliance} />

      <SectionHeader
        title="Access & Runtime"
        compact
        description="Permissions, OS capabilities, plugins, execution policy, directories, and inherited settings stay grouped."
      />

      {/* Tool Permissions section */}
      <ToolPermissionsCard role={role} onSave={() => void loadRole()} />

      {/* OS Capabilities section */}
      <OsCapabilitiesCard role={role} onSave={() => void loadRole()} />

      {/* Bound Plugins section */}
      <BoundPluginsCard
        roleId={id!}
        workspacePath={workspacePath}
        onChanged={() => void loadRole()}
      />

      {/* Role Extensions section */}
      <BoundExtensionsCard roleId={id!} />

      {/* Execution Config section */}
      <ExecutionConfigCard role={role} onSave={() => void loadRole()} />

      {/* Additional Directories section */}
      <AdditionalDirectoriesCard role={role} onSave={() => void loadRole()} />

      {/* Allowed Channels section */}
      <AllowedChannelsCard role={role} onSave={() => void loadRole()} />

      {/* Inherit User Settings section */}
      <InheritUserSettingsCard role={role} onSave={() => void loadRole()} />

      {/* Environment Variables */}
      {role && (
        <EnvVarEditor
          envVars={role.envVars ?? {}}
          onSave={() => void loadRole()}
          mode="role"
          roleId={role.id}
          title="Environment Variables"
        />
      )}

      {/* Permission & Execution section */}
      <PermissionCard role={role} onSave={() => void loadRole()} />

      <SectionHeader
        title="Knowledge & History"
        compact
        description="Knowledge records, evolution, and execution history stay readable as one audit trail."
      />

      {/* Memories section */}
      <Card>
        <CardHeader>
          <CardTitle>Memories ({memories.length})</CardTitle>
        </CardHeader>
        {memories.length === 0 ? (
          <p className="text-sm text-[var(--app-text-subtle)]">No memories for this role.</p>
        ) : (
          <div className="space-y-2">
            {memories.slice(0, 10).map((m) => (
              <div key={m.id} className="rounded-md border border-[var(--app-border)] px-3 py-2">
                <p className="whitespace-pre-wrap break-all text-sm text-[var(--app-text)]">{m.content}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--app-text-subtle)]">
                  {m.importance != null && <span>Importance: {m.importance.toFixed(2)}</span>}
                  <span>{formatDateTime(m.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Beliefs section */}
      <Card>
        <CardHeader>
          <CardTitle>Beliefs ({beliefs.length})</CardTitle>
        </CardHeader>
        {beliefs.length === 0 ? (
          <p className="text-sm text-[var(--app-text-subtle)]">No beliefs for this role.</p>
        ) : (
          <div className="space-y-2">
            {beliefs.slice(0, 100).map((b) => {
              return (
                <div key={b.id} className="rounded-md border border-[var(--app-border)] px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="whitespace-pre-wrap break-all text-sm text-[var(--app-text)] flex-1">{b.content}</p>
                    <div className="flex items-center gap-1.5">
                      {b.isAnti && <Badge variant="destructive">anti-pattern</Badge>}
                      <Badge variant={b.status === "archived" ? "secondary" : "outline"}>{b.status}</Badge>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--app-text-subtle)]">
                    <span>近期成功率: {b.successEma != null ? `${(b.successEma * 100).toFixed(0)}%` : "—"}</span>
                    <span>已注入 {b.injectCount} 次</span>
                    <span>Last used: seq #{b.lastUsedAt}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Evolution History section */}
      <Card>
        <CardHeader>
          <CardTitle>Evolution History ({evolution.length})</CardTitle>
        </CardHeader>
        {evolution.length === 0 ? (
          <p className="text-sm text-[var(--app-text-subtle)]">No evolution history for this role.</p>
        ) : isMobile ? (
          <div className="space-y-3">
            {evolution.slice(0, 10).map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-canvas)]/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{entry.source}</Badge>
                  <span className="text-xs text-[var(--app-text-subtle)]">{timeAgo(entry.createdAt)}</span>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-[var(--app-text-muted)]">
                  <div className="flex items-start justify-between gap-3">
                    <span className="uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Score</span>
                    <span className="text-right font-mono text-[var(--app-text)]">
                      {entry.previousScore != null && entry.newScore != null
                        ? `${(entry.previousScore * 100).toFixed(0)}% → ${(entry.newScore * 100).toFixed(0)}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <span className="uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Summary</span>
                    <span className="max-w-[70%] text-right text-[var(--app-text)]">{entry.diffSummary ?? "—"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>When</Th>
                <Th>Source</Th>
                <Th>Score Change</Th>
                <Th>Summary</Th>
              </Tr>
            </Thead>
            <Tbody>
              {evolution.slice(0, 10).map((e) => (
                <Tr key={e.id}>
                  <Td className="text-xs text-[var(--app-text-subtle)]">{timeAgo(e.createdAt)}</Td>
                  <Td><Badge variant="secondary">{e.source}</Badge></Td>
                  <Td>
                    {e.previousScore != null && e.newScore != null ? (
                      <span className="font-mono text-xs">
                        {(e.previousScore * 100).toFixed(0)}% → {(e.newScore * 100).toFixed(0)}%
                      </span>
                    ) : <span className="text-[var(--app-text-subtle)]">—</span>}
                  </Td>
                  <Td className="text-sm text-[var(--app-text-muted)]">{e.diffSummary ?? "—"}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {/* Execution History section */}
      <Card>
        <CardHeader>
          <CardTitle>Execution History ({roleTasks.length})</CardTitle>
        </CardHeader>
        {roleTasks.length === 0 ? (
          <p className="text-sm text-[var(--app-text-subtle)]">No tasks executed with this role.</p>
        ) : isMobile ? (
          <div className="space-y-3">
            {(() => {
              const scoreByTaskId = new Map(scores.map((score) => [score.taskId, score]));
              return roleTasks.slice(0, 20).map((task) => {
                const score = scoreByTaskId.get(task.id);
                return (
                  <div key={task.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-canvas)]/40 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link to={`/tasks/${task.id}`} className="break-all font-mono text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)]">
                        {task.id.slice(0, 8)}
                      </Link>
                      <Badge variant={task.status === "completed" ? "success" : task.status === "failed" ? "destructive" : "secondary"}>
                        {task.status}
                      </Badge>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-[var(--app-text-muted)]">
                      <div className="flex items-start justify-between gap-3">
                        <span className="uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Duration</span>
                        <span className="text-right text-[var(--app-text)]">
                          {task.totalDurationMs != null ? `${(task.totalDurationMs / 1000).toFixed(1)}s` : "—"}
                        </span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Cost</span>
                        <span className="text-right font-mono text-[var(--app-text)]">{task.costUsd != null ? formatCost(task.costUsd) : "—"}</span>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <span className="uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">Score</span>
                        <span className={`text-right font-mono ${score && score.scores.weighted < 0.4 ? "text-[var(--app-danger)]" : "text-[var(--app-text)]"}`}>
                          {score ? `${(score.scores.weighted * 100).toFixed(0)}%` : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Task ID</Th>
                <Th>Status</Th>
                <Th>Duration</Th>
                <Th>Cost</Th>
                <Th>Score</Th>
              </Tr>
            </Thead>
            <Tbody>
              {(() => {
                const scoreByTaskId = new Map(scores.map(s => [s.taskId, s]));
                return roleTasks.slice(0, 20).map((t) => (
                  <Tr key={t.id}>
                    <Td>
                      <Link to={`/tasks/${t.id}`} className="font-mono text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)]">
                        {t.id.slice(0, 8)}
                      </Link>
                    </Td>
                    <Td><Badge variant={t.status === "completed" ? "success" : t.status === "failed" ? "destructive" : "secondary"}>{t.status}</Badge></Td>
                    <Td className="text-xs text-[var(--app-text-subtle)]">
                      {t.totalDurationMs != null ? `${(t.totalDurationMs / 1000).toFixed(1)}s` : "—"}
                    </Td>
                    <Td className="text-xs text-[var(--app-text-subtle)]">{t.costUsd != null ? formatCost(t.costUsd) : "—"}</Td>
                    <Td>
                      {(() => {
                        const s = scoreByTaskId.get(t.id);
                        if (!s) return <span className="text-[var(--app-text-subtle)]">—</span>;
                        return (
                          <span className={`font-mono text-xs ${s.scores.weighted < 0.4 ? "text-[var(--app-danger)]" : "text-[var(--app-text)]"}`}>
                            {(s.scores.weighted * 100).toFixed(0)}%
                          </span>
                        );
                      })()}
                    </Td>
                  </Tr>
                ));
              })()}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ===== Learned Rules Card =====

function LearnedRulesSection({ roleId, learnedRules, onSave }: { roleId: string; learnedRules: LearnedRules; onSave: () => void }) {
  const [editingPinIndex, setEditingPinIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [pinTool, setPinTool] = useState("");
  const [pinParams, setPinParams] = useState("");
  const [pinCondition, setPinCondition] = useState("");

  function openEditPin(index: number) {
    const pin = learnedRules.pinnedParameters[index];
    setEditingPinIndex(index);
    setPinTool(pin.tool);
    setPinParams(JSON.stringify(pin.params, null, 2));
    setPinCondition(pin.condition ?? "");
  }

  function openAddPin() {
    setEditingPinIndex(-1);
    setPinTool("");
    setPinParams("{\n  \"\": \"\"\n}");
    setPinCondition("");
  }

  function closeEditPin() {
    setEditingPinIndex(null);
  }

  async function handleSavePin() {
    setSaving(true);
    try {
      let params: Record<string, unknown>;
      try { params = JSON.parse(pinParams); } catch { params = {}; }
      const pins = [...learnedRules.pinnedParameters];
      const newPin = { tool: pinTool, params, condition: pinCondition || undefined, pinnedAt: Date.now() };
      if (editingPinIndex !== null && editingPinIndex >= 0) {
        pins[editingPinIndex] = newPin;
      } else {
        pins.push(newPin);
      }
      const next: LearnedRules = { ...learnedRules, pinnedParameters: pins };
      await api(`/roles/${roleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learnedRules: next }),
      });
      closeEditPin();
      onSave();
    } catch (_e) {
      // error handling
    } finally {
      setSaving(false);
    }
  }

  function formatPinnedAt(ts: number) {
    return new Date(ts).toLocaleString();
  }

  const getRuleLabel = (rule: string): { text: string; variant: "success" | "destructive" | "warning" | "secondary" | "muted" } => {
    if (rule.startsWith("[+]")) return { text: "positive", variant: "success" };
    if (rule.startsWith("[-]")) return { text: "negative", variant: "destructive" };
    if (rule.startsWith("[~]")) return { text: "deviation", variant: "warning" };
    if (rule.startsWith("[monitor:")) return { text: "monitor", variant: "secondary" };
    return { text: "rule", variant: "muted" };
  };

  const { stylePreferences, avoidedActions, pinnedParameters } = learnedRules;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Learned Rules</CardTitle>
          <Button variant="outline" size="sm" onClick={openAddPin}>Add Pin</Button>
        </div>
      </CardHeader>

      {/* Style Preferences */}
      <CardContent className="space-y-2">
        <h4 className="text-sm font-medium text-[var(--app-text-subtle)]">风格偏好</h4>
        {stylePreferences.length === 0 ? (
          <p className="text-xs text-[var(--app-text-subtle)]">(none yet)</p>
        ) : (
          <div className="space-y-2">
            {stylePreferences.map((rule, i) => {
              const label = getRuleLabel(rule);
              return (
                <div key={i} className="rounded border border-[var(--app-border)] p-2">
                  <div className="mb-1"><Badge variant={label.variant} className="text-[10px]">{label.text}</Badge></div>
                  <p className="text-sm text-[var(--app-text)]">{rule}</p>
                </div>
              );
            })}
          </div>
        )}

        {/* Avoided Actions */}
        <h4 className="pt-3 text-sm font-medium text-[var(--app-text-subtle)]">应避免的操作</h4>
        {avoidedActions.length === 0 ? (
          <p className="text-xs text-[var(--app-text-subtle)]">(none yet)</p>
        ) : (
          <div className="space-y-2">
            {avoidedActions.map((rule, i) => (
              <div key={i} className="rounded border border-[var(--app-border)] p-2">
                <Badge variant="destructive" className="text-[10px]">avoid</Badge>
                <p className="mt-1 text-sm text-[var(--app-text)]">{rule}</p>
              </div>
            ))}
          </div>
        )}

        {/* Pinned Parameters */}
        <h4 className="pt-3 text-sm font-medium text-[var(--app-text-subtle)]">固定参数</h4>
        {pinnedParameters.length === 0 ? (
          <p className="text-xs text-[var(--app-text-subtle)]">(none yet)</p>
        ) : (
          <div className="space-y-2">
            {pinnedParameters.map((pin, i) => (
              <div key={i} className="rounded border border-[var(--app-border)] p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Badge variant="outline" className="text-[10px] font-mono">{pin.tool}</Badge>
                    {pin.condition && <span className="ml-2 text-xs text-[var(--app-text-subtle)]">[{pin.condition}]</span>}
                  </div>
                  <Button variant="ghost" size="sm" className="scale-75" onClick={() => openEditPin(i)}>Edit</Button>
                </div>
                <div className="mt-2">
                  <table className="w-full text-xs">
                    <tbody>
                      {Object.entries(pin.params).map(([k, v]) => (
                        <tr key={k} className="border-t border-[var(--app-border)]">
                          <td className="pr-3 font-mono text-[var(--app-text-subtle)]">{k}</td>
                          <td className="font-mono text-[var(--app-text)]">{JSON.stringify(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[10px] text-[var(--app-text-subtle)]">Pinned: {formatPinnedAt(pin.pinnedAt)}</p>
              </div>
            ))}
          </div>
        )}

        {/* Inline edit form for a pin */}
        {editingPinIndex !== null && (
          <div className="rounded border border-[var(--app-accent)] bg-[var(--app-panel)] p-3 space-y-2">
            <div>
              <label className="text-xs text-[var(--app-text-subtle)]">Tool pattern</label>
              <input
                className="mt-1 w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={pinTool}
                onChange={(e) => setPinTool(e.target.value)}
                placeholder="e.g. Bash:generate_voice.sh"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--app-text-subtle)]">Params (JSON)</label>
              <textarea
                className="mt-1 w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs font-mono text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                rows={4}
                value={pinParams}
                onChange={(e) => setPinParams(e.target.value)}
                placeholder='{"-v": "male-qn-qing-xx"}'
              />
            </div>
            <div>
              <label className="text-xs text-[var(--app-text-subtle)]">Condition (optional)</label>
              <input
                className="mt-1 w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                value={pinCondition}
                onChange={(e) => setPinCondition(e.target.value)}
                placeholder="e.g. 给卞旸生成播客时"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="scale-75" onClick={closeEditPin} disabled={saving}>Cancel</Button>
              <Button size="sm" className="scale-75" onClick={() => void handleSavePin()} disabled={saving}>
                {saving ? "Saving..." : "Save Pin"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ===== Performance Trend Card =====

function PerformanceTrendCard({ scores, currentEma }: { scores: RoleScoreRecord[]; currentEma?: number }) {
  const THRESHOLD = 0.4;
  // Reverse for chronological order (API returns newest first)
  const data = [...scores].reverse().map((s, i) => ({
    index: i + 1,
    ema: +(s.emaScore * 100).toFixed(1),
    weighted: +(s.scores.weighted * 100).toFixed(1),
    taskId: s.taskId.slice(0, 8),
  }));

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Performance Trend</CardTitle></CardHeader>
        <p className="text-sm text-[var(--app-text-subtle)]">No score data yet. Scores are recorded after task completion.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Performance Trend</CardTitle>
          {currentEma != null && (
            <span className={`font-mono text-sm ${currentEma < THRESHOLD ? "text-[var(--app-danger)]" : "text-[var(--app-success)]"}`}>
              EMA: {(currentEma * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </CardHeader>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: -10, bottom: 4 }}>
          <XAxis dataKey="index" tick={{ fontSize: 10, fill: "#64748b" }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
          <ReferenceLine y={THRESHOLD * 100} stroke="#ef4444" strokeDasharray="4 3" label={{ value: "Retire", fill: "#ef4444", fontSize: 9, position: "right" }} />
          <Tooltip
            contentStyle={{ background: "#1e293b", border: "1px solid #1e293b", borderRadius: 6, fontSize: 12 }}
            labelFormatter={(i) => `Task #${i}`}
            formatter={(value, name) => [`${value}%`, name === "ema" ? "EMA" : "Task Score"]}
          />
          <Line type="monotone" dataKey="ema" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name="ema" />
          <Line type="monotone" dataKey="weighted" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" dot={false} name="weighted" />
        </LineChart>
      </ResponsiveContainer>
      <p className="sr-only">
        Performance trend: {data.length} data points, latest EMA {currentEma ? `${(currentEma * 100).toFixed(0)}%` : "N/A"}, retirement threshold 40%
      </p>
      <p className="mt-1 text-center text-[10px] text-[var(--app-text-subtle)]">
        Last {data.length} tasks — blue: EMA, gray dashed: per-task score, red: retirement threshold (40%)
      </p>
    </Card>
  );
}

// ===== Contract Compliance Card =====

function ContractComplianceCard({
  compliance,
}: {
  compliance: {
    emaScore: number | null;
    recentViolations: import("@/lib/types").AuditViolation[];
    contractsCheckedRowCount: number;
  } | null;
}) {
  const emaLabel =
    compliance?.emaScore != null
      ? `${(compliance.emaScore * 100).toFixed(0)}%`
      : "—";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>契约合规率</CardTitle>
          <span className="font-mono text-sm text-[var(--app-text)]">{emaLabel}</span>
        </div>
      </CardHeader>
      {compliance?.recentViolations && compliance.recentViolations.length > 0 ? (
        <div className="space-y-1 px-4 pb-3">
          <p className="text-xs font-medium text-[var(--app-text-subtle)]">最近违反</p>
          <ul className="space-y-0.5">
            {compliance.recentViolations.slice(0, 10).map((v) => (
              <li key={v.id} className="flex gap-2 text-xs text-[var(--app-text-muted)]">
                <span className="shrink-0 text-[var(--app-text-subtle)]">
                  {new Date(v.createdAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="shrink-0 rounded bg-[var(--app-warning-soft-bg)] px-1 text-[10px] font-medium text-[var(--app-warning-soft-text)]">
                  {v.contractField}
                </span>
                <span className="truncate">{v.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="px-4 pb-3 text-sm text-[var(--app-text-subtle)]">暂无违反记录</p>
      )}
    </Card>
  );
}

// ===== Sub-components =====

function ToolPermissionsCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [localTools, setLocalTools] = useState<Set<string>>(new Set(role?.allowedTools ?? []));
  const [savingTool, setSavingTool] = useState<string | null>(null);

  useEffect(() => {
    setLocalTools(new Set(role?.allowedTools ?? []));
  }, [role]);

  const toggleTool = async (tool: string) => {
    if (!role || savingTool) return;
    const prev = new Set(localTools);
    const next = new Set(localTools);
    if (next.has(tool)) next.delete(tool); else next.add(tool);
    setLocalTools(next);
    setSavingTool(tool);
    try {
      await api(`/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ allowedTools: Array.from(next) }),
      });
      onSave();
    } catch (e) {
      setLocalTools(prev);
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingTool(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool Permissions</CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
        {BUILT_IN_TOOLS.map((tool) => (
          <label
            key={tool}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] hover:border-[var(--app-border-strong)]"
          >
            <Switch
              checked={localTools.has(tool)}
              onCheckedChange={() => void toggleTool(tool)}
              disabled={savingTool !== null}
              aria-label={`Toggle ${tool}`}
            />
            <span className="min-w-0 break-words leading-5">{tool}</span>
          </label>
        ))}
      </div>
    </Card>
  );
}

function normalizeRoleOsCapabilitiesDraft(
  osCapabilities: Role["osCapabilities"],
): Role["osCapabilities"] {
  if (!osCapabilities?.length) return undefined;

  const deduped = new Map<string, { id: string; targets?: string[] }>();
  for (const entry of osCapabilities) {
    if (!entry?.id) continue;
    const next: { id: string; targets?: string[] } = { id: entry.id };
    if (entry.targets) {
      next.targets = Array.from(new Set(entry.targets.map((target) => target.trim()).filter(Boolean)));
    }
    deduped.set(entry.id, next);
  }

  return Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function OsCapabilitiesCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [sandboxInfo, setSandboxInfo] = useState<{ platform: string; available: boolean } | null>(null);
  const [registry, setRegistry] = useState<ResolvedOsCapabilityMeta[]>([]);
  const [localCapabilities, setLocalCapabilities] = useState<Role["osCapabilities"]>(role?.osCapabilities ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocalCapabilities(role?.osCapabilities ?? []);
  }, [role]);

  useEffect(() => {
    api<ConfigResponse>("/config")
      .then((data) => {
        setSandboxInfo(data.sandbox);
        setRegistry(data.osCapabilities.registry ?? []);
      })
      .catch(() => {
        setSandboxInfo(null);
        setRegistry([]);
      });
  }, []);

  if (!role) return null;

  const findEntry = (id: string) => localCapabilities?.find((entry) => entry.id === id);

  const setCapabilityEnabled = (id: string, enabled: boolean) => {
    setLocalCapabilities((prev) => {
      const current = prev ?? [];
      if (enabled) {
        if (current.some((entry) => entry.id === id)) return current;
        return [...current, { id, targets: id === "automation" ? [] : undefined }];
      }
      return current.filter((entry) => entry.id !== id);
    });
  };

  const setCapabilityTargets = (id: string, rawValue: string) => {
    const targets = rawValue
      .split(",")
      .map((target) => target.trim())
      .filter(Boolean);
    setLocalCapabilities((prev) =>
      (prev ?? []).map((entry) => (
        entry.id === id
          ? { ...entry, targets }
          : entry
      )),
    );
  };

  const normalizedLocal = normalizeRoleOsCapabilitiesDraft(localCapabilities);
  const normalizedRemote = normalizeRoleOsCapabilitiesDraft(role.osCapabilities);
  const isDirty = JSON.stringify(normalizedLocal ?? []) !== JSON.stringify(normalizedRemote ?? []);

  const invalidEntry = normalizedLocal?.find((entry) => {
    if (entry.id !== "automation") return false;
    return !entry.targets?.length || entry.targets.some((target) => !AUTOMATION_TARGET_BUNDLE_ID_RE.test(target));
  });

  const saveCapabilities = async () => {
    if (!role || saving || invalidEntry) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ osCapabilities: normalizedLocal ?? [] }),
      });
      toast.success("OS capabilities updated");
      await onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const statusLabel = sandboxInfo
    ? sandboxInfo.platform === "sandbox-exec"
      ? "macOS sandbox-exec"
      : sandboxInfo.platform === "landlock"
      ? "Linux Landlock"
      : "No OS sandbox"
    : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>OS Capabilities</CardTitle>
            <p className="mt-0.5 text-xs text-[var(--app-text-subtle)]">
              Adam-level system capability controls. Registry is complete; only runtime-enforced items are editable.
            </p>
          </div>
          {isDirty && (
            <Button className="scale-75" onClick={() => void saveCapabilities()} disabled={saving || !!invalidEntry}>
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </CardHeader>

      {statusLabel && (
        <div className="mb-3 flex items-center gap-2 text-xs text-[var(--app-text-subtle)]">
          <Badge variant="secondary">{statusLabel}</Badge>
          {!sandboxInfo?.available && <span>Filesystem sandbox unavailable on this host.</span>}
        </div>
      )}

      <div className="space-y-2">
        {registry.map((meta) => {
          const enabled = !!findEntry(meta.id);
          const automationTargets = findEntry(meta.id)?.targets ?? [];
          const automationValue = automationTargets.join(", ");
          const disabled = !meta.editable || saving;

          return (
            <div key={meta.id} className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--app-text)]">{meta.label}</span>
                    <Badge variant={meta.availability === "editable" ? "success" : "secondary"}>
                      {meta.availability}
                    </Badge>
                    {!meta.editable && <Lock size={12} className="text-[var(--app-text-subtle)]" />}
                  </div>
                  <p className="mt-1 text-xs text-[var(--app-text-muted)]">{meta.description}</p>
                  {meta.effectiveDisabledReason && !meta.editable && (
                    <p className="mt-1 text-xs text-[var(--app-text-subtle)]">{meta.effectiveDisabledReason}</p>
                  )}
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => setCapabilityEnabled(meta.id, checked)}
                  disabled={disabled}
                  aria-label={`Toggle OS capability ${meta.label}`}
                />
              </div>

              {enabled && meta.supportsTargets && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs font-medium text-[var(--app-text)]">Automation targets (bundle ids)</label>
                  <input
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-canvas)] px-3 py-2 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                    value={automationValue}
                    onChange={(e) => setCapabilityTargets(meta.id, e.target.value)}
                    placeholder="com.apple.mail, com.apple.systemevents"
                    disabled={saving}
                  />
                  <p className="mt-1 text-xs text-[var(--app-text-subtle)]">
                    Comma-separated bundle ids. Example: <code>com.apple.mail</code>, <code>com.apple.systemevents</code>
                  </p>
                  {meta.id === "automation" && invalidEntry?.id === "automation" && (
                    <p className="mt-1 text-xs text-[var(--app-danger)]">
                      Automation requires at least one valid bundle id target.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BoundPluginsCard({
  roleId,
  workspacePath,
  onChanged,
}: {
  roleId: string;
  workspacePath: string;
  onChanged?: () => void | Promise<void>;
}) {
  const { rawPlugins, projectScope, refresh } = usePluginsWithUsage();
  const { operatingKey, installToRole, uninstallFromRole, updateRoleVersion } = usePluginMutations(async () => {
    await refresh();
    await onChanged?.();
  });
  const [showInstall, setShowInstall] = useState(false);

  // Build available-to-install from all installed plugins (all scopes), not just user-scope.
  // Plugins installed only as project-scope (e.g. domain-intel@personal-os) must also appear.
  const boundPluginIds = new Set(
    rawPlugins
      .filter((p) => p.scope === "project" && p.projectPath === workspacePath)
      .map((p) => p.id),
  );
  const uniquePluginIds = [...new Set(rawPlugins.map((p) => p.id))];
  const availableToInstall = uniquePluginIds
    .filter((id) => !boundPluginIds.has(id))
    .map((id) => {
      const entry = rawPlugins.find((p) => p.id === id);
      return { id, name: id.split("@")[0], version: entry?.version ?? "" };
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Role Plugins</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Add plugin to role"
            onClick={() => setShowInstall((value) => !value)}
          >
            <Plus size={ICON_SIZE.sm} />
          </Button>
        </div>
      </CardHeader>

      {showInstall ? (
        <div className="mb-3 rounded border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
          <p className="mb-2 text-xs font-semibold text-[var(--app-text)]">Install plugin for this Role (project-scope)</p>
          {availableToInstall.length === 0 ? (
            <p className="text-xs text-[var(--app-text-subtle)]">No plugins available to install. Install plugins from a marketplace first.</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {availableToInstall.map((plugin) => (
                <div key={plugin.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-[var(--app-panel-elevated)]">
                  <span className="text-xs text-[var(--app-text)]">
                    {plugin.name} <span className="text-[var(--app-text-subtle)]">v{plugin.version}</span>
                  </span>
                  <Button
                    size="sm"
                    className="h-5 px-2 text-[10px]"
                    disabled={operatingKey === `${plugin.id}:${workspacePath}`}
                    onClick={async () => {
                      await installToRole(plugin.id, workspacePath);
                      setShowInstall(false);
                    }}
                  >
                    Install
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <RoleProjectPlugins
        groups={projectScope}
        layout="single-role"
        singleRoleId={roleId}
        onUninstall={uninstallFromRole}
        onUpdate={updateRoleVersion}
        operatingKey={operatingKey}
      />
    </Card>
  );
}

// ── OverrideConfigModal ──────────────────────────────────────────────────────

function OverrideConfigModal({
  binding,
  extension,
  onClose,
  onSave,
}: {
  binding: RoleExtensionBinding;
  extension: Extension;
  onClose: () => void;
  onSave: (override: Record<string, unknown>) => Promise<void>;
}) {
  const manifest = (() => {
    try { return JSON.parse(extension.manifestJson) as { user_config?: Record<string, { type?: string; default?: unknown; description?: string; sensitive?: boolean }> }; }
    catch { return {}; }
  })();
  const userConfig = manifest.user_config ?? {};
  const defaults = (() => {
    try { return extension.defaultConfigJson ? (JSON.parse(extension.defaultConfigJson) as Record<string, unknown>) : {}; }
    catch { return {}; }
  })();
  const currentOverride = binding.configOverride ?? {};

  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const key of Object.keys(userConfig)) {
      const overrideVal = key in currentOverride ? currentOverride[key] : undefined;
      init[key] = overrideVal !== undefined ? String(overrideVal) : (defaults[key] !== undefined ? String(defaults[key]) : "");
    }
    return init;
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const sparse: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(userConfig)) {
        const inputVal = values[key] ?? "";
        const defaultVal = defaults[key] !== undefined ? String(defaults[key]) : "";
        if (field.sensitive) {
          if (inputVal !== "") sparse[key] = inputVal;
        } else {
          if (inputVal !== defaultVal) sparse[key] = inputVal;
        }
      }
      await onSave(sparse);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-6 shadow-xl">
        <h2 className="mb-4 text-sm font-semibold text-[var(--app-text)]">
          Override Config — {extension.name}
        </h2>
        {Object.keys(userConfig).length === 0 ? (
          <p className="text-xs text-[var(--app-text-subtle)]">This extension has no user-configurable fields.</p>
        ) : (
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {Object.entries(userConfig).map(([key, field]) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-[var(--app-text)]">
                  {key}
                  {field.description && <span className="ml-1 text-[var(--app-text-subtle)]">— {field.description}</span>}
                </label>
                <input
                  type={field.sensitive ? "password" : "text"}
                  className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:outline-none"
                  value={values[key] ?? ""}
                  placeholder={field.sensitive ? "(leave empty to clear override)" : String(field.default ?? "")}
                  onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── HealthBadge ──────────────────────────────────────────────────────────────

function HealthBadge({ health }: { health?: ExtensionHealth | null }) {
  if (!health) return <span title="Never run" className="text-gray-500 text-xs">⏳</span>;
  if (health.lastStatus === "success") {
    const ts = health.lastRunAt ? new Date(health.lastRunAt).toLocaleString() : "";
    return <span title={`Last ok ${ts}`} className="text-green-500 text-xs">✅</span>;
  }
  return <span title={health.lastError ?? "Failed"} className="text-red-500 text-xs">❌</span>;
}

// ── BoundExtensionsCard ──────────────────────────────────────────────────────

export function BoundExtensionsCard({ roleId }: { roleId: string }) {
  const [bindings, setBindings] = useState<RoleExtensionBinding[]>([]);
  const [available, setAvailable] = useState<Extension[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<RoleExtensionBinding | null>(null);
  const [overrideExtension, setOverrideExtension] = useState<Extension | null>(null);
  const [loading, setLoading] = useState(true);
  const [operating, setOperating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, exts] = await Promise.all([listRoleExtensions(roleId), listExtensions()]);
      setBindings(bs);
      const boundIds = new Set(bs.map((b) => b.extensionId));
      setAvailable(exts.filter((e) => !boundIds.has(e.id)));
    } finally {
      setLoading(false);
    }
  }, [roleId]);

  useEffect(() => { void load(); }, [load]);

  const handleBind = async (ext: Extension) => {
    setOperating(ext.id);
    try {
      await bindRoleExtension(roleId, ext.name);
      await load();
      setShowAdd(false);
      toast.success(`Extension "${ext.name}" bound`);
    } catch {
      toast.error("Failed to bind extension");
    } finally {
      setOperating(null);
    }
  };

  const handleUnbind = async (binding: RoleExtensionBinding) => {
    if (!confirm(`解绑 "${binding.extensionName}"？此操作不可撤销。`)) return;
    setOperating(binding.id);
    try {
      await unbindRoleExtension(roleId, binding.id);
      await load();
      toast.success(`Extension "${binding.extensionName}" unbound`);
    } catch {
      toast.error("Failed to unbind extension");
    } finally {
      setOperating(null);
    }
  };

  const handleToggleEnabled = async (binding: RoleExtensionBinding) => {
    setOperating(binding.id);
    try {
      await patchRoleExtension(roleId, binding.id, { enabled: !binding.enabled });
      await load();
    } catch {
      toast.error("Failed to update extension");
    } finally {
      setOperating(null);
    }
  };

  const handleOpenOverride = async (binding: RoleExtensionBinding) => {
    const exts = await listExtensions();
    const ext = exts.find((e) => e.id === binding.extensionId) ?? null;
    setOverrideExtension(ext);
    setOverrideTarget(binding);
  };

  const handleSaveOverride = async (override: Record<string, unknown>) => {
    if (!overrideTarget) return;
    await patchRoleExtension(roleId, overrideTarget.id, { configOverride: override });
    await load();
    toast.success("Override saved");
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Role Extensions</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Add extension to role"
              onClick={() => setShowAdd((v) => !v)}
            >
              <Plus size={ICON_SIZE.sm} />
            </Button>
          </div>
        </CardHeader>

        {showAdd && (
          <div className="mb-3 rounded border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
            <p className="mb-2 text-xs font-semibold text-[var(--app-text)]">Bind extension to this Role</p>
            {available.length === 0 ? (
              <p className="text-xs text-[var(--app-text-subtle)]">所有已安装的 Extension 都已绑定，或尚未安装任何 Extension。</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {available.map((ext) => (
                  <div key={ext.id} className="flex items-center justify-between rounded px-2 py-1 hover:bg-[var(--app-panel-elevated)]">
                    <span className="text-xs text-[var(--app-text)]">
                      {ext.name} <span className="text-[var(--app-text-subtle)]">v{ext.version}</span>
                    </span>
                    <Button
                      size="sm"
                      className="h-5 px-2 text-[10px]"
                      disabled={operating === ext.id}
                      onClick={() => void handleBind(ext)}
                    >
                      Bind
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <CardContent>
          {loading ? (
            <p className="text-xs text-[var(--app-text-subtle)]">加载中…</p>
          ) : bindings.length === 0 ? (
            <p className="text-xs text-[var(--app-text-subtle)]">还没绑任何 extension</p>
          ) : (
            <div className="space-y-2">
              {bindings.map((binding) => (
                <div key={binding.id} className="flex items-center justify-between rounded border border-[var(--app-border)] px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <HealthBadge health={binding.health} />
                    <span className="truncate text-xs font-medium text-[var(--app-text)]">{binding.extensionName}</span>
                    <span className="text-[10px] text-[var(--app-text-subtle)]">v{binding.version}</span>
                    <span className="text-[10px] text-[var(--app-text-subtle)]">{binding.toolsCount} tools</span>
                    {binding.configOverride !== null && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0">已覆盖</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span title="Will affect task execution in next phase">
                      <Switch
                        checked={binding.enabled}
                        onCheckedChange={() => void handleToggleEnabled(binding)}
                        disabled={operating === binding.id}
                        aria-label="Toggle extension enabled"
                      />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => void handleOpenOverride(binding)}
                    >
                      覆盖 config
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-red-500 hover:text-red-600"
                      disabled={operating === binding.id}
                      onClick={() => void handleUnbind(binding)}
                    >
                      解绑
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {overrideTarget !== null && overrideExtension !== null && (
        <OverrideConfigModal
          binding={overrideTarget}
          extension={overrideExtension}
          onClose={() => { setOverrideTarget(null); setOverrideExtension(null); }}
          onSave={handleSaveOverride}
        />
      )}
    </>
  );
}

function AdditionalDirectoriesCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const { id } = useParams<{ id: string }>();
  const [saving, setSaving] = useState(false);
  const [dirs, setDirs] = useState<AdditionalDirectoryEntry[]>(() =>
    (role?.additionalDirectories ?? []).map((d) => typeof d === "string" ? { path: d } : d as AdditionalDirectoryEntry)
  );
  const [newDir, setNewDir] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [discoveredPlugins, setDiscoveredPlugins] = useState<Record<string, { enabledPlugins: Record<string, boolean>; mcpServers: Record<string, unknown>; allowedTools: string[] }>>({});

  // Autocomplete state
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDirs((role?.additionalDirectories ?? []).map((d) => typeof d === "string" ? { path: d } : d as AdditionalDirectoryEntry));
  }, [role]);

  const fetchSuggestions = useCallback(async (prefix: string) => {
    if (!prefix || !prefix.startsWith("/")) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }
    setLoadingSuggestions(true);
    try {
      const data = await api<{ suggestions: string[] }>(
        `/fs/suggest-dirs?prefix=${encodeURIComponent(prefix)}`,
      );
      setSuggestions(data.suggestions ?? []);
      setActiveIdx(-1);
    } catch {
      setSuggestions([]);
    } finally {
      setLoadingSuggestions(false);
    }
  }, []);

  const handleInputChange = (value: string) => {
    setNewDir(value);
    setActiveIdx(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value || !value.startsWith("/")) {
      setSuggestions([]);
      setLoadingSuggestions(false);
      return;
    }
    setLoadingSuggestions(true);
    debounceRef.current = setTimeout(() => {
      void fetchSuggestions(value);
    }, 300);
  };

  const selectSuggestion = (path: string) => {
    setNewDir(path.endsWith("/") ? path.slice(0, -1) : path);
    setSuggestions([]);
    setActiveIdx(-1);
    void fetchSuggestions(path.endsWith("/") ? path : path + "/");
  };

  const handleAdd = () => {
    const trimmed = newDir.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("/")) {
      toast.error("Path must be absolute (must start with /)");
      return;
    }
    if (dirs.some((d) => d.path === trimmed)) {
      toast.error("Directory already in list");
      return;
    }
    setDirs((prev) => [...prev, { path: trimmed, mode: "rw" }]);
    setNewDir("");
    setSuggestions([]);
    setShowInput(false);
  };

  const handleRemove = (path: string) => {
    setDirs((prev) => prev.filter((d) => d.path !== path));
    setDiscoveredPlugins((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  const handleToggleInherit = (path: string, key: "inheritPlugins" | "inheritMcp" | "inheritPermissions") => {
    setDirs((prev) =>
      prev.map((d) =>
        d.path === path ? { ...d, [key]: !d[key] } : d,
      ),
    );
  };

  const handleToggleMode = (path: string) => {
    setDirs((prev) =>
      prev.map((d) =>
        d.path === path ? { ...d, mode: d.mode === "ro" ? "rw" : "ro" } : d,
      ),
    );
  };

  const handleScanDirectory = async (path: string) => {
    if (!id) return;
    setScanningPath(path);
    try {
      const data = await api<{ enabledPlugins: Record<string, boolean>; mcpServers: Record<string, unknown>; allowedTools: string[] }>(`/roles/${id}/scan-directory`, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      setDiscoveredPlugins((prev) => ({ ...prev, [path]: data }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to scan directory");
    } finally {
      setScanningPath(null);
    }
  };

  const handleSave = async () => {
    if (!role) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ additionalDirectories: dirs }),
      });
      toast.success("Additional directories saved");
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const closeInput = () => {
    setShowInput(false);
    setNewDir("");
    setSuggestions([]);
    setActiveIdx(-1);
  };

  const isDirty = JSON.stringify(dirs) !== JSON.stringify(role?.additionalDirectories ?? []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Additional Directories</CardTitle>
            <p className="text-xs text-[var(--app-text-subtle)] mt-0.5">Extra directories this Role can access. Configure read/write mode and inheritance per directory.</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="scale-75"
              onClick={() => { setShowInput(!showInput); setSuggestions([]); setActiveIdx(-1); }}
            >
              <Plus size={14} /> Add Directory
            </Button>
            {isDirty && (
              <Button className="scale-75" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <SandboxStatusBar />

      {showInput && (
        <div className="relative mb-3 flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={newDir}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="/absolute/path/to/directory"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(0, i - 1));
                } else if (e.key === "Tab" && activeIdx >= 0) {
                  e.preventDefault();
                  selectSuggestion(suggestions[activeIdx]!);
                } else if (e.key === "Enter") {
                  if (activeIdx >= 0) {
                    selectSuggestion(suggestions[activeIdx]!);
                  } else {
                    handleAdd();
                  }
                } else if (e.key === "Escape") {
                  setSuggestions([]);
                  setActiveIdx(-1);
                }
              }}
              autoFocus
            />
            {/* Suggestions dropdown */}
            {suggestions.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] py-1 shadow-lg">
                {suggestions.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => selectSuggestion(s)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`w-full px-3 py-1.5 text-left text-sm ${
                      i === activeIdx
                        ? "bg-[var(--app-accent)] text-white"
                        : "text-[var(--app-text)] hover:bg-[var(--app-panel-muted)]"
                    }`}
                  >
                    {s}/
                  </button>
                ))}
              </div>
            )}
            {loadingSuggestions && suggestions.length === 0 && newDir && (
              <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text-subtle)] shadow-lg">
                Loading...
              </div>
            )}
          </div>
          <Button className="scale-75" onClick={() => void handleAdd()}>Add</Button>
          <Button variant="ghost" className="scale-75" onClick={closeInput}>
            Cancel
          </Button>
        </div>
      )}

      {dirs.length === 0 ? (
        <p className="text-sm text-[var(--app-text-subtle)]">No additional directories configured.</p>
      ) : (
        <div className="space-y-3">
          {dirs.map((dir) => {
            const discovered = discoveredPlugins[dir.path];
            const isScanning = scanningPath === dir.path;
            return (
              <div key={dir.path} className="rounded-md border border-[var(--app-border)] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <button
                      onClick={() => handleToggleMode(dir.path)}
                      className={`flex-shrink-0 cursor-pointer text-xs font-mono px-1.5 py-0.5 rounded border ${
                        dir.mode === "ro"
                          ? "text-[var(--app-warning)] border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] hover:bg-[var(--app-warning-soft-bg-subtle)]"
                          : "text-[var(--app-success)] border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] hover:bg-[var(--app-success-soft-bg-subtle)]"
                      }`}
                      title={dir.mode === "ro" ? "Read-only — click to toggle to RW" : "Read-write — click to toggle to RO"}
                    >
                      {dir.mode === "ro" ? "RO" : "RW"}
                    </button>
                    <span className="font-mono text-xs text-[var(--app-text)] truncate" title={dir.path}>{dir.path}</span>
                  </div>
                  <button
                    onClick={() => handleRemove(dir.path)}
                    className="flex-shrink-0 cursor-pointer text-[var(--app-text-muted)] hover:text-[var(--app-danger)] ml-2"
                    aria-label={`Remove ${dir.path}`}
                  >
                    ×
                  </button>
                </div>
                {/* Inheritance toggles */}
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-[var(--app-text)] cursor-pointer">
                    <Switch
                      checked={!!dir.inheritPlugins}
                      onCheckedChange={() => handleToggleInherit(dir.path, "inheritPlugins")}
                      className="scale-75"
                    />
                    Plugins
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[var(--app-text)] cursor-pointer">
                    <Switch
                      checked={!!dir.inheritMcp}
                      onCheckedChange={() => handleToggleInherit(dir.path, "inheritMcp")}
                      className="scale-75"
                    />
                    MCP
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[var(--app-text)] cursor-pointer">
                    <Switch
                      checked={!!dir.inheritPermissions}
                      onCheckedChange={() => handleToggleInherit(dir.path, "inheritPermissions")}
                      className="scale-75"
                    />
                    Permissions
                  </label>
                  <button
                    className="text-xs text-[var(--app-accent)] hover:text-[var(--app-accent)] ml-auto disabled:opacity-50"
                    onClick={() => void handleScanDirectory(dir.path)}
                    disabled={isScanning}
                  >
                    {isScanning ? "Scanning..." : "Scan"}
                  </button>
                </div>
                {/* Scan results */}
                {discovered && (
                  <div className="rounded bg-[var(--app-panel)] p-2 space-y-1">
                    {Object.keys(discovered.enabledPlugins).length > 0 && (
                      <div className="text-xs text-[var(--app-text-muted)]">
                        <span className="text-[var(--app-text-subtle)]">Plugins: </span>
                        {Object.entries(discovered.enabledPlugins)
                          .filter(([, v]) => v)
                          .map(([id]) => id)
                          .join(", ") || "none enabled"}
                      </div>
                    )}
                    {Object.keys(discovered.mcpServers).length > 0 && (
                      <div className="text-xs text-[var(--app-text-muted)]">
                        <span className="text-[var(--app-text-subtle)]">MCP: </span>
                        {Object.keys(discovered.mcpServers).join(", ")}
                      </div>
                    )}
                    {discovered.allowedTools.length > 0 && (
                      <div className="text-xs text-[var(--app-text-muted)]">
                        <span className="text-[var(--app-text-subtle)]">Tools: </span>
                        {discovered.allowedTools.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

interface ChannelSummary {
  id: string;
  name: string;
  enabled: boolean;
}

function AllowedChannelsCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string[]>(role?.allowedChannels ?? []);
  const [mode, setMode] = useState<"unrestricted" | "block-all" | "whitelist">(
    role?.allowedChannels === undefined ? "unrestricted"
      : role.allowedChannels.length === 0 ? "block-all"
      : "whitelist",
  );
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelected(role?.allowedChannels ?? []);
    setMode(
      role?.allowedChannels === undefined ? "unrestricted"
        : role.allowedChannels.length === 0 ? "block-all"
        : "whitelist",
    );
  }, [role]);

  const fetchChannels = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ channels: ChannelSummary[] }>("/channels?enabled=true");
      setChannels(data.channels ?? []);
    } catch {
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Instant save for mode switches (unrestricted / block-all)
  const saveMode = async (newMode: "unrestricted" | "block-all") => {
    if (!role) return;
    setSaving(true);
    try {
      const payload = newMode === "unrestricted" ? { allowedChannels: null } : { allowedChannels: [] as string[] };
      await api(`/roles/${role.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      setMode(newMode);
      setSelected([]);
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  // Save whitelist selection
  const saveWhitelist = async () => {
    if (!role) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}`, { method: "PATCH", body: JSON.stringify({ allowedChannels: selected }) });
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const toggleChannel = (channelName: string) => {
    if (mode !== "whitelist") {
      setMode("whitelist");
      void fetchChannels();
    }
    setSelected((prev) =>
      prev.includes(channelName) ? prev.filter((c) => c !== channelName) : [...prev, channelName],
    );
  };

  const storedChannels = role?.allowedChannels ?? [];
  const isDirty = mode === "whitelist" && (
    selected.length !== storedChannels.length ||
    selected.some((c) => !storedChannels.includes(c))
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle>Allowed Channels</CardTitle>
          <div className="flex flex-wrap gap-1">
            <Button variant={mode === "unrestricted" ? "default" : "ghost"} size="sm" disabled={saving}
              onClick={() => { if (mode !== "unrestricted") void saveMode("unrestricted"); }}>
              Unrestricted
            </Button>
            <Button variant={mode === "block-all" ? "default" : "ghost"} size="sm" disabled={saving}
              onClick={() => { if (mode !== "block-all") void saveMode("block-all"); }}>
              Block All
            </Button>
            <Button variant={mode === "whitelist" ? "default" : "ghost"} size="sm" disabled={saving}
              onClick={() => { if (mode !== "whitelist") { setMode("whitelist"); void fetchChannels(); } }}>
              Whitelist
            </Button>
          </div>
        </div>
      </CardHeader>

      {mode === "unrestricted" ? (
        <p className="text-sm text-[var(--app-text-subtle)]">This role can use all channels.</p>
      ) : mode === "block-all" ? (
        <p className="text-sm text-[var(--app-text-subtle)]">This role is blocked from using any channel.</p>
      ) : (
        <>
          {loading ? (
            <p className="text-sm text-[var(--app-text-subtle)]">Loading channels...</p>
          ) : channels.length === 0 ? (
            <p className="text-sm text-[var(--app-text-subtle)]">No enabled channels found.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {channels.map((ch) => (
                <Badge
                  key={ch.id}
                  variant={selected.includes(ch.name) ? "default" : "outline"}
                  className="cursor-pointer px-3 py-1.5 text-xs"
                  onClick={() => toggleChannel(ch.name)}
                >
                  {ch.name}
                </Badge>
              ))}
            </div>
          )}
          {isDirty && (
            <div className="mt-3 flex justify-end">
              <Button className="scale-75" onClick={() => void saveWhitelist()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function InheritUserSettingsCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [saving, setSaving] = useState(false);
  const enabled = role?.inheritUserSettings ?? false;

  const handleToggle = async () => {
    if (!role) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({ inheritUserSettings: !enabled }),
      });
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Inherit User Settings</CardTitle>
          <Switch checked={enabled} onCheckedChange={() => void handleToggle()} disabled={saving} />
        </div>
      </CardHeader>
      <p className="text-sm text-[var(--app-text-muted)]">
        When enabled, this role has access to all globally installed plugins and MCP servers.
      </p>
      {enabled && (
        <p className="mt-2 text-xs text-[var(--app-warning)]">
          Warning: This role will inherit user-level settings. Ensure the role is trusted.
        </p>
      )}
    </Card>
  );
}

function PermissionCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [saving, setSaving] = useState(false);
  const [permissionMode, setPermissionMode] = useState<string>(role?.permissionMode ?? "default");
  const [allowedBashPatterns, setAllowedBashPatterns] = useState<string[]>(role?.allowedBashPatterns ?? []);
  const [deniedBashPatterns, setDeniedBashPatterns] = useState<string[]>(role?.deniedBashPatterns ?? []);
  const [newAllowed, setNewAllowed] = useState("");
  const [newDenied, setNewDenied] = useState("");

  // Sync when role changes
  useEffect(() => {
    setPermissionMode(role?.permissionMode ?? "default");
    setAllowedBashPatterns(role?.allowedBashPatterns ?? []);
    setDeniedBashPatterns(role?.deniedBashPatterns ?? []);
  }, [role]);

  const isDirty =
    permissionMode !== (role?.permissionMode ?? "default") ||
    JSON.stringify(allowedBashPatterns) !== JSON.stringify(role?.allowedBashPatterns ?? []) ||
    JSON.stringify(deniedBashPatterns) !== JSON.stringify(role?.deniedBashPatterns ?? []);

  const handleSave = async () => {
    if (!role) return;
    setSaving(true);
    try {
      await api(`/roles/${role.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          permissionMode,
          allowedBashPatterns,
          deniedBashPatterns,
        }),
      });
      toast.success("Permission settings saved");
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const addAllowed = () => {
    const trimmed = newAllowed.trim();
    if (!trimmed || allowedBashPatterns.includes(trimmed)) return;
    setAllowedBashPatterns((p) => [...p, trimmed]);
    setNewAllowed("");
  };

  const addDenied = () => {
    const trimmed = newDenied.trim();
    if (!trimmed || deniedBashPatterns.includes(trimmed)) return;
    setDeniedBashPatterns((p) => [...p, trimmed]);
    setNewDenied("");
  };

  const removeAllowed = (pattern: string) =>
    setAllowedBashPatterns((p) => p.filter((x) => x !== pattern));

  const removeDenied = (pattern: string) =>
    setDeniedBashPatterns((p) => p.filter((x) => x !== pattern));

  const MODE_OPTIONS = [
    { value: "default", label: "Default", description: "Normal permission checks, user prompted for elevated operations" },
    { value: "acceptEdits", label: "Accept Edits", description: "Allow file edits without prompts (but respect deniedPaths)" },
    { value: "dontAsk", label: "Don't Ask", description: "Skip permission prompts; auto-deny Bash, Write unless explicitly allowed" },
    { value: "bypassPermissions", label: "Bypass All", description: "Skip all permission checks — OS sandbox is the only defense" },
    { value: "plan", label: "Plan Only", description: "Only plan operations; don't execute tools directly" },
    { value: "auto", label: "Auto", description: "Let Claude Code CLI decide based on project settings" },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Permission &amp; Execution</CardTitle>
          {isDirty && (
            <Button className="scale-75" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </CardHeader>

      {/* Permission Mode */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-[var(--app-text-muted)]">Permission Mode</label>
        <select
          className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value)}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-[var(--app-text-subtle)]">
          {MODE_OPTIONS.find((o) => o.value === permissionMode)?.description ?? ""}
        </p>
        {permissionMode === "bypassPermissions" && (
          <p className="mt-1 text-xs text-[var(--app-warning)]">
            Warning: All permission checks are bypassed. OS sandbox is the only defense.
          </p>
        )}
      </div>

      {/* Bash Control */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-[var(--app-text-muted)]">
          Bash Auto-Allow Patterns
        </label>
        <p className="mb-2 text-xs text-[var(--app-text-subtle)]">
          Glob patterns for Bash commands executed automatically without approval.
          Use <code className="text-[var(--app-text-muted)]">*</code> as wildcard (e.g., <code className="text-[var(--app-text-muted)]">git add *</code>).
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {allowedBashPatterns.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded border border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] px-2 py-0.5 text-xs text-[var(--app-success-soft-text)]"
            >
              {p}
              <button
                type="button"
                className="ml-0.5 text-[var(--app-success)] hover:text-[var(--app-success-soft-text)]"
                onClick={() => removeAllowed(p)}
              >
                ×
              </button>
            </span>
          ))}
          {allowedBashPatterns.length === 0 && (
            <span className="text-xs text-[var(--app-text-subtle)]">No patterns — all Bash requires approval</span>
          )}
        </div>
        <div className="flex gap-1.5">
          <input
            className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder='e.g. "git add *"'
            value={newAllowed}
            onChange={(e) => setNewAllowed(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAllowed(); } }}
          />
          <Button variant="ghost" size="sm" className="scale-75" onClick={() => addAllowed()}>Add</Button>
        </div>
      </div>

      {/* Denied Bash Patterns */}
      <div className="mb-4">
        <label className="mb-1.5 block text-xs font-medium text-[var(--app-text-muted)]">
          Bash Deny Patterns
        </label>
        <p className="mb-2 text-xs text-[var(--app-text-subtle)]">
          Glob patterns for Bash commands that are auto-rejected (cannot be overridden by approval).
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {deniedBashPatterns.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded border border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] px-2 py-0.5 text-xs text-[var(--app-danger-soft-text)]"
            >
              {p}
              <button
                type="button"
                className="ml-0.5 text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                onClick={() => removeDenied(p)}
              >
                ×
              </button>
            </span>
          ))}
          {deniedBashPatterns.length === 0 && (
            <span className="text-xs text-[var(--app-text-subtle)]">No patterns — Bash only controlled by approvalRequired</span>
          )}
        </div>
        <div className="flex gap-1.5">
          <input
            className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder='e.g. "rm -rf *"'
            value={newDenied}
            onChange={(e) => setNewDenied(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDenied(); } }}
          />
          <Button variant="ghost" size="sm" className="scale-75" onClick={() => addDenied()}>Add</Button>
        </div>
      </div>

      {/* Denied Read Paths (read-only) */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-[var(--app-text-muted)]">
          Denied Read Paths
        </label>
        <p className="mb-2 text-xs text-[var(--app-text-subtle)]">
          Configured in Settings &rarr; Advanced. These paths are blocked at both the SDK and OS layer
          for all roles — cannot be overridden by approval.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow"].map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-2 py-0.5 text-xs text-[var(--app-text-muted)]"
            >
              <Lock size={ICON_SIZE.xs} />
              {p}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ExecutionConfigCard({ role, onSave }: { role: Role | null; onSave: () => void }) {
  const [saving, setSaving] = useState(false);
  const [executionMode, setExecutionMode] = useState<string>(role?.executionMode ?? "inline");
  const [effortTier, setEffortTier] = useState<string>(role?.effortTier ?? "");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState<number | "">(role?.maxBudgetUsd ?? "");
  // The model each tier maps to (from Settings) — annotate the tier picker so the choice is
  // transparent. A Role picks a tier; the actual model is configured once in Settings.
  const [tierModels, setTierModels] = useState<{ low?: string; medium?: string; high?: string }>({});

  useEffect(() => {
    setExecutionMode(role?.executionMode ?? "inline");
    setEffortTier(role?.effortTier ?? "");
    setMaxBudgetUsd(role?.maxBudgetUsd ?? "");
  }, [role]);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api<{ config?: { anthropic?: Record<string, { value?: string }> } }>("/config");
        const a = cfg.config?.anthropic ?? {};
        setTierModels({ low: a.defaultHaikuModel?.value, medium: a.defaultSonnetModel?.value, high: a.defaultOpusModel?.value });
      } catch { /* annotation is best-effort */ }
    })();
  }, []);

  const handleSave = async () => {
    if (!role) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (executionMode) body.executionMode = executionMode;
      if (effortTier !== (role?.effortTier ?? "")) {
        body.effortTier = effortTier === "" ? null : effortTier;
      }
      if (maxBudgetUsd !== "") body.maxBudgetUsd = Number(maxBudgetUsd);
      await api(`/roles/${role.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success("Execution config saved");
      onSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const isDirty = executionMode !== (role?.executionMode ?? "inline")
    || effortTier !== (role?.effortTier ?? "")
    || String(maxBudgetUsd) !== String(role?.maxBudgetUsd ?? "");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Execution Config</CardTitle>
          {isDirty && (
            <Button className="scale-75" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
      </CardHeader>
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-[var(--app-text-muted)]">Mode</label>
          <select
            className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            value={executionMode}
            onChange={(e) => setExecutionMode(e.target.value)}
          >
            <option value="inline">inline</option>
            <option value="isolated">isolated</option>
          </select>
        </div>
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-[var(--app-text-muted)]">Model Tier</label>
          <select
            className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            value={effortTier}
            onChange={(e) => setEffortTier(e.target.value)}
          >
            <option value="">(inherit global model)</option>
            <option value="low">low → {tierModels.low ?? "Haiku"}</option>
            <option value="medium">medium → {tierModels.medium ?? "Sonnet"}</option>
            <option value="high">high → {tierModels.high ?? "Opus"}</option>
          </select>
        </div>
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-[var(--app-text-muted)]">Max Budget (USD)</label>
          <input
            type="number"
            className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            value={maxBudgetUsd}
            onChange={(e) => setMaxBudgetUsd(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="0 = unlimited"
            min={0}
            step={0.1}
          />
        </div>
      </div>
    </Card>
  );
}
