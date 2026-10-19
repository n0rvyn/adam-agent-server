import { useEffect, useState, useCallback } from "react";
import { useBlocker } from "react-router-dom";
import { Settings as SettingsIcon, Save, RefreshCw, Lock, X, Send, TestTube2 } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/AlertDialog.tsx";
import { api, rotateApiKey, getStoredApiKey, setStoredApiKey, clearStoredApiKey, redirectToLogin, updateTaskTemplateConfig } from "@/lib/api.ts";
import { useAppStore } from "@/store/useAppStore.ts";
import { setTimezone } from "@/lib/format.ts";
import { EnvVarEditor } from "@/components/EnvVarEditor.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";

interface ConfigEntry {
  value: unknown;
  mutable: boolean;
}

interface ConfigResponse {
  config: Record<string, ConfigEntry>;
  mutable: string[];
  restartRequired: string[];
}

interface EmailGatewayTestResult {
  ok: boolean;
  stage: "imap" | "smtp" | "roundtrip";
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

interface EmailGatewayRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  lastStatus: string;
  lastCheckedAt: number | null;
  lastError: string | null;
}

const CATEGORIES: Record<string, { label: string; paths: string[]; mutablePaths?: string[] }> = {
  emailGateway: {
    label: "Email Gateway",
    paths: [
      "emailGateway.enabled",
      "emailGateway.address",
      "emailGateway.displayName",
      "emailGateway.imap.host",
      "emailGateway.imap.port",
      "emailGateway.imap.secure",
      "emailGateway.imap.auth.user",
      "emailGateway.imap.auth.pass",
      "emailGateway.imap.mailbox",
      "emailGateway.smtp.host",
      "emailGateway.smtp.port",
      "emailGateway.smtp.secure",
      "emailGateway.smtp.auth.user",
      "emailGateway.smtp.auth.pass",
      "emailGateway.smtp.from",
      "emailGateway.subjectPrefix",
    ],
  },
  anthropic: {
    label: "Anthropic",
    paths: [
      "anthropic.apiKey",
      "anthropic.baseUrl",
      "anthropic.model",
      "anthropic.defaultOpusModel",
      "anthropic.defaultSonnetModel",
      "anthropic.defaultHaikuModel",
      "anthropic.smallFastModel",
    ],
  },
  defaults: {
    label: "Defaults",
    paths: [
      "defaults.model",
      "defaults.effort",
      "defaults.maxTurns",
      "defaults.maxBudgetUsd",
      "defaults.timeout",
      "defaults.approvalTimeout",
    ],
  },
  server: {
    label: "Server",
    paths: ["server.port", "server.host"],
    mutablePaths: ["server.timezone"],
  },
  logging: {
    label: "Logging",
    paths: ["logging.level"],
  },
  evolution: {
    label: "Evolution",
    paths: [
      "roles.evolution.triggerEvery",
      "roles.evolution.reflectionThreshold",
    ],
  },
  chat: {
    label: "Chat",
    paths: [
      "chat.sessionTimeoutMinutes",
      "chat.maxSessionTurns",
      "chat.autoTitle",
      "chat.archiveExtractMemory",
    ],
  },
  templateExecutionArtifacts: {
    label: "Execution Artifacts",
    paths: [
      "watchdog.rules.artifactCleanup.enabled",
      "watchdog.rules.artifactCleanup.ttlDays",
      "watchdog.rules.artifactCleanup.orphanGcMinAgeHours",
    ],
  },
  memory: {
    label: "Memory",
    paths: [],
    mutablePaths: ["memory.embeddingModel"],
  },
  cost: {
    label: "Cost",
    paths: [],
    mutablePaths: ["cost.dailyThresholdUsd"],
  },
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  emailGateway: "Central mailbox used by Mail channels for inbound and outbound delivery.",
  anthropic: "Model endpoints and provider-specific defaults.",
  defaults: "Global execution defaults applied when a role does not override them.",
  server: "Network surface and host-level configuration.",
  logging: "Verbosity and runtime observability controls.",
  evolution: "Thresholds that govern role adaptation over time.",
  chat: "Session lifecycle and archive behavior for chat mode.",
  templateExecutionArtifacts: "Cleanup rules and artifact retention for TemplateExecution files.",
  memory: "Embedding model used for belief and memory vector search.",
  cost: "Absolute daily LLM spend limit; the Cost page turns red when today's spend exceeds it. Empty/0 = disabled.",
};

/** Sections rendered as custom list editors rather than single-value inputs */
const LIST_SECTIONS = ["defaults.deniedReadPaths", "defaults.approvalRequired"] as const;

/** Paths that should render as password inputs (masked) */
const SECRET_PATHS = new Set(["anthropic.apiKey", "server.apiKey", "emailGateway.imap.auth.pass", "emailGateway.smtp.auth.pass"]);

