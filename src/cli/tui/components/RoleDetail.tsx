import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import type { Role, SdkPermissionMode } from "../../../shared/types.js";
import type { ResolvedOsCapabilityMeta, RoleOsCapability } from "../../../shared/os-capabilities.js";
import { BUILT_IN_TOOLS } from "../../../shared/constants.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";

type DetailMode =
  | "view"        // read-only overview
  | "edit-cag"    // CAG prompt editor
  | "edit-dirs"   // additional directories manager
  | "edit-dirs-add" // add directory text input
  | "edit-tools"  // tool permission toggler
  | "edit-exec"   // execution config editor
  | "edit-channels"  // allowedChannels editor
  | "edit-permissions" // permissionMode + bash patterns editor
  | "edit-oscaps" // role OS capabilities editor
  | "edit-oscaps-targets" // automation target editor
  | "edit-env"    // env vars list
  | "edit-env-add-key"  // adding new env var key
  | "edit-env-add-value" // adding new env var value
  | "edit-env-edit-value" // editing env var value
  | "edit-plugins"     // bound plugins list manager
  | "edit-plugins-add"; // available plugins picker to bind

interface RoleDetailProps {
  roleId: string;
  onBack: () => void;
}

interface ConfigResponse {
  config: Record<string, { value: unknown; mutable: boolean }>;
  mutable: string[];
  restartRequired: string[];
  sandbox: { platform: string; available: boolean };
  osCapabilities: { registry: ResolvedOsCapabilityMeta[] };
}

