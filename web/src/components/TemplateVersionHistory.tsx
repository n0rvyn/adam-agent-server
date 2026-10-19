import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Card } from "@/components/ui/Card.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/AlertDialog.tsx";
import {
  diffTemplateVersions,
  getTemplateVersion,
  listTemplateVersions,
  restoreTemplateVersion,
  type TemplateVersionDiffChange,
  type TemplateVersionSummary,
} from "@/lib/api.ts";
import type { TaskTemplate } from "@/lib/types.ts";

interface TemplateVersionHistoryProps {
  templateId: string;
  templateName: string;
  /**
   * Called after a successful restore so the parent can re-fetch the template
   * (and any related data) so the UI reflects the restored content.
   */
  onRestored?: () => void;
}

type VersionDetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; snapshot: TaskTemplate }
  | { kind: "error"; message: string };

type DiffState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; changes: TemplateVersionDiffChange[]; a: number; b: number }
  | { kind: "error"; message: string };

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function reasonBadgeVariant(reason: string): "info" | "warning" | "destructive" {
  if (reason === "restore") return "info";
  if (reason === "delete") return "destructive";
  return "warning";
}

/**
 * Pretty-print a JSON-serializable value for the diff "before/after" cells.
 * Keeps the diff compact for long strings / nested objects.
 */