const LABELS: Record<string, string> = {
  "anthropic.apiKey": "API Key",
  "anthropic.baseUrl": "Base URL",
  "anthropic.model": "Model",
  "anthropic.defaultOpusModel": "Default Opus Model",
  "anthropic.defaultSonnetModel": "Default Sonnet Model",
  "anthropic.defaultHaikuModel": "Default Haiku Model",
  "anthropic.smallFastModel": "Small Fast Model",
  "defaults.model": "Default Model",
  "defaults.effort": "Effort Level",
  "defaults.maxTurns": "Max Turns",
  "defaults.maxBudgetUsd": "Max Budget (USD)",
  "defaults.timeout": "Timeout (seconds)",
  "defaults.approvalTimeout": "Approval Timeout (seconds)",
  "server.port": "Port",
  "server.host": "Host",
  "server.apiKey": "API Key (server auth)",
  "server.timezone": "Timezone",
  "logging.level": "Log Level",
  "roles.evolution.triggerEvery": "Evolution Trigger Every (tasks)",
  "roles.evolution.reflectionThreshold": "Reflection Threshold (tokens)",
  "chat.sessionTimeoutMinutes": "Session Timeout (minutes)",
  "chat.maxSessionTurns": "Max Session Turns",
  "chat.autoTitle": "Auto-generate Session Title",
  "chat.archiveExtractMemory": "Extract Memory on Archive",
  "watchdog.rules.artifactCleanup.enabled": "Template Execution Artifact Cleanup Enabled",
  "watchdog.rules.artifactCleanup.ttlDays": "Artifact Retention (days)",
  "watchdog.rules.artifactCleanup.orphanGcMinAgeHours": "Orphan File GC Min Age (hours)",
  "memory.embeddingModel": "Embedding Model",
  "cost.dailyThresholdUsd": "Daily Spend Limit (USD)",
  "emailGateway.enabled": "Enabled",
  "emailGateway.address": "Central Email Address",
  "emailGateway.displayName": "Display Name",
  "emailGateway.imap.host": "IMAP Host",
  "emailGateway.imap.port": "IMAP Port",
  "emailGateway.imap.secure": "IMAP Secure",
  "emailGateway.imap.auth.user": "IMAP User",
  "emailGateway.imap.auth.pass": "IMAP Password",
  "emailGateway.imap.mailbox": "IMAP Mailbox",
  "emailGateway.smtp.host": "SMTP Host",
  "emailGateway.smtp.port": "SMTP Port",
  "emailGateway.smtp.secure": "SMTP Secure",
  "emailGateway.smtp.auth.user": "SMTP User",
  "emailGateway.smtp.auth.pass": "SMTP Password",
  "emailGateway.smtp.from": "SMTP From Address",
  "emailGateway.subjectPrefix": "Subject Prefix",
};

const SELECT_OPTIONS: Record<string, string[]> = {
  "defaults.effort": ["low", "medium", "high", "max"],
  "logging.level": ["debug", "info", "warn", "error"],
  "memory.embeddingModel": ["bge-small-zh-v1.5", "paraphrase-multilingual-MiniLM-L12-v2"],
  "server.timezone": [
    "system",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Singapore",
    "America/New_York",
    "America/Los_Angeles",
    "America/Chicago",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Paris",
    "UTC",
  ],
};

function formatRuntimeStatus(status: EmailGatewayRuntimeStatus | null): string {
  if (!status) return "not_checked";
  if (!status.enabled) return "disabled";
  if (!status.configured) return "not_configured";
  if (status.lastStatus === "stopped") return "disconnected";
  if (status.lastStatus === "error") return "failed";
  return status.lastStatus;
}

function statusBadgeClass(status: string): string {
  const base = "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium";
  if (status === "connected") {
    return `${base} border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] text-[var(--app-success-soft-text)]`;
  }
  if (status === "degraded" || status === "starting" || status === "connecting") {
    return `${base} border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] text-[var(--app-warning-soft-text)]`;
  }
  if (status === "failed") {
    return `${base} border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] text-[var(--app-danger-soft-text)]`;
  }
  return `${base} border-[var(--app-border)] bg-black/10 text-[var(--app-text-muted)]`;
}

