import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Package, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Card } from "@/components/ui/Card.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import {
  listExtensions,
  uploadExtension,
  listLegacyMcpServers,
  clearLegacyMcpServers,
  type Extension,
  type ExtensionHealth,
  type LegacySnapshot,
  type LegacyMcpServersRow,
} from "@/lib/api.ts";
import { ICON_SIZE } from "@/lib/ui.ts";

function LegacyBanner({
  snapshot,
  onClear,
}: {
  snapshot: LegacySnapshot;
  onClear: (roleId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);

  if (snapshot.count === 0) return null;

  async function handleClear(row: LegacyMcpServersRow) {
    setClearing(row.roleId);
    try {
      await clearLegacyMcpServers(row.roleId);
      onClear(row.roleId);
      toast.success(`Cleared legacy mcp_servers for ${row.roleName}`);
    } catch {
      toast.error("Failed to clear legacy mcp_servers");
    } finally {
      setClearing(null);
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4">
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <AlertTriangle size={ICON_SIZE.sm} className="shrink-0 text-yellow-400" />
        <span className="flex-1 text-sm font-medium text-yellow-300">
          {snapshot.count} role{snapshot.count !== 1 ? "s" : ""} with legacy{" "}
          <code className="font-mono">mcp_servers</code> field
        </span>
        {expanded ? (
          <ChevronDown size={ICON_SIZE.sm} className="text-yellow-400" />
        ) : (
          <ChevronRight size={ICON_SIZE.sm} className="text-yellow-400" />
        )}
      </button>
      {expanded && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-[var(--app-text-subtle)]">
            These roles have an inline <code className="font-mono">mcp_servers</code> config that
            predates the Extensions system. Click "Clear" to zero it out — the column is preserved,
            only its value is reset to <code className="font-mono">{"{}"}</code>.
          </p>
          {snapshot.rows.map((row) => (
            <div
              key={row.roleId}
              className="flex items-center justify-between rounded-lg border border-[var(--app-border)] bg-black/20 px-3 py-2"
            >
              <span className="text-sm text-[var(--app-text)]">{row.roleName}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleClear(row)}
                disabled={clearing === row.roleId}
              >
                {clearing === row.roleId ? (
                  <Loader2 size={ICON_SIZE.sm} className="animate-spin" />
                ) : (
                  "Clear"
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UploadModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (ext: Extension) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    if (!file.name.endsWith(".mcpb")) {
      toast.error("Only .mcpb files are supported");
      return;
    }
    setUploading(true);
    try {
      const ext = await uploadExtension(file);
      onSuccess(ext);
      toast.success(`Installed extension: ${ext.name} v${ext.version}`);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--app-text)]">Import Extension</h2>
          <button onClick={onClose} className="text-[var(--app-text-subtle)] hover:text-[var(--app-text)]">
            <X size={ICON_SIZE.lg} />
          </button>
        </div>

        <div
          className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 transition-colors ${
            dragOver
              ? "border-[var(--app-accent)] bg-[var(--app-accent)]/10"
              : "border-[var(--app-border)] hover:border-[var(--app-text-subtle)]"
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {uploading ? (
            <Loader2 size={32} className="animate-spin text-[var(--app-accent)]" />
          ) : (
            <>
              <Upload size={32} className="text-[var(--app-text-subtle)]" />
              <p className="text-sm text-[var(--app-text-subtle)]">
                Drop a <code className="font-mono">.mcpb</code> file here, or click to browse
              </p>
            </>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".mcpb"
          className="hidden"
          onChange={handleInputChange}
        />

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function HealthBadge({ health }: { health?: ExtensionHealth | null }) {
  if (!health) return <span title="Never run" className="text-gray-500 text-sm">⏳</span>;
  if (health.lastStatus === "success") {
    const ts = health.lastRunAt ? new Date(health.lastRunAt).toLocaleString() : "";
    return <span title={`Last ok ${ts}`} className="text-green-500 text-sm">✅</span>;
  }
  return <span title={health.lastError ?? "Failed"} className="text-red-500 text-sm">❌</span>;
}

function ExtensionCard({ extension }: { extension: Extension }) {
  const navigate = useNavigate();
  let manifest: { description?: string; version?: string } = {};
  try {
    manifest = JSON.parse(extension.manifestJson) as typeof manifest;
  } catch { /* ignore */ }

  return (
    <Card
      className="cursor-pointer p-4 transition-colors hover:border-[var(--app-accent)]/50"
      onClick={() => navigate(`/extensions/${extension.name}`)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-[var(--app-text)]">{extension.name}</p>
          <p className="mt-0.5 text-xs text-[var(--app-text-subtle)]">v{extension.version}</p>
          {manifest.description && (
            <p className="mt-1 line-clamp-2 text-xs text-[var(--app-text-muted)]">
              {manifest.description}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <HealthBadge health={extension.health} />
          <Package size={ICON_SIZE.md} className="mt-0.5 text-[var(--app-text-subtle)]" />
        </div>
      </div>
    </Card>
  );
}

export function Extensions() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [legacy, setLegacy] = useState<LegacySnapshot>({ count: 0, rows: [] });
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [exts, legacyData] = await Promise.all([listExtensions(), listLegacyMcpServers()]);
      setExtensions(exts);
      setLegacy(legacyData);
    } catch {
      toast.error("Failed to load extensions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function handleClearLegacy(roleId: string) {
    setLegacy((prev) => ({
      count: prev.count - 1,
      rows: prev.rows.filter((r) => r.roleId !== roleId),
    }));
  }

  function handleUploadSuccess(ext: Extension) {
    setExtensions((prev) => {
      const existing = prev.findIndex((e) => e.name === ext.name);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = ext;
        return next;
      }
      return [ext, ...prev];
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Extensions"
        description={loading ? "Loading…" : `${extensions.length} installed`}
        actions={
          <Button onClick={() => setShowUpload(true)}>
            <Upload size={ICON_SIZE.md} />
            Import
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4">
        <LegacyBanner snapshot={legacy} onClear={handleClearLegacy} />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-[var(--app-text-subtle)]" />
          </div>
        ) : extensions.length === 0 ? (
          <EmptyState
            icon={<Package size={32} className="text-[var(--app-text-subtle)]" />}
            title="还没装任何 extension"
            description="Click Import to upload a .mcpb package."
            action={
              <Button onClick={() => setShowUpload(true)}>
                <Upload size={ICON_SIZE.md} />
                Import
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {extensions.map((ext) => (
              <ExtensionCard key={ext.id} extension={ext} />
            ))}
          </div>
        )}
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onSuccess={handleUploadSuccess}
        />
      )}
    </div>
  );
}
