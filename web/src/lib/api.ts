export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const AUTH_STORAGE_KEY = "adam_api_key";

export function getStoredApiKey(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(AUTH_STORAGE_KEY) : null;
}

export function setStoredApiKey(key: string): void {
  localStorage.setItem(AUTH_STORAGE_KEY, key);
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

/** Redirect the window to the login page, preserving the current URL as returnTo. */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/ui/login") return;
  const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/ui/login?returnTo=${returnTo}`;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const apiKey = getStoredApiKey();
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
  if (options?.body) {
    headers["Content-Type"] ??= "application/json";
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let code = "UNKNOWN_ERROR";
    let message = response.statusText;
    try {
      const body = await response.json();
      code = body.code ?? code;
      message = body.message ?? message;
    } catch {
      // response body not JSON
    }
    if (response.status === 401) {
      clearStoredApiKey();
      redirectToLogin();
    }
    throw new ApiError(response.status, code, message);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function fetchDeliveryLog(taskId: string, limit = 50): Promise<import("./types.js").DeliveryLogEntry[]> {
  const data = await api<{ logs: import("./types.js").DeliveryLogEntry[] }>(
    `/tasks/${taskId}/delivery-log?limit=${limit}`,
  );
  return data.logs;
}

/** Verify a candidate API key against the server. Returns true if the key is valid. */
export async function verifyApiKey(key: string): Promise<boolean> {
  const response = await fetch("/auth/verify", {
    headers: { "x-api-key": key },
  });
  return response.ok;
}

/** Rotate the server's API key. Returns the new key on success. */
export async function rotateApiKey(): Promise<string> {
  const result = await api<{ apiKey: string }>("/auth/rotate", { method: "POST" });
  return result.apiKey;
}

// ---------------------------------------------------------------------------
// Presets API
// ---------------------------------------------------------------------------

export interface PresetRole {
  presetId: string;
  name: string;
  cagPrompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: string;
  model?: string;
}

export interface PresetTemplate {
  presetId: string;
  name: string;
  description?: string;
  trigger: unknown;
  steps: unknown[];
  config?: Record<string, unknown>;
  boundRolePresetId?: string;
}

export interface PresetsResponse {
  roles: PresetRole[];
  templates: PresetTemplate[];
  installed: Record<string, boolean>;
}

/** List all presets with install status. */
export async function getPresets(): Promise<PresetsResponse> {
  return api<PresetsResponse>("/presets");
}

/** Restore a preset to its canonical definition. */
export async function restorePreset(
  type: "role" | "template",
  presetId: string,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/presets/${type}/${presetId}/restore`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Feature Requests API
// ---------------------------------------------------------------------------

export type FeatureRequestStatus = "new" | "reviewed" | "dismissed" | "converted";

export interface FeatureRequest {
  id: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  extractedAt: number;
  extractedByRoleId?: string;
  content: string;
  summary?: string;
  status: FeatureRequestStatus;
  tags?: string[];
  evidenceQuote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FeatureRequestsResponse {
  featureRequests: FeatureRequest[];
}

/** List feature requests with optional status filter. */
export async function listFeatureRequests(opts?: {
  status?: FeatureRequestStatus;
  limit?: number;
  offset?: number;
}): Promise<FeatureRequestsResponse> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return api<FeatureRequestsResponse>(`/feature-requests${qs ? `?${qs}` : ""}`);
}

/** Update a feature request's status. */
export async function updateFeatureRequest(
  id: string,
  status: FeatureRequestStatus,
): Promise<{ ok: boolean; id: string; status: FeatureRequestStatus }> {
  return api<{ ok: boolean; id: string; status: FeatureRequestStatus }>(
    `/feature-requests/${id}`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}

// ---------------------------------------------------------------------------
// Mistake Patterns API
// ---------------------------------------------------------------------------

export type MistakePatternStatus = "new" | "acknowledged" | "dismissed";

export type MistakeDimensionType = "event_type" | "score_degradation" | "tool_call_pattern";

export interface MistakePattern {
  id: string;
  dimensionType: MistakeDimensionType;
  dimensionValue: string;
  count: number;
  roleIds: string[];
  sampleEvidenceIds: Array<{ source: "evolution_audit" | "role_scores" | "delivery_log"; id: string }>;
  status: MistakePatternStatus;
  firstSeen: number;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
}

/** List mistake patterns with optional status filter. */
export async function listMistakePatterns(status?: MistakePatternStatus): Promise<MistakePattern[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const qs = params.toString();
  const data = await api<{ mistakePatterns: MistakePattern[] }>(
    `/mistake-patterns${qs ? `?${qs}` : ""}`,
  );
  return data.mistakePatterns;
}

/** Update a mistake pattern's status (DP-4.11: body-based PATCH). */
export async function updateMistakePattern(
  id: string,
  status: MistakePatternStatus,
): Promise<void> {
  await api(`/mistake-patterns/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

// ---------------------------------------------------------------------------
// Task Template config patch (for Feature Miner pre-fetch limits)
// ---------------------------------------------------------------------------

/** Patch a task template's config fields (e.g. max_sessions, max_messages_per_session). */
export async function updateTaskTemplateConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<unknown> {
  return api(`/task-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ config }),
  });
}