function renderValue(value: unknown): string {
  if (value === undefined) return "∅ (absent)";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length > 200) return JSON.stringify(value.slice(0, 200) + "…");
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function TemplateVersionHistory({
  templateId,
  templateName,
  onRestored,
}: TemplateVersionHistoryProps) {
  const [versions, setVersions] = useState<TemplateVersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [expandedVersionNo, setExpandedVersionNo] = useState<number | null>(null);
  const [versionDetail, setVersionDetail] = useState<VersionDetailState>({ kind: "idle" });

  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffState>({ kind: "idle" });

  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTemplateVersions(templateId);
      setVersions(res.versions);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load version history";
      setError(message);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    if (open && versions.length === 0 && !loading && !error) {
      void loadVersions();
    }
  }, [open, versions.length, loading, error, loadVersions]);

  const toggleVersion = useCallback(
    async (versionNo: number) => {
      if (expandedVersionNo === versionNo) {
        setExpandedVersionNo(null);
        setVersionDetail({ kind: "idle" });
        return;
      }
      setExpandedVersionNo(versionNo);
      setVersionDetail({ kind: "loading" });
      try {
        const res = await getTemplateVersion(templateId, versionNo);
        setVersionDetail({ kind: "loaded", snapshot: res.snapshot });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load version";
        setVersionDetail({ kind: "error", message });
      }
    },
    [expandedVersionNo, templateId],
  );

  const loadDiff = useCallback(
    async (a: number, b: number) => {
      setDiff({ kind: "loading" });
      try {
        const res = await diffTemplateVersions(templateId, a, b);
        setDiff({ kind: "loaded", changes: res.changes, a, b });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load diff";
        setDiff({ kind: "error", message });
      }
    },
    [templateId],
  );

  const onPickDiffA = useCallback(
    (versionNo: number) => {
      setDiffA(versionNo);
      if (diffB !== null) void loadDiff(versionNo, diffB);
    },
    [diffB, loadDiff],
  );

  const onPickDiffB = useCallback(
    (versionNo: number) => {
      setDiffB(versionNo);
      if (diffA !== null) void loadDiff(diffA, versionNo);
    },
    [diffA, loadDiff],
  );

  const onRestoreClick = useCallback((versionNo: number) => {
    setRestoreTarget(versionNo);
  }, []);

  const onConfirmRestore = useCallback(async () => {
    if (restoreTarget === null) return;
    setRestoring(true);
    try {
      const res = await restoreTemplateVersion(templateId, restoreTarget);
      toast.success(
        `Restored to v${res.restoredFromVersion} (current state preserved as v${res.preRestoreVersionNo ?? "?"})`,
      );
      setRestoreTarget(null);
      setOpen(false);
      // Reload history so the just-captured pre-restore snapshot is visible.
      void loadVersions();
      onRestored?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Restore failed";
      toast.error(`Restore failed: ${message}`);
    } finally {
      setRestoring(false);
    }
  }, [restoreTarget, templateId, loadVersions, onRestored]);

  const hasTwoPicks = diffA !== null && diffB !== null;

  const diffContent = useMemo(() => {
    if (diff.kind === "idle") {
      return (
        <p className="text-xs text-[var(--app-text-subtle)]">
          Pick two versions above (A and B) to compute a field-level diff.
        </p>
      );
    }
    if (diff.kind === "loading") {
      return <p className="text-xs text-[var(--app-text-subtle)]">Computing diff…</p>;
    }
    if (diff.kind === "error") {
      return <p className="text-xs text-[var(--app-danger-soft-text)]">Error: {diff.message}</p>;
    }
    if (diff.changes.length === 0) {
      return (
        <p className="text-xs text-[var(--app-text-subtle)]">
          v{diff.a} and v{diff.b} are content-identical.
        </p>
      );
    }
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-muted)]">
          {diff.changes.length} changed field{diff.changes.length === 1 ? "" : "s"} (v{diff.a} → v{diff.b})
        </p>
        {diff.changes.map((change) => (
          <div
            key={change.path}
            className="rounded border border-[var(--app-border)] bg-[var(--app-canvas)]/40 p-2"
          >
            <div className="font-mono text-[11px] text-[var(--app-accent-strong)]">
              {change.path}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-[10px] uppercase text-[var(--app-text-muted)]">before</div>
                <pre className="mt-0.5 whitespace-pre-wrap break-words rounded bg-[var(--app-panel)]/60 p-1.5 font-mono text-[11px] text-[var(--app-danger-soft-text)]">
                  {renderValue(change.before)}
                </pre>
              </div>
              <div>
                <div className="text-[10px] uppercase text-[var(--app-text-muted)]">after</div>
                <pre className="mt-0.5 whitespace-pre-wrap break-words rounded bg-[var(--app-panel)]/60 p-1.5 font-mono text-[11px] text-[var(--app-success-soft-text)]">
                  {renderValue(change.after)}
                </pre>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }, [diff]);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-[var(--app-text-muted)] hover:text-[var(--app-accent)] transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <History size={11} />
        版本历史 / Version History
      </button>
      {open && (
        <Card padding={true} className="mt-1 space-y-2 bg-[var(--app-canvas)]/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--app-text)]">
              {templateName} — versions
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadVersions()}
                disabled={loading}
                title="Reload version history"
              >
                Reload
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close version history"
              >
                <X size={12} />
              </Button>
            </div>
          </div>

          {loading && <p className="text-xs text-[var(--app-text-subtle)]">Loading…</p>}
          {error && !loading && (
            <p className="text-xs text-[var(--app-danger-soft-text)]">Error: {error}</p>
          )}
          {!loading && !error && versions.length === 0 && (
            <p className="text-xs text-[var(--app-text-subtle)]">
              No version history yet. Edit this template to create the first snapshot.
            </p>
          )}

          {!loading && !error && versions.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-[10px] text-[var(--app-text-muted)]">
                <span>Diff A:</span>
                <select
                  aria-label="Diff version A"
                  className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--app-text)]"
                  value={diffA ?? ""}
                  onChange={(e) => onPickDiffA(Number(e.target.value))}
                >
                  <option value="">— pick A —</option>
                  {versions.map((v) => (
                    <option key={v.versionNo} value={v.versionNo}>
                      v{v.versionNo}
                    </option>
                  ))}
                </select>
                <span>Diff B:</span>
                <select
                  aria-label="Diff version B"
                  className="rounded border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--app-text)]"
                  value={diffB ?? ""}
                  onChange={(e) => onPickDiffB(Number(e.target.value))}
                >
                  <option value="">— pick B —</option>
                  {versions.map((v) => (
                    <option key={v.versionNo} value={v.versionNo}>
                      v{v.versionNo}
                    </option>
                  ))}
                </select>
                {hasTwoPicks && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDiffA(null);
                      setDiffB(null);
                      setDiff({ kind: "idle" });
                    }}
                    title="Clear diff picks"
                  >
                    Clear
                  </Button>
                )}
              </div>
              {diffContent}
            </div>
          )}

          {!loading && !error && versions.length > 0 && (
            <div className="space-y-1">
              {versions.map((v) => {
                const isExpanded = expandedVersionNo === v.versionNo;
                return (
                  <div
                    key={v.versionNo}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-panel)]/40"
                  >
                    <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => void toggleVersion(v.versionNo)}
                        className="flex items-center gap-1 text-[var(--app-text)] hover:text-[var(--app-accent)]"
                        aria-expanded={isExpanded}
                        aria-label={`Toggle v${v.versionNo} details`}
                      >
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="font-mono">v{v.versionNo}</span>
                      </button>
                      <Badge variant={reasonBadgeVariant(v.reason)} className="text-[10px]">
                        {v.reason}
                      </Badge>
                      <span className="text-[var(--app-text-muted)] truncate">
                        {v.snapshotName}
                      </span>
                      <span className="ml-auto text-[10px] text-[var(--app-text-subtle)]">
                        {formatTimestamp(v.createdAt)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onRestoreClick(v.versionNo)}
                        title={`Restore to v${v.versionNo}`}
                      >
                        <RotateCcw size={11} />
                        Restore
                      </Button>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-[var(--app-border)] bg-[var(--app-canvas)]/30 px-2 py-1.5 text-[11px]">
                        {versionDetail.kind === "loading" && (
                          <p className="text-[var(--app-text-subtle)]">Loading snapshot…</p>
                        )}
                        {versionDetail.kind === "error" && (
                          <p className="text-[var(--app-danger-soft-text)]">
                            Error: {versionDetail.message}
                          </p>
                        )}
                        {versionDetail.kind === "loaded" && (
                          <div className="space-y-1.5">
                            <p className="text-[10px] text-[var(--app-text-muted)]">
                              {versionDetail.snapshot.steps.length} step
                              {versionDetail.snapshot.steps.length === 1 ? "" : "s"} ·{" "}
                              {versionDetail.snapshot.trigger.type} trigger ·{" "}
                              enabled={String(versionDetail.snapshot.enabled)}
                            </p>
                            {versionDetail.snapshot.steps.map((step) => (
                              <div
                                key={step.id}
                                className="rounded border border-[var(--app-border)] bg-[var(--app-panel)]/40 p-1.5"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-[11px] text-[var(--app-accent-strong)]">
                                    {step.id}
                                  </span>
                                  {step.roleId && (
                                    <span className="text-[10px] text-[var(--app-text-muted)]">
                                      @{step.roleId}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-[var(--app-text)]">
                                  {step.prompt.length > 400
                                    ? step.prompt.slice(0, 400) + "…"
                                    : step.prompt}
                                </p>
                              </div>
                            ))}
                            {versionDetail.snapshot.config?.delivery && (
                              <p className="text-[10px] text-[var(--app-text-muted)]">
                                delivery.mode = {versionDetail.snapshot.config.delivery.mode}
                                {versionDetail.snapshot.config.delivery.primaryArtifact
                                  ? ` (stepId=${versionDetail.snapshot.config.delivery.primaryArtifact.stepId})`
                                  : ""}
                              </p>
                            )}
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
      )}

      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore version</AlertDialogTitle>
            <AlertDialogDescription>
              Restore &ldquo;{templateName}&rdquo; to v{restoreTarget}? The current content is
              captured as a new version first, so no history is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void onConfirmRestore()}
              disabled={restoring}
            >
              {restoring ? "Restoring…" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
