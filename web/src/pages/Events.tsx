import { useEffect, useState, useCallback } from "react";
import { Zap, Plus, RefreshCw, Pencil, Trash2, Play } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { Switch } from "@/components/ui/Switch.tsx";
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
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { api } from "@/lib/api.ts";
import { timeAgo } from "@/lib/format.ts";
import { useNavigate } from "react-router-dom";

type SourceType = "webhook" | "directory_watch" | "cron" | "manual";

interface EventDef {
  id: string;
  name: string;
  sourceType: SourceType;
  sourceConfig: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;
}

interface CreateEventDefBody {
  name: string;
  sourceType: SourceType;
  sourceConfig?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
}

const SOURCE_COLORS: Record<SourceType, "info" | "warning" | "success" | "muted"> = {
  webhook: "info",
  directory_watch: "warning",
  cron: "success",
  manual: "muted",
};

function validateCron(cron: string): boolean {
  // Basic 5-field cron validation (minute hour day month weekday)
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|(\*\/)?\d+(-\d+)?(,\d+(-\d+)?)*)$/.test(part));
}

export function Events() {
  const navigate = useNavigate();
  const [eventDefs, setEventDefs] = useState<EventDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSourceType, setCreateSourceType] = useState<SourceType>("webhook");
  const [createDescription, setCreateDescription] = useState("");
  // Source-config fields
  const [createDirPath, setCreateDirPath] = useState("");
  const [createCron, setCreateCron] = useState("");
  const [createCronError, setCreateCronError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editSourceType, setEditSourceType] = useState<SourceType>("webhook");
  const [editDirPath, setEditDirPath] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editCronError, setEditCronError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [fireConfirmId, setFireConfirmId] = useState<string | null>(null);
  const [firePayload, setFirePayload] = useState("");
  const [firing, setFiring] = useState(false);

  const fetchEventDefs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<EventDef[]>("/event-defs");
      setEventDefs(data);
    } catch {
      toast.error("Failed to load events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEventDefs();
  }, [fetchEventDefs]);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    if (createSourceType === "cron" && !validateCron(createCron)) {
      setCreateCronError("Invalid cron expression (expected 5 fields: minute hour day month weekday)");
      return;
    }
    setCreating(true);
    try {
      const body: CreateEventDefBody = {
        name: createName.trim(),
        sourceType: createSourceType,
        description: createDescription.trim() || undefined,
        enabled: true,
      };
      if (createSourceType === "directory_watch" && createDirPath.trim()) {
        body.sourceConfig = { path: createDirPath.trim(), stability_delay_ms: 5000 };
      } else if (createSourceType === "cron" && createCron.trim()) {
        body.sourceConfig = { cron: createCron.trim() };
      }
      await api("/event-defs", { method: "POST", body: JSON.stringify(body) });
      setCreateName("");
      setCreateDescription("");
      setCreateDirPath("");
      setCreateCron("");
      setCreateCronError("");
      setShowCreate(false);
      void fetchEventDefs();
      toast.success("Event created");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create event";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = (def: EventDef) => {
    setEditId(def.id);
    setEditName(def.name);
    setEditDescription(def.description ?? "");
    setEditSourceType(def.sourceType);
    setEditDirPath((def.sourceConfig?.path as string) ?? "");
    setEditCron((def.sourceConfig?.cron as string) ?? "");
    setEditCronError("");
  };

  const handleSaveEdit = async () => {
    if (!editId || !editName.trim()) return;
    if (editSourceType === "cron" && !validateCron(editCron)) {
      setEditCronError("Invalid cron expression");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      };
      if (editSourceType === "directory_watch") {
        body.sourceConfig = { path: editDirPath.trim(), stability_delay_ms: 5000 };
      } else if (editSourceType === "cron") {
        body.sourceConfig = { cron: editCron.trim() };
      }
      await api(`/event-defs/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditId(null);
      void fetchEventDefs();
      toast.success("Event updated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update event";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (def: EventDef) => {
    try {
      await api(`/event-defs/${def.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !def.enabled }),
      });
      void fetchEventDefs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to toggle";
      toast.error(msg);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api(`/event-defs/${id}`, { method: "DELETE" });
      setDeleteConfirmId(null);
      void fetchEventDefs();
      toast.success("Event deleted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      toast.error(msg);
    }
  };

  const handleFire = async (id: string) => {
    setFiring(true);
    try {
      const body: Record<string, unknown> = {};
      if (firePayload.trim()) {
        try {
          body.payload = JSON.parse(firePayload);
        } catch {
          body.payload = { raw: firePayload };
        }
      }
      await api(`/event-defs/${id}/fire`, { method: "POST", body: JSON.stringify(body) });
      setFireConfirmId(null);
      setFirePayload("");
      toast.success("Event fired");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fire event";
      toast.error(msg);
    } finally {
      setFiring(false);
    }
  };

  const deleteConfirmDef = eventDefs.find((d) => d.id === deleteConfirmId);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Events"
        description="Event definitions that trigger automations. Configure webhooks, schedules, or file watchers."
        compact
        action={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => void fetchEventDefs()}>
              <RefreshCw size={14} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
              <Plus size={14} />
              New Event
            </Button>
          </div>
        }
      />

      {showCreate && (
        <Card className="space-y-3">
          <span className="text-sm font-medium text-[var(--app-text)]">New Event</span>
          <input
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Event name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
            placeholder="Description (optional)"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--app-text-muted)]">Source:</span>
            <select
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={createSourceType}
              onChange={(e) => setCreateSourceType(e.target.value as SourceType)}
            >
              <option value="webhook">Webhook (HTTP)</option>
              <option value="cron">Schedule (Cron)</option>
              <option value="directory_watch">File Watcher</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          {createSourceType === "directory_watch" && (
            <input
              className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
              placeholder="Watch directory path (absolute)"
              value={createDirPath}
              onChange={(e) => setCreateDirPath(e.target.value)}
            />
          )}
          {createSourceType === "cron" && (
            <div className="space-y-1">
              <input
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
                placeholder="Cron expression (minute hour day month weekday)"
                value={createCron}
                onChange={(e) => { setCreateCron(e.target.value); setCreateCronError(""); }}
              />
              {createCronError && (
                <p className="text-xs text-[var(--app-danger)]">{createCronError}</p>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => void handleCreate()}
              disabled={creating || !createName.trim() || (createSourceType === "directory_watch" && !createDirPath.trim())}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {editId !== null && (() => {
        const def = eventDefs.find((d) => d.id === editId);
        if (!def) return null;
        return (
          <Card className="space-y-3">
            <span className="text-sm font-medium text-[var(--app-text)]">Edit Event</span>
            <input
              className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none"
              placeholder="Event name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
            <input
              className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)]"
              placeholder="Description (optional)"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
            />
            {editSourceType === "directory_watch" && (
              <input
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)]"
                placeholder="Watch directory path"
                value={editDirPath}
                onChange={(e) => setEditDirPath(e.target.value)}
              />
            )}
            {editSourceType === "cron" && (
              <div className="space-y-1">
                <input
                  className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)]"
                  placeholder="Cron expression"
                  value={editCron}
                  onChange={(e) => { setEditCron(e.target.value); setEditCronError(""); }}
                />
                {editCronError && <p className="text-xs text-[var(--app-danger)]">{editCronError}</p>}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void handleSaveEdit()} disabled={saving || !editName.trim()}>
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button variant="ghost" onClick={() => setEditId(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        );
      })()}

      <Card padding={false}>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
          </div>
        ) : eventDefs.length === 0 ? (
          <EmptyState
            icon={<Zap size={32} />}
            title="No events"
            description="Events are triggered by webhooks, schedules, or file changes and can start automations."
          />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Source</Th>
                <Th>Enabled</Th>
                <Th>Last Fired</Th>
                <Th>Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {eventDefs.map((def) => (
                <Tr key={def.id}>
                  <Td>
                    <button
                      type="button"
                      onClick={() => navigate(`/events/${def.id}`)}
                      className="font-medium text-[var(--app-text)] hover:text-[var(--app-accent)] transition-colors text-left"
                    >
                      {def.name}
                    </button>
                    {def.description && (
                      <div className="text-xs text-[var(--app-text-muted)] truncate max-w-[200px]">{def.description}</div>
                    )}
                  </Td>
                  <Td>
                    <Badge variant={SOURCE_COLORS[def.sourceType]}>
                      {def.sourceType === "directory_watch" ? "file watcher" : def.sourceType}
                    </Badge>
                  </Td>
                  <Td>
                    <Switch
                      checked={def.enabled}
                      onCheckedChange={() => void handleToggle(def)}
                      aria-label={`Toggle ${def.name}`}
                    />
                  </Td>
                  <Td className="text-xs text-[var(--app-text-muted)]">
                    {def.lastFiredAt ? timeAgo(def.lastFiredAt) : "\u2014"}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(def)} title="Edit">
                        <Pencil size={12} />
                      </Button>
                      {def.sourceType === "manual" && def.enabled && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setFireConfirmId(def.id)}
                          title="Fire now"
                        >
                          <Play size={12} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                        onClick={() => setDeleteConfirmId(def.id)}
                        title="Delete"
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {/* Fire now dialog */}
      <AlertDialog open={fireConfirmId !== null} onOpenChange={(open) => { if (!open) setFireConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fire Event</AlertDialogTitle>
            <AlertDialogDescription>
              Fire the manual event immediately. Optionally provide a JSON payload.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-2 text-sm text-[var(--app-text)] placeholder='{}' focus:border-[var(--app-accent)] focus:outline-none font-mono"
            rows={4}
            placeholder='{"key": "value"}'
            value={firePayload}
            onChange={(e) => setFirePayload(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (fireConfirmId) void handleFire(fireConfirmId); setFireConfirmId(null); }}
              disabled={firing}
            >
              {firing ? "Firing..." : "Fire Event"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Event</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &ldquo;{deleteConfirmDef?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-[var(--app-danger)] hover:bg-[var(--app-danger)]"
              onClick={() => { if (deleteConfirmId) void handleDelete(deleteConfirmId); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