// ---------------------------------------------------------------------------
// Template Version History (Phase 0.5)
// ---------------------------------------------------------------------------

export type TemplateVersionReason = "update" | "delete" | "restore";

export interface TemplateVersionSummary {
  versionNo: number;
  reason: TemplateVersionReason;
  author: string | null;
  traceId: string | null;
  createdAt: number;
  snapshotName: string;
}

export interface TemplateVersionListResponse {
  templateId: string;
  templateName: string;
  count: number;
  versions: TemplateVersionSummary[];
}

export interface TemplateVersionDetailResponse {
  templateId: string;
  versionNo: number;
  reason: TemplateVersionReason;
  author: string | null;
  traceId: string | null;
  createdAt: number;
  snapshot: import("./types.js").TaskTemplate;
}

export interface TemplateVersionDiffChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface TemplateVersionDiffResponse {
  templateId: string;
  a: number;
  b: number;
  changeCount: number;
  changes: TemplateVersionDiffChange[];
}

export interface TemplateVersionRestoreResponse {
  success: boolean;
  templateId: string;
  restoredFromVersion: number;
  preRestoreVersionNo: number | null;
  currentName: string | undefined;
}

/** List all saved versions for a template, newest first. */
export async function listTemplateVersions(templateId: string): Promise<TemplateVersionListResponse> {
  return api<TemplateVersionListResponse>(`/task-templates/${templateId}/versions`);
}

/** Get a single version with the full TaskTemplate snapshot. */
export async function getTemplateVersion(
  templateId: string,
  versionNo: number,
): Promise<TemplateVersionDetailResponse> {
  return api<TemplateVersionDetailResponse>(
    `/task-templates/${templateId}/versions/${versionNo}`,
  );
}

/** Field-level diff between two version numbers. */
export async function diffTemplateVersions(
  templateId: string,
  a: number,
  b: number,
): Promise<TemplateVersionDiffResponse> {
  return api<TemplateVersionDiffResponse>(
    `/task-templates/${templateId}/versions/diff?a=${a}&b=${b}`,
  );
}

/** Non-destructively restore a template to a previous version. */
export async function restoreTemplateVersion(
  templateId: string,
  versionNo: number,
): Promise<TemplateVersionRestoreResponse> {
  return api<TemplateVersionRestoreResponse>(
    `/task-templates/${templateId}/versions/${versionNo}/restore`,
    { method: "POST" },
  );
}

// ---------------------------------------------------------------------------
// Extensions API
// ---------------------------------------------------------------------------

export interface McpbUserConfigField {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  sensitive?: boolean;
  multiple?: boolean;
}

export interface McpbTool {
  name: string;
  description?: string;
}

