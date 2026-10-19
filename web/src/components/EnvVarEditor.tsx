import { useState, useEffect, useCallback } from "react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Card, CardHeader, CardTitle } from "./ui/Card";
import { Plus, Trash2, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { api } from "../lib/api";
import { ICON_SIZE } from "../lib/ui";
import { toast } from "sonner";

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;

interface EnvVarEditorProps {
  /** Current env vars (masked values from GET response). */
  envVars: Record<string, string>;
  /** Callback after save succeeds. */
  onSave: () => void;
  /** API path for saving. For global: use "config"; for role: use the role ID. */
  mode: "global" | "role";
  /** Role ID (required when mode="role"). */
  roleId?: string;
  /** Label for the card. */
  title?: string;
}

interface EnvDiff {
  envKey: string;
  dbValue: string;
  envValue: string;
  configPath?: string;
}

export function EnvVarEditor({ envVars, onSave, mode, roleId, title = "Environment Variables" }: EnvVarEditorProps) {
  const [entries, setEntries] = useState<Array<{ key: string; value: string; isNew: boolean }>>([]);
  const [saving, setSaving] = useState(false);
  const [showValues, setShowValues] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<EnvDiff[]>([]);
  const [envFileExists, setEnvFileExists] = useState(false);

  // Initialize entries from props
  useEffect(() => {
    setEntries(
      Object.entries(envVars ?? {}).map(([key, value]) => ({ key, value, isNew: false }))
    );
  }, [envVars]);

  // Fetch env diff
  const loadDiff = useCallback(async () => {
    try {
      const path = mode === "global" ? "/config/env-diff" : `/roles/${roleId}/env-diff`;
      const data = await api<{ diffs: EnvDiff[]; envFileExists: boolean }>(path);
      // For global mode, only show custom env diffs (not ANTHROPIC_*)
      const filtered = mode === "global"
        ? data.diffs.filter(d => d.configPath?.startsWith("defaults.env."))
        : data.diffs;
      setDiffs(filtered);
      setEnvFileExists(data.envFileExists);
    } catch {
      // Silently ignore diff fetch errors
    }
  }, [mode, roleId]);

  useEffect(() => { void loadDiff(); }, [loadDiff]);

  const isDirty = () => {
    const current = Object.fromEntries(entries.filter(e => e.key.trim()).map(e => [e.key, e.value]));
    return JSON.stringify(current) !== JSON.stringify(envVars);
  };

  const addEntry = () => {
    setEntries(prev => [...prev, { key: "", value: "", isNew: true }]);
  };

  const removeEntry = (idx: number) => {
    setEntries(prev => prev.filter((_, i) => i !== idx));
  };

  const updateEntry = (idx: number, field: "key" | "value", val: string) => {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e));
  };

  const toggleShow = (key: string) => {
    setShowValues(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const validate = (): string | null => {
    const keys = new Set<string>();
    for (const e of entries) {
      const k = e.key.trim();
      if (!k) continue;
      if (!ENV_KEY_REGEX.test(k)) return `Invalid key format: "${k}"`;
      if (k.startsWith("ANTHROPIC_")) return `ANTHROPIC_* keys are managed in the Anthropic section`;
      if (keys.has(k)) return `Duplicate key: "${k}"`;
      keys.add(k);
    }
    if (keys.size > 100) return "Maximum 100 environment variables";
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) { toast.error(error); return; }

    setSaving(true);
    try {
      const envMap: Record<string, string> = {};
      for (const e of entries) {
        const k = e.key.trim();
        if (k) envMap[k] = e.value;
      }

      if (mode === "global") {
        await api("/config/env", { method: "PUT", body: JSON.stringify(envMap) });
      } else {
        await api(`/roles/${roleId}`, { method: "PATCH", body: JSON.stringify({ envVars: envMap }) });
      }
      toast.success("Environment variables saved");
      onSave();
      void loadDiff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleSyncToEnv = async () => {
    try {
      const path = mode === "global" ? "/config/sync-to-env" : `/roles/${roleId}/sync-to-env`;
      await api(path, { method: "POST" });
      toast.success("Synced DB to .env");
      void loadDiff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    }
  };

  const handleLoadFromEnv = async () => {
    try {
      const path = mode === "global" ? "/config/load-from-env" : `/roles/${roleId}/load-from-env`;
      await api(path, { method: "POST" });
      toast.success("Loaded .env to DB");
      onSave();
      void loadDiff();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Load failed");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm">{title}</CardTitle>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={addEntry}>
              <Plus size={ICON_SIZE.sm} />
              Add
            </Button>
            {isDirty() && (
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            )}
          </div>
        </div>
        {mode === "global" && (
          <p className="text-xs text-[var(--app-text-subtle)] mt-1">
            ANTHROPIC_* variables are managed in the Anthropic section above.
          </p>
        )}
      </CardHeader>

      {/* Env diff banner */}
      {diffs.length > 0 && envFileExists && (
        <div className="mx-4 mb-3 rounded border border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-[var(--app-warning)]" />
              <span className="text-xs text-[var(--app-warning)]">
                .env and DB differ on {diffs.length} key(s): {diffs.map(d => d.envKey).join(", ")}
              </span>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => void handleSyncToEnv()}>DB &rarr; .env</Button>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => void handleLoadFromEnv()}>.env &rarr; DB</Button>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pb-4 space-y-2">
        {entries.length === 0 && (
          <p className="text-xs text-[var(--app-text-subtle)] py-2">No environment variables configured.</p>
        )}
        {entries.map((entry, idx) => {
          const isSensitive = SENSITIVE_KEY_PATTERN.test(entry.key);
          const isVisible = showValues.has(entry.key) || entry.isNew;
          return (
            <div key={idx} className="flex flex-col gap-2 md:flex-row md:items-center">
              <Input
                className="w-full font-mono text-xs md:w-48"
                placeholder="KEY_NAME"
                value={entry.key}
                onChange={(e) => updateEntry(idx, "key", e.target.value)}
              />
              <span className="hidden text-[var(--app-text-subtle)] md:inline">=</span>
              <div className="relative min-w-0 flex-1">
                <Input
                  className="font-mono text-xs pr-8"
                  type={isSensitive && !isVisible ? "password" : "text"}
                  placeholder="value"
                  value={entry.value}
                  onChange={(e) => updateEntry(idx, "value", e.target.value)}
                />
                {isSensitive && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
                    onClick={() => toggleShow(entry.key)}
                  >
                    {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                )}
              </div>
              <Button variant="ghost" size="sm" className="self-end text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)] md:self-auto" onClick={() => removeEntry(idx)}>
                <Trash2 size={14} />
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