export function Settings() {
  const [configData, setConfigData] = useState<Record<string, ConfigEntry>>({});
  const [mutablePaths, setMutablePaths] = useState<string[]>([]);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [envDiff, setEnvDiff] = useState<{ diffs: Array<{ configPath: string; envKey: string; dbValue: string; envValue: string }>; envFileExists: boolean } | null>(null);
  // List editor state for deniedReadPaths and approvalRequired
  const [listValues, setListValues] = useState<Record<string, string[]>>({});
  const [listDirty, setListDirty] = useState<Set<string>>(new Set());
  // Global custom env vars
  const [globalEnv, setGlobalEnv] = useState<Record<string, string>>({});
  const [emailTestStatus, setEmailTestStatus] = useState<EmailGatewayTestResult | null>(null);
  const [emailRuntimeStatus, setEmailRuntimeStatus] = useState<EmailGatewayRuntimeStatus | null>(null);
  const [emailTestLoading, setEmailTestLoading] = useState<EmailGatewayTestResult["stage"] | null>(null);
  const configVersion = useAppStore((s) => s.configVersion);

  // Warn on browser tab close/refresh with unsaved changes
  useEffect(() => {
    if (dirty.size === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty.size]);

  // Block SPA navigation with unsaved changes
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty.size > 0 && currentLocation.pathname !== nextLocation.pathname,
  );

  const loadConfig = useCallback(async () => {
    try {
      const data = await api<ConfigResponse>("/config");
      setConfigData(data.config);
      setMutablePaths(data.mutable);
      // Initialize edit values from config
      const values: Record<string, string> = {};
      for (const [path, entry] of Object.entries(data.config)) {
        values[path] = String(entry.value ?? "");
      }
      setEditValues(values);
      setDirty(new Set());
      // Initialize timezone from server config
      const tzValue = data.config["server.timezone"]?.value as string | undefined;
      if (tzValue) setTimezone(tzValue);
      // Initialize list editor values (deniedReadPaths, approvalRequired)
      const lists: Record<string, string[]> = {};
      for (const listPath of LIST_SECTIONS) {
        const entry = data.config[listPath];
        if (entry) {
          lists[listPath] = Array.isArray(entry.value) ? entry.value as string[] : [];
        }
      }
      setListValues(lists);
      setListDirty(new Set());
      // Fetch env diff
      const diffData = await api<{ diffs: Array<{ configPath: string; envKey: string; dbValue: string; envValue: string }>; envFileExists: boolean }>("/config/env-diff");
      setEnvDiff(diffData);
      // Fetch global custom env vars
      const envData = await api<{ env: Record<string, string> }>("/config/env");
      setGlobalEnv(envData.env);
      const emailStatus = await api<EmailGatewayRuntimeStatus>("/config/email-gateway/status");
      setEmailRuntimeStatus(emailStatus);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to load config" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // Re-fetch when config_changed is received via WebSocket
  useEffect(() => {
    if (configVersion > 0) {
      void loadConfig();
    }
  }, [configVersion, loadConfig]);

  const handleSyncToEnv = async () => {
    await api("/config/sync-to-env", { method: "POST" });
    setMessage({ type: "success", text: "Synced DB values to .env" });
    setEnvDiff(null);
  };

  const handleLoadFromEnv = async () => {
    await api("/config/load-from-env", { method: "POST" });
    setMessage({ type: "success", text: "Loaded .env values to DB" });
    void loadConfig();
  };

  const handleChange = (path: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [path]: value }));
    setDirty((prev) => new Set(prev).add(path));
    setMessage(null);
  };

  const handleEmailGatewayTest = async (stage: EmailGatewayTestResult["stage"]) => {
    const endpoint =
      stage === "imap"
        ? "/config/email-gateway/test-imap"
        : stage === "smtp"
          ? "/config/email-gateway/test-smtp"
          : "/config/email-gateway/test-roundtrip";
    setEmailTestLoading(stage);
    setMessage(null);
    try {
      const result = await api<EmailGatewayTestResult>(endpoint, { method: "POST" });
      setEmailTestStatus(result);
    } catch (err) {
      setEmailTestStatus({
        ok: false,
        stage,
        code: "unknown_error",
        message: err instanceof Error ? err.message : "Email Gateway test failed",
      });
    } finally {
      setEmailTestLoading(null);
    }
  };

  const handleSave = async () => {
    if (dirty.size === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const updates: Record<string, unknown> = {};
      for (const path of dirty) {
        const original = configData[path];
        let value: unknown = editValues[path];
        // Convert to number if original is number
        if (original && typeof original.value === "number") {
          value = Number(value);
          if (isNaN(value as number)) {
            setMessage({ type: "error", text: `"${LABELS[path] ?? path}" must be a number` });
            setSaving(false);
            return;
          }
        } else if (original && typeof original.value === "boolean" && path.startsWith("emailGateway.")) {
          value = value === "true";
        }
        updates[path] = value;
      }

      const result = await api<{ success: boolean; updated: string[]; errors: string[]; message: string }>("/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...updates,
          // Save list sections (deniedReadPaths, approvalRequired)
          ...Object.fromEntries(
            Array.from(listDirty).map((path) => [path, listValues[path] ?? []]),
          ),
        }),
      });

      if (result.updated.length > 0) {
        setMessage({ type: "success", text: `Updated ${result.updated.length} setting(s)` });
        // Update timezone in format module immediately for all displayed times
        if (result.updated.includes("server.timezone")) {
          const tzValue = editValues["server.timezone"];
          setTimezone(tzValue);
        }
      }
      if (result.errors.length > 0) {
        setMessage({ type: "error", text: result.errors.join("; ") });
      }
      setDirty(new Set());
      void loadConfig();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
      </div>
    );
  }

  if (Object.keys(configData).length === 0) {
    return (
      <EmptyState
        icon={<SettingsIcon size={32} />}
        title="No configuration"
        description="Config API not available"
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        compact
        description="Mutable fields, pending edits, and environment drift."
        metrics={[
          { label: "Editable", value: mutablePaths.length },
          { label: "Pending", value: dirty.size + listDirty.size },
          { label: "Env Drift", value: envDiff?.diffs.length ?? 0 },
        ]}
        actions={
          <div className="flex w-full justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => void loadConfig()}>
              <RefreshCw size={14} />
            </Button>
            {dirty.size > 0 && (
              <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                <Save size={14} />
                {saving ? "Saving..." : `Save (${dirty.size})`}
              </Button>
            )}
          </div>
        }
      />

      <SectionHeader
        title="Configuration Groups"
        compact
        description="Fields stay in place while changeable, restart-required, and pending state are clarified."
      />

      {message && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${message.type === "success" ? "border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] text-[var(--app-success-soft-text)]" : "border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] text-[var(--app-danger-soft-text)]"}`}>
          {message.text}
        </div>
      )}

      {envDiff && envDiff.diffs.length > 0 && (
        <Card className="surface-accent">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--app-text)]">
                .env and DB have {envDiff.diffs.length} different value(s)
              </p>
              <p className="mt-1 text-xs text-[var(--app-text-muted)]">
                {envDiff.diffs.map(d => d.envKey).join(", ")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <Button variant="ghost" size="sm" onClick={handleSyncToEnv}>
                Sync DB → .env
              </Button>
              <Button variant="ghost" size="sm" onClick={handleLoadFromEnv}>
                Load .env → DB
              </Button>
            </div>
          </div>
        </Card>
      )}

      {Object.entries(CATEGORIES).map(([key, { label, paths, mutablePaths: catMutablePaths }]) => {
        const allPaths = [...paths, ...(catMutablePaths ?? [])];
        const editableCount = allPaths.filter((path) => mutablePaths.includes(path)).length;
        return (
          <Card key={key}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-medium text-[var(--app-text)]">{label}</h2>
                <p className="mt-1 text-sm text-[var(--app-text-muted)]">{CATEGORY_DESCRIPTIONS[key] ?? "Configuration values for this system area."}</p>
              </div>
              <div className="rounded-full border border-[var(--app-border)] bg-black/10 px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">
                {editableCount}/{allPaths.length} editable
              </div>
            </div>
            <div className="space-y-3">
              {allPaths.map((path) => {
                const entry = configData[path];
                if (!entry) return null;
                const isMutable = mutablePaths.includes(path);
                const fieldLabel = LABELS[path] ?? path;
                const currentValue = editValues[path] ?? String(entry.value ?? "");
                const isDirty = dirty.has(path);
                const selectOpts = SELECT_OPTIONS[path];
                const isEmailGatewayBoolean = path.startsWith("emailGateway.") && typeof entry.value === "boolean";
                const inputId = `setting-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`;

                return (
                  <div key={path} className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-black/10 px-3 py-3 md:flex-row md:items-center md:gap-3">
                    <div className="flex min-w-0 items-center gap-1.5 md:w-56 md:shrink-0">
                      {!isMutable && <Lock size={12} className="text-[var(--app-text-subtle)]" />}
                      <label htmlFor={inputId} className="text-sm text-[var(--app-text-muted)]">{fieldLabel}</label>
                      {!isMutable && (
                        <span className="text-[10px] text-[var(--app-text-subtle)]">restart required</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      {selectOpts ? (
                        <>
                          <select
                            id={inputId}
                            className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none disabled:opacity-50"
                            value={currentValue}
                            onChange={(e) => handleChange(path, e.target.value)}
                            disabled={!isMutable}
                          >
                            {selectOpts.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                          {path === "memory.embeddingModel" && currentValue === "paraphrase-multilingual-MiniLM-L12-v2" && (
                            <p className="mt-1 text-[11px] text-[var(--app-warning)]">
                              切换模型后建议清空候选 belief 的 embedding 重算（384 维与现存 512 维向量混用会导致余弦计算维度不匹配）
                            </p>
                          )}
                        </>
                      ) : isEmailGatewayBoolean ? (
                        <select
                          id={inputId}
                          className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none disabled:opacity-50"
                          value={currentValue}
                          onChange={(e) => handleChange(path, e.target.value)}
                          disabled={!isMutable}
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          id={inputId}
                          className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none disabled:opacity-50"
                          type={SECRET_PATHS.has(path) ? "password" : "text"}
                          value={currentValue}
                          onChange={(e) => handleChange(path, e.target.value)}
                          disabled={!isMutable}
                          placeholder={SECRET_PATHS.has(path) ? "Enter to update" : undefined}
                        />
                      )}
                    </div>
                    <div className="text-left md:w-16 md:text-right">
                      {isDirty && isMutable && (
                        <span className="text-[10px] text-[var(--app-warning)]">modified</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {key === "emailGateway" && (
              <div className="mt-4 border-t border-[var(--app-border)] pt-4">
                <div className="mb-3 grid gap-2 text-sm md:grid-cols-3">
                  <div>
                    <span className="text-[var(--app-text-subtle)]">Runtime status</span>
                    <p>
                      <span className={statusBadgeClass(formatRuntimeStatus(emailRuntimeStatus))}>
                        {formatRuntimeStatus(emailRuntimeStatus)}
                      </span>
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--app-text-subtle)]">Last test</span>
                    <p>
                      {emailTestStatus ? (
                        <span className={statusBadgeClass(emailTestStatus.ok ? "connected" : "failed")}>
                          {emailTestStatus.stage} {emailTestStatus.code ?? ""}: {emailTestStatus.message}
                        </span>
                      ) : (
                        <span className={statusBadgeClass("not_checked")}>Not checked</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--app-text-subtle)]">Last checked</span>
                    <p className="text-[var(--app-text-muted)]">{emailRuntimeStatus?.lastCheckedAt ? new Date(emailRuntimeStatus.lastCheckedAt).toLocaleString() : "Never"}</p>
                  </div>
                </div>
                <div className="mb-3 text-sm">
                  <span className="text-[var(--app-text-subtle)]">Last error</span>
                  <p className="text-[var(--app-danger-soft-text)]">{emailRuntimeStatus?.lastError ?? "None"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void handleEmailGatewayTest("imap")} disabled={emailTestLoading !== null}>
                    <TestTube2 size={14} />
                    {emailTestLoading === "imap" ? "Testing IMAP..." : "Test IMAP"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleEmailGatewayTest("smtp")} disabled={emailTestLoading !== null}>
                    <TestTube2 size={14} />
                    {emailTestLoading === "smtp" ? "Testing SMTP..." : "Test SMTP"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleEmailGatewayTest("roundtrip")} disabled={emailTestLoading !== null}>
                    <Send size={14} />
                    {emailTestLoading === "roundtrip" ? "Sending probe..." : "Send test email"}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        );
      })}

      {/* Global custom environment variables */}
      <EnvVarEditor
        envVars={globalEnv}
        onSave={() => void loadConfig()}
        mode="global"
        title="Environment Variables"
      />

      {/* API Key section — rotate and logout */}
      <ApiKeySection />

      {/* Advanced section: deniedReadPaths + approvalRequired list editors */}
      <AdvancedSecuritySection
        mutablePaths={mutablePaths}
        listValues={listValues}
        listDirty={listDirty}
        setListValues={setListValues}
        setListDirty={(fn) => setListDirty(fn as Set<string>)}
        dirty={dirty}
      />

      {/* Feature Miner pre-fetch limits */}
      <FeatureMinerConfigSection />

      {/* Unsaved changes navigation guard */}
      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have {dirty.size + listDirty.size} unsaved change(s). Discard and leave?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ConfigEntry {
  value: unknown;
  mutable: boolean;
}

interface ConfigResponse {
  config: Record<string, ConfigEntry>;
  mutable: string[];
  restartRequired: string[];
}

/** List-editor section for deniedReadPaths and approvalRequired in Settings/Advanced */
function AdvancedSecuritySection({
  mutablePaths,
  listValues,
  listDirty,
  setListValues,
  setListDirty,
  dirty,
}: {
  mutablePaths: string[];
  listValues: Record<string, string[]>;
  listDirty: Set<string>;
  setListValues: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setListDirty: (fn: React.SetStateAction<Set<string>>) => void;
  dirty: Set<string>;
}) {
  const [newDeniedPath, setNewDeniedPath] = useState("");
  const [newApprovalPattern, setNewApprovalPattern] = useState("");

  const isDeniedMutable = mutablePaths.includes("defaults.deniedReadPaths");
  const isApprovalMutable = mutablePaths.includes("defaults.approvalRequired");

  const deniedPaths = listValues["defaults.deniedReadPaths"] ?? [];
  const approvalPatterns = listValues["defaults.approvalRequired"] ?? [];

  const SYSTEM_DENIED_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg", "/etc/shadow"];
  const SYSTEM_APPROVAL_PATTERNS = [
    "rm -rf *",
    "git push*",
    "git reset*",
    "curl * -X POST*",
    "curl * --request POST*",
  ];

  const isSystemDeniedPath = (p: string) =>
    SYSTEM_DENIED_PATHS.some((s) => {
      const expanded = s.startsWith("~/") ? s : s;
      return p === expanded || p === s;
    });

  const isSystemApprovalPattern = (p: string) => SYSTEM_APPROVAL_PATTERNS.includes(p);

  const addDeniedPath = () => {
    const trimmed = newDeniedPath.trim();
    if (!trimmed || deniedPaths.includes(trimmed)) return;
    setListValues((prev) => ({ ...prev, "defaults.deniedReadPaths": [...deniedPaths, trimmed] }));
    setListDirty((prev) => new Set(prev).add("defaults.deniedReadPaths"));
    setNewDeniedPath("");
  };

  const removeDeniedPath = (p: string) => {
    if (isSystemDeniedPath(p)) return; // system defaults are not removable
    setListValues((prev) => ({ ...prev, "defaults.deniedReadPaths": deniedPaths.filter((x) => x !== p) }));
    setListDirty((prev) => new Set(prev).add("defaults.deniedReadPaths"));
  };

  const addApprovalPattern = () => {
    const trimmed = newApprovalPattern.trim();
    if (!trimmed || approvalPatterns.includes(trimmed)) return;
    setListValues((prev) => ({ ...prev, "defaults.approvalRequired": [...approvalPatterns, trimmed] }));
    setListDirty((prev) => new Set(prev).add("defaults.approvalRequired"));
    setNewApprovalPattern("");
  };

  const removeApprovalPattern = (p: string) => {
    if (isSystemApprovalPattern(p)) return; // system defaults are not removable
    setListValues((prev) => ({ ...prev, "defaults.approvalRequired": approvalPatterns.filter((x) => x !== p) }));
    setListDirty((prev) => new Set(prev).add("defaults.approvalRequired"));
  };

  const totalDirty = dirty.size + listDirty.size;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--app-text)]">Advanced</h2>
        {totalDirty > 0 && (
          <span className="text-[10px] text-[var(--app-warning)]">{listDirty.size} modified</span>
        )}
      </div>

      {/* Denied Read Paths */}
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-medium text-[var(--app-text-muted)]">Denied Read Paths</h3>
          {!isDeniedMutable && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
              <Lock size={ICON_SIZE.xs} /> restart required
            </span>
          )}
        </div>
        <p className="mb-2 text-xs text-[var(--app-text-subtle)]">
          Paths blocked at both the SDK and OS layer for all roles. System defaults (locked) cannot be removed.
          Uses <code className="text-[var(--app-text-muted)]">*</code> as wildcard.
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {deniedPaths.map((p) => {
            const isSystem = isSystemDeniedPath(p);
            return (
              <span
                key={p}
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                  isSystem
                    ? "border-[var(--app-border)] bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)]"
                    : "border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] text-[var(--app-danger-soft-text)]"
                }`}
              >
                {isSystem && <Lock size={ICON_SIZE.xs} />}
                {p}
                {!isSystem && isDeniedMutable && (
                  <button
                    type="button"
                    className="ml-0.5 text-[var(--app-danger)] hover:text-[var(--app-danger-soft-text)]"
                    onClick={() => removeDeniedPath(p)}
                  >
                    <X size={ICON_SIZE.xs} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {isDeniedMutable && (
          <div className="flex gap-1.5">
            <input
              className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              placeholder="/absolute/path or ~/path"
              value={newDeniedPath}
              onChange={(e) => setNewDeniedPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addDeniedPath(); } }}
            />
            <Button variant="ghost" size="sm" className="scale-75" onClick={() => addDeniedPath()}>
              Add
            </Button>
          </div>
        )}
      </div>

      {/* Approval Required Patterns */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-medium text-[var(--app-text-muted)]">Approval Required Patterns</h3>
          {!isApprovalMutable && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--app-text-subtle)]">
              <Lock size={ICON_SIZE.xs} /> restart required
            </span>
          )}
        </div>
        <p className="mb-2 text-xs text-[var(--app-text-subtle)]">
          Operations matching these glob patterns require user approval before execution.
          Uses SDK Permission Rule glob syntax (<code className="text-[var(--app-text-muted)]">*</code> = wildcard, e.g.,{" "}
          <code className="text-[var(--app-text-muted)]">rm -rf *</code>).
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {approvalPatterns.map((p) => {
            const isSystem = isSystemApprovalPattern(p);
            return (
              <span
                key={p}
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
                  isSystem
                    ? "border-[var(--app-border)] bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)]"
                    : "border-[var(--app-warning-soft-border)] bg-[var(--app-warning-soft-bg)] text-[var(--app-warning-soft-text)]"
                }`}
              >
                {isSystem && <Lock size={ICON_SIZE.xs} />}
                {p}
                {!isSystem && isApprovalMutable && (
                  <button
                    type="button"
                    className="ml-0.5 text-[var(--app-warning)] hover:text-[var(--app-warning-soft-text)]"
                    onClick={() => removeApprovalPattern(p)}
                  >
                    <X size={ICON_SIZE.xs} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
        {isApprovalMutable && (
          <div className="flex gap-1.5">
            <input
              className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              placeholder='e.g. "curl * --request POST *"'
              value={newApprovalPattern}
              onChange={(e) => setNewApprovalPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addApprovalPattern(); } }}
            />
            <Button variant="ghost" size="sm" className="scale-75" onClick={() => addApprovalPattern()}>
              Add
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Feature Miner pre-fetch limits section in Settings/Advanced. */
function FeatureMinerConfigSection() {
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; presetId?: string; config?: Record<string, unknown> }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [maxSessions, setMaxSessions] = useState(15);
  const [maxMessagesPerSession, setMaxMessagesPerSession] = useState(30);
  const [messageCharCap, setMessageCharCap] = useState(500);
  const [dirty, setDirty] = useState(false);

  // Hard ceilings per DP-V.4
  const MAX_SESSIONS_CAP = 50;
  const MAX_MESSAGES_CAP = 100;
  const MAX_CHARS_CAP = 2000;

  const featureMiningTemplateId = templates.find((t) => t.presetId === "feature-mining")?.id;

  useEffect(() => {
    void (async () => {
      try {
        // Find the feature-mining template from installed list
        const res = await api<{ templates: Array<{ id: string; name: string; presetId?: string; config?: Record<string, unknown> }> }>("/task-templates");
        const fm = res.templates.find((t) => t.presetId === "feature-mining");
        if (fm) {
          setTemplates([fm]);
          setMaxSessions((fm.config?.max_sessions as number) ?? 15);
          setMaxMessagesPerSession((fm.config?.max_messages_per_session as number) ?? 30);
          setMessageCharCap((fm.config?.message_char_cap as number) ?? 500);
        }
      } catch {
        // feature-mining template not seeded yet
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSave = async () => {
    if (!featureMiningTemplateId) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateTaskTemplateConfig(featureMiningTemplateId, {
        max_sessions: maxSessions,
        max_messages_per_session: maxMessagesPerSession,
        message_char_cap: messageCharCap,
      });
      setMessage({ type: "success", text: "Feature Miner limits saved" });
      setDirty(false);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;
  if (!featureMiningTemplateId) return null;

  // Estimate worst-case token count (rough: 4 chars per token)
  const worstCaseTokens = maxSessions * maxMessagesPerSession * Math.min(messageCharCap, 100) / 4;
  const estimateDisplay = `~${Math.round(worstCaseTokens).toLocaleString()} tokens (worst case)`;

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--app-text)]">Feature Miner Pre-fetch Limits</h2>
          <p className="mt-1 text-xs text-[var(--app-text-muted)]">
            Controls how many chat sessions and messages the Feature Miner scans per run.
            Hard ceilings prevent prompt size from exceeding the model&apos;s context window.
          </p>
        </div>
        {dirty && (
          <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        )}
      </div>

      {message && (
        <div className={`mb-3 rounded px-3 py-2 text-xs ${
          message.type === "success"
            ? "border border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] text-[var(--app-success-soft-text)]"
            : "border border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] text-[var(--app-danger-soft-text)]"
        }`}>
          {message.text}
        </div>
      )}

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Max sessions */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--app-text-muted)]" htmlFor="fm-max-sessions">
                Max Sessions
              </label>
              <span className="text-[10px] text-[var(--app-text-subtle)]">ceiling: {MAX_SESSIONS_CAP}</span>
            </div>
            <input
              id="fm-max-sessions"
              type="number"
              min={1}
              max={MAX_SESSIONS_CAP}
              value={maxSessions}
              onChange={(e) => {
                const v = Math.min(MAX_SESSIONS_CAP, Math.max(1, parseInt(e.target.value) || 1));
                setMaxSessions(v);
                setDirty(true);
              }}
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            />
            <p className="text-[10px] text-[var(--app-text-subtle)]">
              Sessions to scan (most recent first). Default: 15.
            </p>
          </div>

          {/* Max messages per session */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--app-text-muted)]" htmlFor="fm-max-messages">
                Max Messages / Session
              </label>
              <span className="text-[10px] text-[var(--app-text-subtle)]">ceiling: {MAX_MESSAGES_CAP}</span>
            </div>
            <input
              id="fm-max-messages"
              type="number"
              min={1}
              max={MAX_MESSAGES_CAP}
              value={maxMessagesPerSession}
              onChange={(e) => {
                const v = Math.min(MAX_MESSAGES_CAP, Math.max(1, parseInt(e.target.value) || 1));
                setMaxMessagesPerSession(v);
                setDirty(true);
              }}
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            />
            <p className="text-[10px] text-[var(--app-text-subtle)]">
              Most recent messages per session. Default: 30.
            </p>
          </div>

          {/* Message char cap */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[var(--app-text-muted)]" htmlFor="fm-char-cap">
                Message Char Cap
              </label>
              <span className="text-[10px] text-[var(--app-text-subtle)]">ceiling: {MAX_CHARS_CAP}</span>
            </div>
            <input
              id="fm-char-cap"
              type="number"
              min={10}
              max={MAX_CHARS_CAP}
              value={messageCharCap}
              onChange={(e) => {
                const v = Math.min(MAX_CHARS_CAP, Math.max(10, parseInt(e.target.value) || 10));
                setMessageCharCap(v);
                setDirty(true);
              }}
              className="w-full rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
            />
            <p className="text-[10px] text-[var(--app-text-subtle)]">
              Max characters per message. Default: 500.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2">
          <div>
            <p className="text-xs font-medium text-[var(--app-text-muted)]">Estimated worst-case prompt size</p>
            <p className="text-xs text-[var(--app-text-subtle)]">{estimateDisplay}</p>
          </div>
          {worstCaseTokens > 150_000 && (
            <span className="text-[10px] text-[var(--app-warning)]">Near context window limit</span>
          )}
        </div>
      </div>
    </Card>
  );
}

function ApiKeySection() {
  const storedKey = getStoredApiKey() ?? "";
  const [showKey, setShowKey] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const masked = storedKey.length > 12
    ? storedKey.slice(0, 4) + "****" + storedKey.slice(-4)
    : "(no key in localStorage)";

  async function doRotate() {
    setRotating(true);
    setError(null);
    try {
      const rotated = await rotateApiKey();
      setStoredApiKey(rotated);
      setNewKey(rotated);
      setConfirming(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setConfirming(false);
    } finally {
      setRotating(false);
    }
  }

  function doLogout() {
    clearStoredApiKey();
    redirectToLogin();
  }

  return (
    <Card>
      <SectionHeader title="Adam API Key" description="Rotate or sign out" />
      <div className="mt-3 space-y-3">
        <div className="flex items-center gap-3">
          <code className="flex-1 rounded bg-[var(--app-bg)] px-3 py-2 font-mono text-sm">
            {showKey ? (storedKey || "(no key)") : masked}
          </code>
          <Button variant="ghost" size="sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? "Hide" : "Show"}
          </Button>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={rotating}>
            <RefreshCw size={ICON_SIZE.xs} className="mr-1" />
            Rotate key
          </Button>
          <Button variant="ghost" size="sm" onClick={doLogout}>
            <X size={ICON_SIZE.xs} className="mr-1" />
            Log out
          </Button>
        </div>

        {error && (
          <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <p className="text-xs text-[var(--app-muted)]">
          Rotating generates a new key, writes it to <code>~/.adam/adam.key</code>, and invalidates
          the old key on every device that uses the Adam API (Web UI, TUI, other browsers).
          Channel adapters (WeChat, Telegram, Discord) keep their own credentials and are NOT affected.
          Only external callers of your <code>/webhooks/:name</code> endpoints need the new key.
        </p>
      </div>

      <AlertDialog open={confirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The old key stops working immediately. Other browsers/TUI sessions and any
              external callers of <code>/webhooks/:name</code> will return 401 until updated.
              Channel adapters (WeChat, Telegram, Discord) use their own credentials and
              are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirming(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doRotate} disabled={rotating}>
              {rotating ? "Rotating..." : "Rotate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!newKey}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New API key</AlertDialogTitle>
            <AlertDialogDescription>
              Save this somewhere safe. Other devices and channels need to be updated with this key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <code className="mt-2 block break-all rounded bg-[var(--app-bg)] p-3 font-mono text-xs">
            {newKey}
          </code>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                if (newKey) void navigator.clipboard.writeText(newKey);
              }}
            >
              Copy
            </AlertDialogAction>
            <AlertDialogAction onClick={() => setNewKey(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