export interface McpbManifest {
  manifest_version: string;
  name: string;
  version: string;
  description: string;
  display_name?: string;
  author: { name: string; email?: string; url?: string };
  server: {
    type: "node" | "python" | "binary";
    entry_point?: string;
    mcp_config: { command: string; args?: string[]; env?: Record<string, string> };
  };
  user_config?: Record<string, McpbUserConfigField>;
  tools?: McpbTool[];
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ExtensionHealth {
  extensionId: string;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  lastRoleId: string | null;
  lastTaskId: string | null;
}

export interface Extension {
  id: string;
  name: string;
  version: string;
  manifestJson: string;
  installSource: string;
  packageHash: string;
  defaultConfigJson: string | null;
  createdAt: number;
  updatedAt: number;
  health?: ExtensionHealth | null;
}

export interface LegacyMcpServersRow {
  roleId: string;
  roleName: string;
  mcpServers: Record<string, unknown>;
}

export interface LegacySnapshot {
  count: number;
  rows: LegacyMcpServersRow[];
}

/** List all installed extensions. */
export async function listExtensions(): Promise<Extension[]> {
  const data = await api<{ extensions: Extension[] }>("/extensions");
  return data.extensions;
}

/** Get a single extension by name. */
export async function getExtension(name: string): Promise<Extension> {
  const data = await api<{ extension: Extension }>(`/extensions/${name}`);
  return data.extension;
}

/** Upload a .mcpb file. Returns the created/upgraded extension entity. */
export async function uploadExtension(file: File): Promise<Extension> {
  const formData = new FormData();
  formData.append("file", file);
  const apiKey = getStoredApiKey();
  const response = await fetch("/extensions", {
    method: "POST",
    headers: apiKey ? { "x-api-key": apiKey } : {},
    body: formData,
  });
  if (!response.ok) {
    let code = "UNKNOWN_ERROR";
    let message = response.statusText;
    try {
      const body = await response.json() as { code?: string; message?: string };
      code = body.code ?? code;
      message = body.message ?? message;
    } catch { /* ignore */ }
    throw new ApiError(response.status, code, message);
  }
  const data = await response.json() as { extension: Extension };
  return data.extension;
}

/** Update the default config JSON for an extension. */
export async function patchExtensionDefaultConfig(
  name: string,
  defaultConfigJson: Record<string, unknown>,
): Promise<Extension> {
  const data = await api<{ extension: Extension }>(`/extensions/${name}`, {
    method: "PATCH",
    body: JSON.stringify({ defaultConfigJson }),
  });
  return data.extension;
}

/** Delete an extension by name. */
export async function deleteExtension(name: string): Promise<void> {
  await api(`/extensions/${name}`, { method: "DELETE" });
}

/** List roles with non-empty mcp_servers (legacy). */
export async function listLegacyMcpServers(): Promise<LegacySnapshot> {
  return api<LegacySnapshot>("/extensions/legacy");
}

/** Clear legacy mcp_servers for a specific role. */
export async function clearLegacyMcpServers(roleId: string): Promise<void> {
  await api(`/extensions/legacy/clear/${roleId}`, { method: "POST" });
}

// ── Role-extension bindings (Phase 2) ────────────────────────────────────────

export interface RoleExtensionBinding {
  id: string;
  extensionId: string;
  extensionName: string;
  version: string;
  toolsCount: number;
  enabled: boolean;
  configOverride: Record<string, unknown> | null;
  effectiveConfig: Record<string, unknown>;
  generatedServerName: string;
  health?: ExtensionHealth | null;
}

/** List extensions bound to a role. */
export async function listRoleExtensions(roleId: string): Promise<RoleExtensionBinding[]> {
  const data = await api<{ bindings: RoleExtensionBinding[] }>(`/roles/${roleId}/extensions`);
  return data.bindings;
}

/** Bind an extension to a role. */
export async function bindRoleExtension(
  roleId: string,
  extensionName: string,
  configOverride?: Record<string, unknown>,
): Promise<RoleExtensionBinding> {
  return api<RoleExtensionBinding>(`/roles/${roleId}/extensions`, {
    method: "POST",
    body: JSON.stringify({ extension_name: extensionName, config_override: configOverride }),
  });
}

/** Remove an extension binding from a role. */
export async function unbindRoleExtension(roleId: string, bindingId: string): Promise<void> {
  await api(`/roles/${roleId}/extensions/${bindingId}`, { method: "DELETE" });
}

/** Update a role extension binding (config override, enabled toggle). */
export async function patchRoleExtension(
  roleId: string,
  bindingId: string,
  updates: { configOverride?: Record<string, unknown> | null; enabled?: boolean },
): Promise<RoleExtensionBinding> {
  return api<RoleExtensionBinding>(`/roles/${roleId}/extensions/${bindingId}`, {
    method: "PATCH",
    body: JSON.stringify({ config_override: updates.configOverride, enabled: updates.enabled }),
  });
}

/** Record user feedback (good/bad) for a TemplateExecution, optionally scoped to a specific step. */
export async function postExecutionFeedback(
  executionId: string,
  rating: "good" | "bad",
  stepId?: string,
): Promise<void> {
  await api<{ ok: boolean }>(`/executions/${executionId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ rating, ...(stepId ? { stepId } : {}) }),
  });
}

// ─── Cost API ─────────────────────────────────────────────────────────────────

export interface CostSummaryParams {
  from: number;
  to: number;
  groupBy: "model" | "role" | "source" | "date";
  granularity: "day" | "week" | "month";
  /** Minutes east of UTC for local-day bucketing (e.g. UTC+8 → 480). */
  tzOffsetMinutes?: number;
  /** When set, the response includes a per-bucket cost series split by this dimension. */
  trendStackBy?: "source" | "model";
}

export interface CostDetailParams {
  groupBy: "model" | "role" | "source" | "date";
  groupKey: string;
  from: number;
  to: number;
  tzOffsetMinutes?: number;
}

export interface CostSummaryGroup {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  callCount: number;
}

export interface CostTrendBucket {
  bucket: string;
  costUsd: number;
  callCount: number;
}

export interface CostSummaryResponse {
  totalCostUsd: number;
  callCount: number;
  topModel?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  unpricedCallCount: number;
  unpricedTokens: number;
  groups: CostSummaryGroup[];
  trend: CostTrendBucket[];
  /** Present only when trendStackBy was requested: per-bucket cost pivoted by stack key. */
  trendStacked?: Array<{ bucket: string } & Record<string, number>>;
  /** The distinct stack keys (source or model values) present in trendStacked. */
  trendStackKeys?: string[];
  /** The configured absolute daily spend limit in USD. 0 = disabled. */
  thresholdUsd?: number;
}

export interface CostDetailCall {
  callId: string;
  source: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  priced: number;
  createdAt: number;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
}

/** Get aggregated cost summary for a time window. */
export async function getCostSummary(params: CostSummaryParams): Promise<CostSummaryResponse> {
  const qs = new URLSearchParams({
    from: String(params.from),
    to: String(params.to),
    groupBy: params.groupBy,
    granularity: params.granularity,
  });
  if (params.tzOffsetMinutes !== undefined) qs.set("tzOffsetMinutes", String(params.tzOffsetMinutes));
  if (params.trendStackBy !== undefined) qs.set("trendStackBy", params.trendStackBy);
  return api<CostSummaryResponse>(`/cost/summary?${qs}`);
}

/** Get per-call detail for a cost group (inline drill-down). */
export async function getCostDetail(params: CostDetailParams): Promise<CostDetailCall[]> {
  const qs = new URLSearchParams({
    groupBy: params.groupBy,
    groupKey: params.groupKey,
    from: String(params.from),
    to: String(params.to),
  });
  if (params.tzOffsetMinutes !== undefined) qs.set("tzOffsetMinutes", String(params.tzOffsetMinutes));
  return api<CostDetailCall[]>(`/cost/detail?${qs}`);
}