const AUTOMATION_TARGET_BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function RoleDetail({ roleId, onBack }: RoleDetailProps) {
  const [role, setRole] = useState<Role | null>(null);
  const [projectPlugins, setProjectPlugins] = useState<Array<{ id: string; name: string; version: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<DetailMode>("view");

  // CAG editor state
  const [cagValue, setCagValue] = useState("");

  // Directories manager state
  const [selectedDirIdx, setSelectedDirIdx] = useState(0);
  const [newDirValue, setNewDirValue] = useState("");
  const [dirSuggestions, setDirSuggestions] = useState<string[]>([]);
  const [dirActiveIdx, setDirActiveIdx] = useState(0);

  // Tools toggle state
  const [localTools, setLocalTools] = useState<Set<string>>(new Set());

  // Execution config state
  const [execMode, setExecMode] = useState<string>("inline");
  const [model, setModel] = useState("");
  const [effortTier, setEffortTier] = useState("");
  const [maxBudget, setMaxBudget] = useState("");

  const [availableChannels, setAvailableChannels] = useState<Array<{ name: string; id: string }>>([]);
  const [channelSelection, setChannelSelection] = useState<Set<string>>(new Set());
  const [channelCursor, setChannelCursor] = useState(0);

  // Permission config state
  const [permMode, setPermMode] = useState<SdkPermissionMode>("default");
  const [allowedBash, setAllowedBash] = useState("");
  const [deniedBash, setDeniedBash] = useState("");
  const [permField, setPermField] = useState<"mode" | "allowed" | "denied">("mode");

  // Global deniedReadPaths (read-only display)
  const [deniedReadPaths, setDeniedReadPaths] = useState<string[]>([]);
  const [sandboxInfo, setSandboxInfo] = useState<{ platform: string; available: boolean } | null>(null);
  const [osCapabilityRegistry, setOsCapabilityRegistry] = useState<ResolvedOsCapabilityMeta[]>([]);
  const [localOsCapabilities, setLocalOsCapabilities] = useState<RoleOsCapability[]>([]);
  const [automationTargetsInput, setAutomationTargetsInput] = useState("");

  // Env vars editor state
  const [envIndex, setEnvIndex] = useState(0);
  const [envNewKey, setEnvNewKey] = useState("");
  const [envNewValue, setEnvNewValue] = useState("");
  const [envEditValue, setEnvEditValue] = useState("");

  // Plugin manager state
  const [pluginCursor, setPluginCursor] = useState(0);
  const [availablePlugins, setAvailablePlugins] = useState<Array<{ id: string; name: string; version: string }>>([]);
  const [pluginAddCursor, setPluginAddCursor] = useState(0);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [roleWorkspacePath, setRoleWorkspacePath] = useState<string>("");

  const { message, setMessage } = useFlashMessage();

  const loadRole = useCallback(() => {
    setLoading(true);
    request<{ role: Role; projectPlugins: Array<{ id: string; name: string; version: string }>; workspacePath: string }>(`/roles/${roleId}`)
      .then(({ role, projectPlugins: pp, workspacePath: wp }) => {
        setRole(role);
        setProjectPlugins(pp ?? []);
        setRoleWorkspacePath(wp ?? "");
        setCagValue(role.cagPrompt ?? "");
        setLocalTools(new Set(role.allowedTools ?? []));
        setExecMode(role.executionMode ?? "inline");
        setModel(role.model ?? "");
        setEffortTier(role.effortTier ?? "");
        setMaxBudget(role.maxBudgetUsd != null ? String(role.maxBudgetUsd) : "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [roleId]);

  useEffect(() => {
    loadRole();
    // Fetch global deniedReadPaths (read-only display in role detail)
    request<ConfigResponse>("/config")
      .then((cfg) => {
        const val = cfg.config["defaults.deniedReadPaths"]?.value;
        if (Array.isArray(val)) setDeniedReadPaths(val as string[]);
        setSandboxInfo(cfg.sandbox);
        setOsCapabilityRegistry(cfg.osCapabilities?.registry ?? []);
      })
      .catch(() => {});
  }, [loadRole]);

  // Sync derived state when role reloads
  useEffect(() => {
    setExecMode(role?.executionMode ?? "inline");
    setModel(role?.model ?? "");
    setEffortTier(role?.effortTier ?? "");
    setMaxBudget(role?.maxBudgetUsd != null ? String(role?.maxBudgetUsd) : "");
    setPermMode(role?.permissionMode ?? "default");
    setAllowedBash((role?.allowedBashPatterns ?? []).join(", "));
    setDeniedBash((role?.deniedBashPatterns ?? []).join(", "));
    setLocalOsCapabilities(role?.osCapabilities ?? []);
    const automationTargets = role?.osCapabilities?.find((entry) => entry.id === "automation")?.targets ?? [];
    setAutomationTargetsInput(automationTargets.join(", "));
  }, [role?.id, role?.executionMode, role?.model, role?.effortTier, role?.maxBudgetUsd, role?.permissionMode, role?.allowedBashPatterns, role?.deniedBashPatterns, role?.osCapabilities]);

  // ---- Save helpers ----

  const saveCag = useCallback(async () => {
    if (!role) return;
    try {
      await request(`/roles/${role.id}`, {
        method: "PATCH",
        body: { cagPrompt: cagValue },
      });
      setMessage("CAG prompt saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, cagValue, loadRole, setMessage]);

  const saveDirs = useCallback(async () => {
    if (!role) return;
    try {
      await request(`/roles/${role.id}`, {
        method: "PATCH",
        body: { additionalDirectories: dirs },
      });
      setMessage("Directories saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, loadRole, setMessage]);

  const saveTools = useCallback(async () => {
    if (!role) return;
    try {
      await request(`/roles/${role.id}`, {
        method: "PATCH",
        body: { allowedTools: Array.from(localTools) },
      });
      setMessage("Tool permissions saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, localTools, loadRole, setMessage]);

  const saveExec = useCallback(async () => {
    if (!role) return;
    const body: Record<string, unknown> = { executionMode: execMode };
    if (model !== undefined) body.model = model;
    body.effortTier = effortTier === "" ? null : effortTier;
    const budget = parseFloat(maxBudget);
    if (!isNaN(budget)) body.maxBudgetUsd = budget;
    try {
      await request(`/roles/${role.id}`, { method: "PATCH", body });
      setMessage("Execution config saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, execMode, model, effortTier, maxBudget, loadRole, setMessage]);

  const savePermissions = useCallback(async () => {
    if (!role) return;
    const body: Record<string, unknown> = { permissionMode: permMode };
    const parsedAllowed = allowedBash.split(",").map((s) => s.trim()).filter(Boolean);
    const parsedDenied = deniedBash.split(",").map((s) => s.trim()).filter(Boolean);
    body.allowedBashPatterns = parsedAllowed.length > 0 ? parsedAllowed : [];
    body.deniedBashPatterns = parsedDenied.length > 0 ? parsedDenied : [];
    try {
      await request(`/roles/${role.id}`, { method: "PATCH", body });
      setMessage("Permission config saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, permMode, allowedBash, deniedBash, loadRole, setMessage]);

  const normalizeOsCapabilities = useCallback((entries: RoleOsCapability[]): RoleOsCapability[] => {
    const deduped = new Map<string, RoleOsCapability>();
    for (const entry of entries) {
      if (!entry.id) continue;
      const next: RoleOsCapability = { id: entry.id };
      if (entry.targets?.length) {
        next.targets = Array.from(new Set(entry.targets.map((target) => target.trim()).filter(Boolean)));
      }
      deduped.set(entry.id, next);
    }
    return Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id));
  }, []);

  const saveOsCapabilities = useCallback(async () => {
    if (!role) return;
    const normalized = normalizeOsCapabilities(localOsCapabilities);
    const automationTargets = normalized.find((entry) => entry.id === "automation")?.targets ?? [];
    if (normalized.some((entry) => entry.id === "automation") && (
      automationTargets.length === 0 || automationTargets.some((target) => !AUTOMATION_TARGET_BUNDLE_ID_RE.test(target))
    )) {
      setMessage("Automation requires valid bundle id targets", "error");
      return;
    }
    try {
      await request(`/roles/${role.id}`, {
        method: "PATCH",
        body: { osCapabilities: normalized },
      });
      setMessage("OS capabilities saved", "success");
      setMode("view");
      loadRole();
    } catch (err) {
      setMessage(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [role, localOsCapabilities, normalizeOsCapabilities, loadRole, setMessage]);

  const installToRole = useCallback(async (pluginId: string) => {
    if (!roleWorkspacePath) {
      setMessage("workspace path not loaded yet", "error");
      return;
    }
    setPluginBusy(true);
    try {
      await request(`/plugins/install/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: roleWorkspacePath }),
      });
      setMessage(`Bound ${pluginId.split("@")[0]}`, "success");
      loadRole();
    } catch (err) {
      setMessage(`Bind failed: ${err instanceof Error ? err.message : "unknown"}`, "error");
    } finally {
      setPluginBusy(false);
    }
  }, [roleWorkspacePath, loadRole, setMessage]);

  const uninstallFromRole = useCallback(async (pluginId: string) => {
    if (!roleWorkspacePath) {
      setMessage("workspace path not loaded yet", "error");
      return;
    }
    setPluginBusy(true);
    try {
      await request(`/plugins/uninstall/${encodeURIComponent(pluginId)}`, {
        method: "POST",
        body: JSON.stringify({ scope: "project", cwd: roleWorkspacePath }),
      });
      setMessage(`Unbound ${pluginId.split("@")[0]}`, "success");
      loadRole();
    } catch (err) {
      setMessage(`Unbind failed: ${err instanceof Error ? err.message : "unknown"}`, "error");
    } finally {
      setPluginBusy(false);
    }
  }, [roleWorkspacePath, loadRole, setMessage]);

  // ---- Derived ----

  const dirs = role?.additionalDirectories ?? [];

  // ---- useInput ----

  useInput((input, key) => {
    // Shared: Esc always returns to view; 'r' always refreshes
    if (key.escape) { setMode("view"); return; }
    if (input === "r") { loadRole(); return; }

    switch (mode) {
      case "view": {
        if (input === "c") { setMode("edit-cag"); return; }
        if (input === "d") { setMode("edit-dirs"); setSelectedDirIdx(0); setNewDirValue(""); return; }
        if (input === "t") { setMode("edit-tools"); return; }
        if (input === "o") { setMode("edit-oscaps"); return; }
        if (input === "x") { setMode("edit-exec"); return; }
        if (input === "h") {
          // Load channels and enter edit-channels mode
          request<{ channels: Array<{ id: string; name: string; enabled: boolean }> }>("/channels?enabled=true")
            .then(({ channels }) => {
              setAvailableChannels(channels.map((c) => ({ name: c.name, id: c.id })));
              setChannelSelection(new Set(role?.allowedChannels ?? []));
              setChannelCursor(0);
              setMode("edit-channels");
            })
            .catch(() => setMessage("Failed to load channels", "error"));
          return;
        }
        if (input === "p") {
          setPermMode(role?.permissionMode ?? "default");
          setAllowedBash((role?.allowedBashPatterns ?? []).join(", "));
          setDeniedBash((role?.deniedBashPatterns ?? []).join(", "));
          setPermField("mode");
          setMode("edit-permissions");
          return;
        }
        if (input === "v") {
          setEnvIndex(0);
          setMode("edit-env");
          return;
        }
        if (input === "b") {
          setPluginCursor(0);
          setMode("edit-plugins");
          return;
        }
        if (input === "i") {
          // Toggle inheritUserSettings immediately
          if (!role) return;
          const newValue = !role.inheritUserSettings;
          request(`/roles/${role.id}`, { method: "PATCH", body: { inheritUserSettings: newValue } })
            .then(() => { setMessage(`Inherit user settings: ${newValue ? "ON" : "OFF"}`, "success"); loadRole(); })
            .catch(() => setMessage("Failed to toggle", "error"));
          return;
        }
        if (input === "R" && role?.presetId) {
          // Restore preset to canonical values
          request(`/presets/role/${role.presetId}/restore`, { method: "POST" })
            .then(() => { setMessage("Preset restored", "success"); loadRole(); })
            .catch((err) => setMessage(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, "error"));
          return;
        }
        break;
      }

      case "edit-cag": {
        if (key.ctrl && input === "s") { saveCag(); return; }
        break;
      }

      case "edit-dirs": {
        if (input === "s") { saveDirs(); return; }
        if (input === "a") { setMode("edit-dirs-add"); return; }
        if (input === "m" && dirs.length > 0) {
          const selected = dirs[selectedDirIdx];
          if (selected) {
            setRole((prev) =>
              prev
                ? {
                    ...prev,
                    additionalDirectories: prev.additionalDirectories?.map((d, i) =>
                      i === selectedDirIdx
                        ? { ...(typeof d === "string" ? { path: d } : d), mode: (d as { mode?: string }).mode === "ro" ? "rw" : "ro" }
                        : d,
                    ),
                  }
                : prev,
            );
            const newMode = selected.mode === "ro" ? "rw" : "ro";
            setMessage(`Mode set to ${newMode.toUpperCase()}`, "success");
          }
          return;
        }
        if (input === "x" && dirs.length > 0) {
          setRole((prev) =>
            prev ? { ...prev, additionalDirectories: dirs.filter((_, i) => i !== selectedDirIdx) } : prev,
          );
          setSelectedDirIdx((i) => Math.max(0, Math.min(i, dirs.length - 2)));
          return;
        }
        if (key.upArrow) { setSelectedDirIdx((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setSelectedDirIdx((i) => Math.min(dirs.length - 1, i + 1)); return; }
        break;
      }

      case "edit-dirs-add": {
        if (key.escape) { setMode("edit-dirs"); setNewDirValue(""); setDirSuggestions([]); return; }
        // Enter with suggestions shown: select the highlighted suggestion
        if (key.return && dirSuggestions.length > 0) {
          const selected = dirSuggestions[dirActiveIdx];
          if (selected) {
            setNewDirValue(selected.endsWith("/") ? selected : selected + "/");
            setDirSuggestions([]);
          }
          return;
        }
        // Enter without suggestions: add the typed path
        if (key.return) {
          const trimmed = newDirValue.trim();
          if (trimmed && trimmed.startsWith("/")) {
            setRole((prev) =>
              prev
                ? { ...prev, additionalDirectories: [...(prev.additionalDirectories ?? []), { path: trimmed, mode: "rw" as const }] }
                : prev,
            );
            setNewDirValue("");
            setDirSuggestions([]);
            setMode("edit-dirs");
          } else {
            setMessage("Path must be absolute (must start with /)", "error");
          }
          return;
        }
        if (key.tab) {
          const prefix = newDirValue.trim();
          if (!prefix || !prefix.startsWith("/")) return;
          void request<{ suggestions: string[] }>(
            `/fs/suggest-dirs?prefix=${encodeURIComponent(prefix)}`,
          ).then(({ suggestions }) => {
            if (suggestions.length === 1) {
              // Single match: auto-fill and append / for further exploration
              setNewDirValue(suggestions[0]! + "/");
              setDirSuggestions([]);
            } else if (suggestions.length > 1) {
              setDirSuggestions(suggestions);
              setDirActiveIdx(0);
            }
          }).catch(() => {
            setDirSuggestions([]);
          });
          return;
        }
        if (key.upArrow && dirSuggestions.length > 0) {
          setDirActiveIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow && dirSuggestions.length > 0) {
          setDirActiveIdx((i) => Math.min(dirSuggestions.length - 1, i + 1));
          return;
        }
        break;
      }

      case "edit-tools": {
        if (input === "s") { saveTools(); return; }
        // Number keys 1-9 select tools to toggle
        const toolIdx = parseInt(input, 10) - 1;
        if (!isNaN(toolIdx) && toolIdx >= 0 && toolIdx < BUILT_IN_TOOLS.length) {
          const tool = BUILT_IN_TOOLS[toolIdx]!;
          setLocalTools((prev) => {
            const next = new Set(prev);
            if (next.has(tool)) next.delete(tool); else next.add(tool);
            return next;
          });
          return;
        }
        break;
      }

      case "edit-oscaps": {
        if (input === "s") { void saveOsCapabilities(); return; }
        if (input === "a" && localOsCapabilities.some((entry) => entry.id === "automation")) {
          const currentTargets = localOsCapabilities.find((entry) => entry.id === "automation")?.targets ?? [];
          setAutomationTargetsInput(currentTargets.join(", "));
          setMode("edit-oscaps-targets");
          return;
        }

        const editableCaps = osCapabilityRegistry.filter((meta) => meta.editable);
        const capIdx = parseInt(input, 10) - 1;
        if (!isNaN(capIdx) && capIdx >= 0 && capIdx < editableCaps.length) {
          const capability = editableCaps[capIdx]!;
          setLocalOsCapabilities((prev) => {
            const exists = prev.some((entry) => entry.id === capability.id);
            if (exists) return prev.filter((entry) => entry.id !== capability.id);
            return [...prev, { id: capability.id, targets: capability.id === "automation" ? [] : undefined }];
          });
          return;
        }
        break;
      }

      case "edit-oscaps-targets": {
        if (key.return) {
          const targets = automationTargetsInput
            .split(",")
            .map((target) => target.trim())
            .filter(Boolean);
          setLocalOsCapabilities((prev) => prev.map((entry) => (
            entry.id === "automation" ? { ...entry, targets } : entry
          )));
          setMode("edit-oscaps");
          return;
        }
        break;
      }

      case "edit-exec": {
        if (input === "s") { saveExec(); return; }
        if (key.tab) {
          setExecMode((m) => (m === "inline" ? "isolated" : "inline"));
          return;
        }
        break;
      }

      case "edit-permissions": {
        if (input === "s") { savePermissions(); return; }
        if (key.tab) {
          setPermField((f) => f === "mode" ? "allowed" : f === "allowed" ? "denied" : "mode");
          return;
        }
        if (permField === "mode" && (key.upArrow || key.downArrow)) {
          const modes: SdkPermissionMode[] = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
          const idx = modes.indexOf(permMode);
          if (key.upArrow) setPermMode(modes[Math.max(0, idx - 1)]!);
          if (key.downArrow) setPermMode(modes[Math.min(modes.length - 1, idx + 1)]!);
          return;
        }
        break;
      }

      case "edit-channels": {
        if (input === "s") {
          // Save channels
          if (!role) return;
          const channels = channelSelection.size > 0 ? Array.from(channelSelection) : [];
          request(`/roles/${role.id}`, { method: "PATCH", body: { allowedChannels: channels } })
            .then(() => { setMessage("Channels saved", "success"); setMode("view"); loadRole(); })
            .catch(() => setMessage("Save failed", "error"));
          return;
        }
        if (input === "u") {
          // Set unrestricted (null)
          if (!role) return;
          request(`/roles/${role.id}`, { method: "PATCH", body: { allowedChannels: null } })
            .then(() => { setMessage("Channels: unrestricted", "success"); setMode("view"); loadRole(); })
            .catch(() => setMessage("Save failed", "error"));
          return;
        }
        if (input === " ") {
          // Toggle channel at cursor
          const ch = availableChannels[channelCursor];
          if (ch) {
            setChannelSelection((prev) => {
              const next = new Set(prev);
              if (next.has(ch.name)) next.delete(ch.name); else next.add(ch.name);
              return next;
            });
          }
          return;
        }
        if (key.upArrow) { setChannelCursor((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setChannelCursor((i) => Math.min(availableChannels.length - 1, i + 1)); return; }
        break;
      }

      case "edit-env": {
        const envKeys = Object.keys(role?.envVars ?? {});
        if (input === "a") { setEnvNewKey(""); setMode("edit-env-add-key"); return; }
        if (input === "d" && envKeys.length > 0) {
          const k = envKeys[envIndex];
          const updated = { ...(role?.envVars ?? {}) };
          delete updated[k];
          request(`/roles/${role!.id}`, { method: "PATCH", body: { envVars: updated } })
            .then(() => { setMessage("Deleted", "success"); loadRole(); })
            .catch(() => setMessage("Delete failed", "error"));
          if (envIndex >= envKeys.length - 1 && envIndex > 0) setEnvIndex(i => i - 1);
          return;
        }
        if (key.return && envKeys.length > 0) {
          setEnvEditValue((role?.envVars ?? {})[envKeys[envIndex]] ?? "");
          setMode("edit-env-edit-value");
          return;
        }
        if (key.upArrow && envIndex > 0) setEnvIndex(i => i - 1);
        if (key.downArrow && envIndex < envKeys.length - 1) setEnvIndex(i => i + 1);
        break;
      }

      case "edit-env-add-key":
      case "edit-env-add-value":
      case "edit-env-edit-value":
        // TextInput handles input
        break;

      case "edit-plugins": {
        if (pluginBusy) return;
        if (input === "a") {
          // Fetch available plugins and enter add mode
          request<{ plugins: Array<{ id: string; name: string; version: string }> }>("/plugins")
            .then(({ plugins }) => {
              const boundIds = new Set(projectPlugins.map((p) => p.id));
              setAvailablePlugins(plugins.filter((p) => !boundIds.has(p.id)));
              setPluginAddCursor(0);
              setMode("edit-plugins-add");
            })
            .catch(() => setMessage("Failed to load plugins", "error"));
          return;
        }
        if (input === "x" && projectPlugins.length > 0) {
          const plugin = projectPlugins[pluginCursor];
          if (plugin) void uninstallFromRole(plugin.id);
          return;
        }
        if (key.upArrow) { setPluginCursor((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setPluginCursor((i) => Math.min(projectPlugins.length - 1, i + 1)); return; }
        break;
      }

      case "edit-plugins-add": {
        if (pluginBusy) return;
        if (key.escape) { setMode("edit-plugins"); setAvailablePlugins([]); return; }
        if (key.return && availablePlugins.length > 0) {
          const plugin = availablePlugins[pluginAddCursor];
          if (plugin) void installToRole(plugin.id);
          return;
        }
        if (key.upArrow) { setPluginAddCursor((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setPluginAddCursor((i) => Math.min(availablePlugins.length - 1, i + 1)); return; }
        break;
      }
    }
  });

  if (loading) return <Text dimColor>Loading role...</Text>;

  if (!role) return <Text dimColor>Role not found.</Text>;

  // ---- Plugin manager ----
  if (mode === "edit-plugins") {
    return (
      <Box flexDirection="column">
        <Text bold>Plugins (↑↓ navigate, x:unbind a:add Esc:cancel)</Text>
        {pluginBusy && <Text dimColor>Binding...</Text>}
        {projectPlugins.length === 0 ? (
          <Text dimColor>No plugins bound. Press a to add.</Text>
        ) : (
          projectPlugins.map((p, i) => (
            <Box key={p.id}>
              <Text color={i === pluginCursor ? "cyan" : undefined} bold={i === pluginCursor}>
                {i === pluginCursor ? "> " : "  "}{p.name}
              </Text>
              <Text dimColor> v{p.version}</Text>
            </Box>
          ))
        )}
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (mode === "edit-plugins-add") {
    return (
      <Box flexDirection="column">
        <Text bold>Add Plugin (↑↓ navigate, Enter:bind Esc:cancel)</Text>
        {pluginBusy && <Text dimColor>Binding...</Text>}
        {availablePlugins.length === 0 ? (
          <Text dimColor>No available plugins.</Text>
        ) : (
          availablePlugins.map((p, i) => (
            <Box key={p.id}>
              <Text color={i === pluginAddCursor ? "cyan" : undefined} bold={i === pluginAddCursor}>
                {i === pluginAddCursor ? "> " : "  "}{p.name}
              </Text>
              <Text dimColor> v{p.version}</Text>
            </Box>
          ))
        )}
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- CAG editor ----
  if (mode === "edit-cag") {
    return (
      <Box flexDirection="column">
        <Text bold>CAG Prompt — Edit (Esc cancel, Ctrl+S save)</Text>
        <TextInput
          value={cagValue}
          onChange={setCagValue}
          placeholder="Character And Guidance prompt..."
        />
        {message && (
          <Box marginTop={1}>
            <Text color={message.type === "error" ? "red" : "green"}>{message.text}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Directories add mode ----
  if (mode === "edit-dirs-add") {
    return (
      <Box flexDirection="column">
        <Text bold>Add Directory (Enter confirm, Esc cancel, Tab:complete)</Text>
        <TextInput
          value={newDirValue}
          onChange={(v) => { setNewDirValue(v); setDirSuggestions([]); }}
          placeholder="/absolute/path/to/directory"
        />
        {dirSuggestions.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {dirSuggestions.map((s, i) => (
              <Text key={s} color={i === dirActiveIdx ? "cyan" : undefined} dimColor={i !== dirActiveIdx}>
                {i === dirActiveIdx ? "> " : "  "}{s}/
              </Text>
            ))}
            <Text dimColor>↑↓ navigate, Enter select, Tab:confirm</Text>
          </Box>
        )}
        {message && (
          <Box marginTop={1}>
            <Text color={message.type === "error" ? "red" : "green"}>{message.text}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Directories manager ----
  if (mode === "edit-dirs") {
    return (
      <Box flexDirection="column">
        <Text bold>Additional Directories (↑↓ navigate, a:add m:mode x:remove s:save Esc:cancel)</Text>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
        {dirs.length === 0 ? (
          <Text dimColor>No directories. Press a to add one.</Text>
        ) : (
          dirs.map((dir, i) => {
            const d = typeof dir === "string" ? { path: dir, mode: "rw" as const } : dir;
            const isRW = d.mode !== "ro";
            return (
              <Box key={d.path}>
                <Text color={i === selectedDirIdx ? "cyan" : undefined} bold={i === selectedDirIdx}>
                  {i === selectedDirIdx ? "> " : "  "}
                </Text>
                <Text color={isRW ? "green" : "yellow"}>
                  [{isRW ? "RW" : "RO"}]{" "}
                </Text>
                <Text color={i === selectedDirIdx ? "cyan" : undefined}>{d.path}</Text>
              </Box>
            );
          })
        )}
      </Box>
    );
  }

  // ---- Tool permission toggler ----
  if (mode === "edit-tools") {
    return (
      <Box flexDirection="column">
        <Text bold>Tool Permissions — toggle with number key (s:save Esc:cancel)</Text>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
        {BUILT_IN_TOOLS.map((tool, i) => {
          const enabled = localTools.has(tool);
          return (
            <Box key={tool}>
              <Text dimColor>{i + 1}. </Text>
              <Text color={enabled ? "green" : "red"}>
                {enabled ? "[ON] " : "[OFF] "}
              </Text>
              <Text>{tool}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (mode === "edit-oscaps") {
    const editableCaps = osCapabilityRegistry.filter((meta) => meta.editable);
    return (
      <Box flexDirection="column">
        <Text bold>OS Capabilities — toggle with number key (a:automation targets s:save Esc:cancel)</Text>
        {sandboxInfo && (
          <Text dimColor>
            Platform: {sandboxInfo.platform} {sandboxInfo.available ? "(sandbox active)" : "(sandbox unavailable)"}
          </Text>
        )}
        {osCapabilityRegistry.map((meta) => {
          const editableIndex = editableCaps.findIndex((cap) => cap.id === meta.id);
          const enabled = localOsCapabilities.some((entry) => entry.id === meta.id);
          const prefix = editableIndex >= 0 ? `${editableIndex + 1}.` : " -";
          const detail = meta.id === "automation"
            ? (() => {
                const targets = localOsCapabilities.find((entry) => entry.id === meta.id)?.targets ?? [];
                return targets.length > 0 ? ` targets: ${targets.join(", ")}` : " targets: (none)";
              })()
            : "";
          return (
            <Box key={meta.id} flexDirection="column" marginBottom={1}>
              <Text color={enabled ? "green" : meta.editable ? "red" : "gray"}>
                {prefix} {enabled ? "[ON]" : "[OFF]"} {meta.label} [{meta.availability}]
              </Text>
              <Text dimColor>    {meta.description}{detail}</Text>
              {meta.effectiveDisabledReason && !meta.editable && (
                <Text dimColor>    {meta.effectiveDisabledReason}</Text>
              )}
            </Box>
          );
        })}
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (mode === "edit-oscaps-targets") {
    return (
      <Box flexDirection="column">
        <Text bold>Automation Targets (comma-separated bundle ids; Enter confirm, Esc cancel)</Text>
        <TextInput
          value={automationTargetsInput}
          onChange={setAutomationTargetsInput}
          placeholder="com.apple.mail, com.apple.systemevents"
        />
        <Text dimColor>Example: com.apple.mail, com.apple.systemevents</Text>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Execution config editor ----
  if (mode === "edit-exec") {
    return (
      <Box flexDirection="column">
        <Text bold>Execution Config (Tab:cycle mode, Enter on field, s:save Esc:cancel)</Text>
        <Box>
          <Text bold>  Mode: </Text>
          <Text color="cyan">{execMode}</Text>
          <Text dimColor> (Tab to toggle)</Text>
        </Box>
        <Box>
          <Text bold>  Model: </Text>
          <TextInput
            value={model}
            onChange={setModel}
            placeholder="sonnet, opus, haiku, or blank"
          />
        </Box>
        <Box>
          <Text bold>  Effort Tier: </Text>
          <TextInput
            value={effortTier}
            onChange={setEffortTier}
            placeholder="low, medium, high, or blank to inherit"
          />
        </Box>
        <Box>
          <Text bold>  Max Budget (USD): </Text>
          <TextInput
            value={maxBudget}
            onChange={setMaxBudget}
            placeholder="0 = unlimited"
          />
        </Box>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Permissions editor ----
  if (mode === "edit-permissions") {
    const modes: SdkPermissionMode[] = ["default", "acceptEdits", "dontAsk", "bypassPermissions"];
    return (
      <Box flexDirection="column">
        <Text bold>Permission Config (Tab:cycle field, ↑↓:mode, s:save, Esc:cancel)</Text>
        <Box>
          <Text bold color={permField === "mode" ? "cyan" : undefined}>  Mode: </Text>
          {modes.map((m) => (
            <Text key={m} color={m === permMode ? "green" : "gray"}>
              {m === permMode ? `[${m}]` : ` ${m} `}{" "}
            </Text>
          ))}
        </Box>
        <Box>
          <Text bold color={permField === "allowed" ? "cyan" : undefined}>  Allowed Bash: </Text>
          {permField === "allowed" ? (
            <TextInput value={allowedBash} onChange={setAllowedBash} placeholder="git add *, pnpm test*" />
          ) : (
            <Text>{allowedBash || "(none)"}</Text>
          )}
        </Box>
        <Box>
          <Text bold color={permField === "denied" ? "cyan" : undefined}>  Denied Bash: </Text>
          {permField === "denied" ? (
            <TextInput value={deniedBash} onChange={setDeniedBash} placeholder="rm -rf *, ssh *" />
          ) : (
            <Text>{deniedBash || "(none)"}</Text>
          )}
        </Box>
        <Text dimColor>Patterns: comma-separated, glob syntax (* = wildcard)</Text>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Channels editor ----
  if (mode === "edit-channels") {
    return (
      <Box flexDirection="column">
        <Text bold>Allowed Channels (Space:toggle, u:unrestricted, s:save, Esc:cancel)</Text>
        {availableChannels.length === 0 ? (
          <Text dimColor>No channels available</Text>
        ) : (
          availableChannels.map((ch, i) => (
            <Box key={ch.id}>
              <Text>{i === channelCursor ? ">" : " "} </Text>
              <Text color={channelSelection.has(ch.name) ? "green" : "gray"}>
                [{channelSelection.has(ch.name) ? "x" : " "}] {ch.name}
              </Text>
            </Box>
          ))
        )}
        <Text dimColor>Selected: {channelSelection.size > 0 ? Array.from(channelSelection).join(", ") : "none (= block all)"}</Text>
        {message && (
          <Box>
            <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
              {message.text}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // ---- Env vars editor ----
  if (mode.startsWith("edit-env")) {
    const envKeys = Object.keys(role.envVars ?? {});
    return (
      <Box flexDirection="column">
        <Text bold>Environment Variables ({envKeys.length})</Text>
        {envKeys.length === 0 && mode === "edit-env" && <Text dimColor>  No env vars. Press a to add.</Text>}
        {envKeys.map((k, i) => {
          const selected = i === envIndex;
          if (mode === "edit-env-edit-value" && selected) {
            return (
              <Box key={k}>
                <Text color="cyan">&gt; {k} = </Text>
                <TextInput value={envEditValue} onChange={setEnvEditValue} onSubmit={() => {
                  const updated = { ...(role.envVars ?? {}), [k]: envEditValue };
                  request(`/roles/${role.id}`, { method: "PATCH", body: { envVars: updated } })
                    .then(() => { setMessage("Saved", "success"); loadRole(); setMode("edit-env"); })
                    .catch(() => setMessage("Save failed", "error"));
                }} />
              </Box>
            );
          }
          return (
            <Text key={k} color={selected && mode === "edit-env" ? "cyan" : "white"}>
              {selected && mode === "edit-env" ? "> " : "  "}{k} = {(role.envVars ?? {})[k]}
            </Text>
          );
        })}
        {mode === "edit-env-add-key" && (
          <Box>
            <Text color="green">  New key: </Text>
            <TextInput value={envNewKey} onChange={setEnvNewKey} onSubmit={() => {
              if (envNewKey.trim()) { setEnvNewValue(""); setMode("edit-env-add-value"); }
            }} />
          </Box>
        )}
        {mode === "edit-env-add-value" && (
          <Box>
            <Text color="green">  {envNewKey} = </Text>
            <TextInput value={envNewValue} onChange={setEnvNewValue} onSubmit={() => {
              const updated = { ...(role.envVars ?? {}), [envNewKey.trim()]: envNewValue };
              request(`/roles/${role.id}`, { method: "PATCH", body: { envVars: updated } })
                .then(() => { setMessage("Added", "success"); loadRole(); setMode("edit-env"); })
                .catch(() => setMessage("Add failed", "error"));
            }} />
          </Box>
        )}
        <Text dimColor>a:add  Enter:edit  d:delete  Esc:back</Text>
        {message && <Text color={message.type === "error" ? "red" : "green"}>{message.text}</Text>}
      </Box>
    );
  }

  // ---- Read-only view ----
  return (
    <Box flexDirection="column">
      <Text bold>Role: {role.name}</Text>
      <Box>
        <Text dimColor>ID: </Text>
        <Text>{role.id}</Text>
      </Box>
      <Box>
        <Text dimColor>Status: </Text>
        <Text color={role.status === "active" ? "green" : role.status === "probation" ? "yellow" : "red"}>
          {role.status}
        </Text>
      </Box>
      {role.performanceScore != null && (
        <Box>
          <Text dimColor>Score: </Text>
          <Text>{(role.performanceScore * 100).toFixed(0)}%</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>Created: </Text>
        <Text>{new Date(role.createdAt).toLocaleString()}</Text>
      </Box>
      <Box>
        <Text dimColor>Execution: </Text>
        <Text>{role.executionMode ?? "inline"} / tier:{role.effortTier ?? "—"} / model:{role.model ?? "inherit"} / {role.maxBudgetUsd != null ? `$${role.maxBudgetUsd}` : "no limit"}</Text>
      </Box>
      <Box>
        <Text dimColor>OS Capabilities: </Text>
        <Text>
          {(role.osCapabilities?.length ?? 0) > 0
            ? role.osCapabilities!.map((entry) => entry.id === "automation" && entry.targets?.length
              ? `automation(${entry.targets.join(",")})`
              : entry.id).join(", ")
            : "None"}
        </Text>
      </Box>
      {sandboxInfo && (
        <Box>
          <Text dimColor>Sandbox Platform: </Text>
          <Text>{sandboxInfo.platform} {sandboxInfo.available ? "(active)" : "(unavailable)"}</Text>
        </Box>
      )}
      {dirs.length > 0 && (
        <>
          <Text bold>Additional Directories:</Text>
          {dirs.map((dir) => (
            <Text key={dir.path} dimColor>  {dir.path}</Text>
          ))}
        </>
      )}
      <Box>
        <Text dimColor>Permission: </Text>
        <Text>{role.permissionMode ?? "default"}</Text>
      </Box>
      {(role.allowedBashPatterns?.length ?? 0) > 0 && (
        <Box>
          <Text dimColor>  Bash Allow: </Text>
          <Text>{role.allowedBashPatterns!.join(", ")}</Text>
        </Box>
      )}
      {(role.deniedBashPatterns?.length ?? 0) > 0 && (
        <Box>
          <Text dimColor>  Bash Deny: </Text>
          <Text>{role.deniedBashPatterns!.join(", ")}</Text>
        </Box>
      )}
      {deniedReadPaths.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Denied Read Paths (global):</Text>
          {deniedReadPaths.map((p) => (
            <Text key={p} dimColor>  {p}</Text>
          ))}
          <Text dimColor italic>  (Settings {'>'} Advanced)</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>Channels: </Text>
        <Text>{role.allowedChannels === undefined ? "Unrestricted" : role.allowedChannels.length === 0 ? "Blocked" : role.allowedChannels.join(", ")}</Text>
      </Box>
      <Box>
        <Text dimColor>Inherit User Settings: </Text>
        <Text color={role.inheritUserSettings ? "green" : "gray"}>{role.inheritUserSettings ? "Yes" : "No"}</Text>
      </Box>
      {role.learnedRules.stylePreferences.length > 0 && (
        <>
          <Text bold>Style Preferences:</Text>
          {role.learnedRules.stylePreferences.map((r) => (
            <Text key={r} dimColor>  - {r}</Text>
          ))}
        </>
      )}
      {role.learnedRules.avoidedActions.length > 0 && (
        <>
          <Text bold>Avoided Actions:</Text>
          {role.learnedRules.avoidedActions.map((r) => (
            <Text key={r} dimColor>  - {r}</Text>
          ))}
        </>
      )}
      {role.learnedRules.pinnedParameters.length > 0 && (
        <>
          <Text bold>Pinned Parameters:</Text>
          {role.learnedRules.pinnedParameters.map((p) => {
            const paramSummary = Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
            const cond = p.condition ? ` [when: ${p.condition}]` : "";
            return (
              <Text key={`${p.tool}-${p.pinnedAt}`} dimColor>  - {p.tool} → {paramSummary}{cond}</Text>
            );
          })}
        </>
      )}
      <Box>
        <Text dimColor>Plugins: </Text>
        {projectPlugins.length === 0
          ? <Text dimColor>None</Text>
          : projectPlugins.map((p) => <Text key={p.id}>{p.name} </Text>)}
      </Box>
      {message && (
        <Box>
          <Text color={message.type === "error" ? "red" : message.type === "success" ? "green" : "gray"}>
            {message.text}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>c:CAG d:dirs t:tools b:plugins o:oscaps x:exec p:perms h:channels v:env i:inherit{' '}
          {role?.presetId ? "R:restore-preset " : ""}r:refresh Esc:back</Text>
      </Box>
    </Box>
  );
}
