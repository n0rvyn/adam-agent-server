import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Card } from "@/components/ui/Card.tsx";
import {
  getExtension,
  deleteExtension,
  type Extension,
  type McpbManifest,
  type McpbUserConfigField,
} from "@/lib/api.ts";
import { ICON_SIZE } from "@/lib/ui.ts";

function MetaViewer({ meta }: { meta: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        className="flex items-center gap-1 text-xs text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        _meta
      </button>
      {expanded && (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-black/20 p-3 text-xs text-[var(--app-text-muted)]">
          {JSON.stringify(meta, null, 2)}
        </pre>
      )}
    </div>
  );
}

function UserConfigField({ fieldKey, field, value }: {
  fieldKey: string;
  field: McpbUserConfigField;
  value: unknown;
}) {
  const displayValue = value !== undefined && value !== null ? String(value) : (field.default !== undefined ? String(field.default) : "");
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-[var(--app-text)]">
        {field.title}
        {field.required && <span className="ml-1 text-red-400">*</span>}
        {field.sensitive && <span className="ml-1 text-[var(--app-text-subtle)]">(sensitive)</span>}
      </label>
      {field.description && (
        <p className="text-xs text-[var(--app-text-subtle)]">{field.description}</p>
      )}
      <input
        type={field.sensitive ? "password" : "text"}
        readOnly
        defaultValue={displayValue}
        placeholder={`${fieldKey}`}
        className="w-full rounded-lg border border-[var(--app-border)] bg-black/20 px-3 py-1.5 text-xs text-[var(--app-text)] outline-none"
      />
    </div>
  );
}

export function ExtensionDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [extension, setExtension] = useState<Extension | null>(null);
  const [manifest, setManifest] = useState<McpbManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!name) return;
    setLoading(true);
    try {
      const ext = await getExtension(name);
      setExtension(ext);
      try {
        setManifest(JSON.parse(ext.manifestJson) as McpbManifest);
      } catch {
        // leave null
      }
    } catch {
      toast.error("Extension not found");
      navigate("/extensions");
    } finally {
      setLoading(false);
    }
  }, [name, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete() {
    if (!extension) return;
    setDeleting(true);
    try {
      await deleteExtension(extension.name);
      toast.success(`Uninstalled ${extension.name}`);
      navigate("/extensions");
    } catch {
      toast.error("Failed to uninstall extension");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={24} className="animate-spin text-[var(--app-text-subtle)]" />
      </div>
    );
  }

  if (!extension || !manifest) {
    return null;
  }

  const defaultConfig: Record<string, unknown> = (() => {
    try {
      return extension.defaultConfigJson ? (JSON.parse(extension.defaultConfigJson) as Record<string, unknown>) : {};
    } catch { return {}; }
  })();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={manifest.display_name ?? extension.name}
        description={`v${extension.version} · Source: ${extension.installSource}`}
        actions={
          <Button
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            <Trash2 size={ICON_SIZE.md} />
            卸载
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto space-y-4 p-4">
        {/* Header info */}
        <Card className="p-4 space-y-2">
          <p className="text-sm text-[var(--app-text-muted)]">{manifest.description}</p>
          <div className="flex flex-wrap gap-3 text-xs text-[var(--app-text-subtle)]">
            <span>Author: {manifest.author.name}</span>
            {manifest.author.email && <span>{manifest.author.email}</span>}
            {(manifest as { homepage?: string }).homepage && (
              <a
                href={(manifest as { homepage?: string }).homepage}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--app-accent)] hover:underline"
              >
                Homepage
              </a>
            )}
          </div>
        </Card>

        {/* Tools */}
        {manifest.tools && manifest.tools.length > 0 && (
          <Card className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--app-text-subtle)]">
              Tools ({manifest.tools.length})
            </h3>
            <div className="space-y-2">
              {manifest.tools.map((tool) => (
                <div key={tool.name} className="rounded-lg border border-[var(--app-border)] bg-black/10 px-3 py-2">
                  <p className="font-mono text-xs font-medium text-[var(--app-text)]">{tool.name}</p>
                  {tool.description && (
                    <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">{tool.description}</p>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* User config */}
        {manifest.user_config && Object.keys(manifest.user_config).length > 0 && (
          <Card className="p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--app-text-subtle)]">
              Configuration
            </h3>
            <div className="space-y-3">
              {Object.entries(manifest.user_config).map(([key, field]) => (
                <UserConfigField
                  key={key}
                  fieldKey={key}
                  field={field}
                  value={defaultConfig[key]}
                />
              ))}
            </div>
          </Card>
        )}

        {/* _meta viewer */}
        {manifest._meta && Object.keys(manifest._meta).length > 0 && (
          <Card className="p-4">
            <MetaViewer meta={manifest._meta} />
          </Card>
        )}

        {/* Server info */}
        <Card className="p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--app-text-subtle)]">
            Server
          </h3>
          <div className="space-y-1 text-xs text-[var(--app-text)]">
            <p>Type: <span className="font-mono">{manifest.server.type}</span></p>
            <p>Command: <span className="font-mono">{manifest.server.mcp_config.command}</span></p>
            {manifest.server.mcp_config.args && manifest.server.mcp_config.args.length > 0 && (
              <p>Args: <span className="font-mono">{manifest.server.mcp_config.args.join(" ")}</span></p>
            )}
          </div>
        </Card>
      </div>

      {/* Confirm delete dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-6 shadow-2xl">
            <h2 className="mb-2 text-base font-semibold text-[var(--app-text)]">Uninstall extension?</h2>
            <p className="mb-4 text-sm text-[var(--app-text-subtle)]">
              This will remove <strong>{extension.name}</strong> from the DB and delete its files from disk. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? <Loader2 size={ICON_SIZE.md} className="animate-spin" /> : <Trash2 size={ICON_SIZE.md} />}
                Uninstall
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
