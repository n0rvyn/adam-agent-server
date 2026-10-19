import type { RoleOsCapability } from "./os-capabilities.js";
import type { ContractRule } from "../store/contract-rules.js";
import type { ModelPrice, CostRecompute } from "../lib/cost-pricing.js";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type StepLogType =
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_response"
  | "permission_denied"
  | "error"
  | "plugin_error"
  | "validator_error"
  | "mcp_load_error";

export type EffortLevel = "low" | "medium" | "high" | "max";

/** SDK PermissionMode — must match all variants from sdk.d.ts */
export type SdkPermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan" | "auto";

export type PathAccessMode = "ro" | "rw";

export interface TaskRequirementPath {
  path: string;
  access: PathAccessMode;
}

export interface TaskRequirements {
  tools?: string[];
  paths?: TaskRequirementPath[];
  osCapabilities?: RoleOsCapability[];
  network?: boolean;
  plugins?: string[];
}

export type AdmissionFailureCode =
  | "ROLE_NOT_FOUND"
  | "ROLE_TOOL_MISMATCH"
  | "ROLE_PATH_SCOPE_MISMATCH"
  | "ROLE_OS_CAPABILITY_MISMATCH"
  | "ROLE_PLUGIN_MISMATCH"
  | "ROLE_NETWORK_MISMATCH"
  | "ROLE_SELECTION_AMBIGUOUS"
  | "REQUIREMENTS_MISSING";

export interface AdmissionWarning {
  code: "APPROVAL_WILL_TRIGGER";
  tools: string[];
  expectedPromptCount: number;
}

export interface PrimaryArtifactRef {
  stepId: string;
  /** Optional — if absent, server derives key from step.outputAs at delivery time (DP-003 Option B). */
  key?: string;
}
/**
 * Reference to a value produced by a pipeline step's artifact.
 * Resolution: locate the artifact (step + key, key defaults to step.outputAs), then
 * - `field` set + json artifact  → value[field]
 * - file artifact, no field      → for body: full text; for title: first H1 heading
 * - json artifact, no field      → string value / stringified
 */
export interface DeliveryPayloadRef {
  step: string;
  key?: string;
  field?: string;
}

export type DeliveryAttachmentType = "auto" | "audio" | "video" | "image" | "markdown" | "file";

/** One declared attachment in the delivery payload (ordered). */
export interface DeliveryPayloadAttachment {
  step: string;
  key?: string;
  /**
   * When set, the attachment is MATERIALIZED from this field of the step's JSON artifact
   * (e.g. a step that emits `{title, body}` → `field: "body"` ships the body markdown as a
   * `.md` file). Without it, the attachment comes from the step's file artifact(s) directly.
   */
  field?: string;
  /** Display type; "auto" (default) infers from the artifact's mime. */
  type?: DeliveryAttachmentType;
  /** Filename template; supports {date} and {title}. Original extension preserved. Default: artifact's own filename. */
  name?: string;
}

/**
 * Declarative delivery payload: the template states WHAT to send (body / title / ordered
 * attachments with types+names). A composer resolves this against the execution's artifacts;
 * the sender just ships the resolved payload. Podcast-specific knowledge lives here in config,
 * never in the send path. Absent → legacy behavior (mode-based body + all file attachments).
 */
export interface DeliveryPayloadManifest {
  body?: DeliveryPayloadRef | { text: string };
  title?: DeliveryPayloadRef;
  attachments: DeliveryPayloadAttachment[];
}

export interface DeliveryConfig {
  mode: "concat-step-results" | "primary-artifact" | "custom";
  primaryArtifact?: PrimaryArtifactRef;
  /** Reserved for future use; runtime throws NotImplemented when mode = "custom". */
  customRenderer?: string;
  /** Declarative payload manifest. When present, overrides mode-based body + all-files attachments. */
  payload?: DeliveryPayloadManifest;
}

export interface TaskConfig {
  // SDK-native options
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, unknown>;
  model?: string;
  effort?: EffortLevel;
  effortTier?: EffortTier;
  settingSources?: string[];
  // Plugin paths to load via SDK. Each string is mapped to
  // { type: 'local', path: str } before passing to SDK query(),
  // matching the SDK's SdkPluginConfig[] type.
  plugins?: string[];

  // Server-level options
  workspacePath?: string;
  timeout: number;
  approvalRequired: string[];
  approvalTimeout: number;
  env?: Record<string, string>;
  /** Path to the Claude Code executable. Auto-detected via PATH if not set. */
  claudeCodePath?: string;
  /** TemplateExecution: continue executing remaining steps when one fails (D-006). */
  continueOnError?: boolean;
  /** Delivery semantics for TemplateExecution result delivery. Default: "concat-step-results". */
  delivery?: DeliveryConfig;
  // RBAC: computed effective permissions for this task's agent (D-008)
  effectivePermissions?: EffectivePermissions;
  /** Capability contract produced by the dispatch-side LLM. */
  requirements?: TaskRequirements;
  /** Frozen Role snapshot at dispatch time. */
  executionProfile?: Role;
  /** Task type for per-task-type performance tracking (skill name or "generic"). */
  taskType?: string;
  /** Phase 2: count of contract sub-fields actually checked for this task (lengthTarget/format/persona/mustReferenceArtifacts). 0 → contract_compliance excluded from EMA. */
  outputContractCheckCount?: number;
  /** Tool allowlist/denylist overrides for this task. */
  toolOverrides?: {
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  /**
   * Phase 3: Frozen snapshot of the resolved extension MCP map at task dispatch time.
   * Written before SDK query() opens so in-flight binding edits don't affect running tasks.
   * Keyed by generatedServerName; values are McpStdioServerConfig shapes.
   */
  extensionsSnapshot?: Record<string, unknown>;
  /**
   * Step functional category — propagated from TaskStep.kind via template-executor.
   * Used as belief scope label: `{roleId}::{stepKind}`. Falls back to 'default'.
   */
  stepKind?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface PricingConfig {
  models: Record<string, ModelPrice>;
}

export interface CostConfig {
  /** Absolute daily spend limit in USD. 0 (or absent) = disabled. */
  dailyThresholdUsd: number;
}

export interface Task {
  id: string;
  parentId?: string;
  status: TaskStatus;
  prompt: string;
  originalPrompt?: string;
  config: TaskConfig;
  result?: string;
  error?: string;
  /** Classified error category (AUTH, NETWORK, etc.) set by ExecutionManager at failure time. */
  errorCategory?: string;
  /** Number of automatic retries performed by ChatManager for this task. */
  retryCount?: number;
  blockReason?: {
    reason: string;
    missingPrereqs?: string[];
    resumeHint?: string;
  };
  sdkSessionId?: string;
  templateId?: string;
  roleId?: string;  // DP-003: Role assigned at dispatch time
  stepId?: string;  // TemplateExecution artifact tools: TaskStep.id when this task is a template execution step
  sourceSessionId?: string;  // Chat session that triggered this task (for result delivery)
  deliverTo?: NotifyTarget[];   // D-005: output delivery targets (result full text)
  reportTo?: NotifyTarget[];    // D-005: status report targets (completion summary)
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
  costBreakdown?: CostRecompute;
  tokenUsage?: TokenUsage;
  numTurns?: number;
  totalDurationMs?: number;
  /** Trace ID linking this row to the originating chat message and all related step_logs/delivery_log/evolution_audit rows. UUID v4. Null for legacy rows or out-of-context creation. */
  traceId?: string;
  /**
   * In-memory attribution context. Originally just `usedMemoryIds` (Phase 2 retrieval attribution),
   * but also carries `startSnapshot` (workspace snapshot tuple array) written by ExecutionManager
   * between task start and task end, plus any future sibling keys. All consumers MUST use
   * `updateContextMeta` (store/tasks.ts) for writes so sibling keys are preserved.
   */
  contextMeta?: { usedMemoryIds?: string[]; startSnapshot?: unknown; [otherKey: string]: unknown };
}

export interface StepLog {
  id: string;
  taskId: string;
  index: number;
  type: StepLogType;
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  truncated?: boolean;
  timestamp: number;
  tokenUsage?: TokenUsage;
  planStepIndex?: number;
  traceId?: string;
}

export interface ServerSection {
  port: number;
  host: string;
  apiKey?: string;
  timezone?: string;  // IANA timezone string or "system" for OS default
}

export interface WatchdogRuleConfig {
  enabled: boolean;
  action: "restart" | "notify" | "ignore";
}

export interface WatchdogConfig {
  enabled: boolean;
  intervalMinutes: number;
  rules: {
    managerHealthCheck: WatchdogRuleConfig & { staleDurationMinutes: number };
    staleTasks: WatchdogRuleConfig & { maxPendingMinutes: number };
    staleRunningTasks: WatchdogRuleConfig & { maxRunningMinutes: number };
    /** #215: reconcile template_executions stuck in 'running' with no active child tasks. */
    staleTemplateExecutions?: WatchdogRuleConfig & { maxOrphanMinutes: number };
    dbMaintenance: WatchdogRuleConfig & { walCheckpointThresholdMB: number };
    artifactCleanup: WatchdogRuleConfig & { ttlDays: number; orphanGcMinAgeHours: number };
    sandboxViolation: { enabled: boolean; action: "alert" | "alert_and_cancel" };
    reflectionJob?: { enabled: boolean; intervalMinutes: number };
    memoryGc?: {
      enabled: boolean;
      intervalHours: number;
      observationTtlDays: number;
    };
  };
}

export interface DefaultsConfig {
  timeout: number;
  maxTurns: number;
  maxBudgetUsd: number;
  effort: EffortLevel;
  model: string;
  settingSources: string[];
  allowedTools: string[];
  disallowedTools: string[];
  /** Workspace path for SDK file operations. Defaults to process.cwd(). */
  workspacePath?: string;
  /** Per-task workspace cleanup policy. "immediate" | "on_restart" | number (hours). */
  workspaceRetention?: "immediate" | "on_restart" | number;
  approvalRequired: string[];
  approvalTimeout: number;
  env: Record<string, string>;
  /** Plugin paths from adam.config.yaml. Used for startup sync to DB. */
  plugins?: string[];
  /** Path to the Claude Code executable. Auto-detected via PATH if not set. */
  claudeCodePath?: string;
  /** @deprecated User-configurable sensitive path list. Use deniedReadPaths instead. */
  sensitivePaths?: string[];
  /** Global read blacklist — paths denied at both SDK and OS layers. Defaults to DEFAULT_DENIED_READ_PATHS. */
  deniedReadPaths?: string[];
}

export interface RolesConfig {
  presets: RolePresetConfig[];
  evolution: {
    triggerEvery: number;
    reflectionThreshold: number;
    retirementThreshold?: number;
    probationTasks?: number;
  };
}

export type LogComponent =
  | "adam"
  | "manager"
  | "scheduler"
  | "api"
  | "ws"
  | "cli"
  | "store"
  | "embedding"
  | "admin"
  | "agent"
  | "channels"
  | "plugin-sync"
  | "watchdog"
  | "chat-manager"
  | "execution"
  | "execution-pool"
  | "message-handler"
  | "goal-manager"
  | "sandbox-macos"
  | "sandbox-linux"
  | "sandbox"
  | "audit"
  | "config"
  | "event-dispatcher"
  | "context-compact"
  | "workspace-watcher"
  | "memory-service";

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  components?: LogComponent[];
}

export interface ChatConfig {
  sessionTimeoutMinutes: number;
  maxSessionTurns: number;
  autoTitle: boolean;
  archiveExtractMemory: boolean;
  /**
   * Token budget for prompt context emitted by buildSessionContext.
   * Truncation engages when message bodies estimate over this budget.
   * Default: 20000 (matches design doc D-021).
   *
   * Note: this is the sole gate for buildSessionContext truncation.
   * `maxSessionTurns` no longer caps the context-builder read window —
   * thread grouping requires reading the entire session, then truncation
   * decides what to drop based on token budget alone. `maxSessionTurns`
   * still governs other read paths (`getRecentMessages`, archival).
   */
  contextBudgetTokens: number;
  promptExpiry?: {
    intervalMs?: number;
  };
  /** Threshold (chars) above which result text becomes a report.md artifact instead of being inlined. Default 4000. */
  artifactThresholdChars?: number;
  /**
   * Maximum number of chat sessions that may each hold a live Claude Code subprocess simultaneously.
   * When the cap is reached, the least-recently-used live session is evicted (its process closed;
   * next message resumes from sdk_session_id). Default 3.
   */
  maxConcurrentLiveSessions?: number;
  /**
   * Minutes of inactivity after which a live session's subprocess is closed and evicted.
   * Resets on any activity (message received, turn started). Default equals sessionTimeoutMinutes (30).
   */
  liveSessionIdleMinutes?: number;
  /** Commitment detector configuration. */
  commitmentDetection?: {
    /** Active locale sets for future-delivery / success / failure detection. Default ["zh","en"]. */
    locales?: Array<"zh" | "en">;
    /** Replacement text emitted when a future-delivery commitment cannot be bound. Per locale. */
    blockedText?: {
      zh: string;
      en: string;
    };
    /** Replacement for terminal delivery success claims with no evidence. Per locale. */
    unsupportedSuccessText?: {
      zh: string;
      en: string;
    };
    /** Replacement for terminal delivery failure claims with no evidence. Per locale. */
    unsupportedFailureText?: {
      zh: string;
      en: string;
    };
    /** Replacement for state-mutation commitment claims with no runtime-effect evidence. Per locale. */
    unsupportedMutationText?: {
      zh: string;
      en: string;
    };
  };
}

export interface MidTaskInjectionConfig {
  /** Master switch. When false, PreToolUse memory injection short-circuits before any state mutation. */
  enabled: boolean;
  /** Number of non-skip-list tool calls before injection fires. Counter resets after each injection. */
  toolCallThreshold: number;
  /** Minimum milliseconds between consecutive injections per task, regardless of tool count. */
  cooldownMs: number;
  /** Max scored memories to include in the injected context (per call). */
  topK: number;
  /** Token budget for the injected context block (per call). */
  maxTokens: number;
}

export interface MemoryConfig {
  midTaskInjection: MidTaskInjectionConfig;
  retrievalWeights: {
    /** Weight for cosine-similarity signal (default 0.4) */
    cosSim: number;
    /** Weight for recency-decay signal (default 0.2) */
    recency: number;
    /** Penalty weight for token cost (default 0.05) */
    tokenCost: number;
  };
  /** Global token budget for memory context injection when role has no override (default 1500) */
  globalBudgetTokens: number;
  /** Exponential-decay half-life in days for recency signal (default 30) */
  retrievalDecayDays: number;
  attributionThresholds: {
    /** Weighted score above this threshold → high attribution (default 0.7) */
    high: number;
    /** Weighted score below this threshold → low attribution (default 0.4) */
    low: number;
  };
  /** Minimum inject_count before anti-pattern auto-flip can trigger (default 5) */
  antiFlipMinUses: number;
  /** success_ema below this threshold qualifies for anti-pattern flip (default 0.25) */
  antiFlipSuccessEmaThreshold: number;
  /** Reflection-pipeline Haiku budget (belief synthesis + conflict resolution). Default 5.0. */
  reflection?: ReflectionConfig;
  /** Belief scope evolution parameters (v3). */
  scope: {
    /** EMA smoothing factor α for success_ema updates (default 0.3). */
    emaAlpha: number;
    /** Weight multiplier for human feedback ratings relative to task score (default 3.0). */
    humanFeedbackWeight: number;
    /** Max beliefs in the reflection candidate pool per role (default 100). */
    reflectionPoolMax: number;
    /** Per-task EMA decay base: effective_ema = success_ema * decayBase^delta_seq (default 0.995). */
    decayBase: number;
    /** success_ema below this threshold triggers archive (default 0.2). */
    archiveThreshold: number;
  };
  /** Embedding model identifier (default 'bge-small-zh-v1.5'). */
  embeddingModel: string;
}

export interface ReflectionConfig {
  /** Max USD budget per Haiku call inside the reflection pipeline. Default 5.0. */
  maxBudgetUsd?: number;
}

export interface ExternalApiEndpoint {
  name: string;
  url: string;
  scorePath: string;
  metricNodeIds?: string[];
  weight?: number;
}

export interface ExecutionConfig {
  maxConcurrent: number;
  pollIntervalMs: number;
}

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultOpusModel?: string;
  defaultSonnetModel?: string;
  defaultHaikuModel?: string;
  smallFastModel?: string;
}

export interface EmailGatewayAuthConfig {
  user: string;
  pass: string;
}

export interface EmailGatewayEndpointConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: EmailGatewayAuthConfig;
}

export interface EmailGatewayConfig {
  enabled: boolean;
  address: string;
  displayName?: string;
  imap: EmailGatewayEndpointConfig & { mailbox: string };
  smtp: EmailGatewayEndpointConfig & { from?: string };
  subjectPrefix?: string;
}

export interface IntentEvalConfig {
  maxBudgetUsd?: number;
  timeoutMs?: number;
}

export interface AuditConfig {
  intentEval?: IntentEvalConfig;
}

export type ViewerKey = string;

export interface IdentityConfig {
  ownerViewerKey: ViewerKey;
}

export interface ServerConfig {
  defaults: DefaultsConfig;
  server: ServerSection;
  identity?: IdentityConfig;
  logging?: LoggingConfig;
  roles?: RolesConfig;
  chat?: ChatConfig;
  memory?: MemoryConfig;
  externalApis?: ExternalApiEndpoint[];
  watchdog?: WatchdogConfig;
  execution?: ExecutionConfig;
  anthropic?: AnthropicConfig;
  emailGateway?: EmailGatewayConfig;
  audit?: AuditConfig;
  evaluation?: {
    model?: string;
  };
  delivery?: {
    cronDefaultReportTo?: NotifyTarget[] | null;
  };
  storage?: StorageConfig;
  pricing?: PricingConfig;
  cost?: CostConfig;
}

export interface StorageConfig {
  /** Profile name embedded in `local://<profile>/<path>` artifact locators. Default "default". */
  localProfile: string;
}

// ===== Runtime Config Types =====

export type ConfigCategory = "runtime-mutable" | "restart-required";

export interface ConfigSchemaEntry {
  path: string;
  category: ConfigCategory;
  type: string;
  default: unknown;
}

export interface ConfigSchema {
  [key: string]: ConfigSchemaEntry;
}

// ===== Plan-Approve-Execute-Review-Learn Types (D-009, D-010, D-011, D-012) =====

export type RiskLevel = "low" | "medium" | "high";

export interface PlanStep {
  index: number;
  description: string;
  toolsNeeded: string[];
  expectedOutput: string;
  riskLevel: RiskLevel;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  requiredPermissions: EffectivePermissions;
  overallRisk: RiskLevel;
}

export type PlanStatus = "pending" | "approved" | "denied" | "completed";
export type ApprovalType = "once" | "permanent";

export interface TaskPlan {
  id: string;
  taskId: string;
  roleId?: string;
  plan: ExecutionPlan;
  status: PlanStatus;
  approvalType?: ApprovalType;
  deviationReport?: DeviationReport;
  // Plan-scoped raw rule strings with [+]/[-]/[~] prefix tags. Different from Role.learnedRules
  // (object) — see agent/learner.ts classifyRulesForRoleSlots for how these are split into Role slots.
  learnedRules?: string[];
  createdAt: number;
  approvedAt?: number;
  reviewedAt?: number;
}

export type DeviationType = "skipped" | "added" | "modified" | "failed";

export interface Deviation {
  stepIndex: number;
  planned: string;
  actual: string;
  deviationType: DeviationType;
}

export interface DeviationReport {
  stepsPlanned: number;
  stepsExecuted: number;
  deviations: Deviation[];
  overallAccuracy: number;
}

export interface ApprovalRule {
  id: string;
  roleId?: string;
  taskPattern: string;
  maxRiskLevel: RiskLevel;
  createdAt: number;
  createdByTaskId?: string;
}

export type WsEventType =
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "approval_needed"
  | "plan_approval_request"  // "plan_approval_request": historical naming from PAERL Plan-first design (governance crystal D-009). Actual semantic in Pure C architecture: tool operation privilege escalation request. Name preserved for downstream compatibility (WebSocket, PlanApprovalDialog, PlanApprovalBanner, Channel handler).
  | "status_change"
  | "error"
  | "complete";

export interface WsEvent {
  taskId: string;
  index: number;
  type: WsEventType;
  timestamp: number;
  data: unknown;
}

// ===== Goal-Driven Architecture Types =====

export type GoalStatus = "active" | "paused" | "completed" | "failed";

export type NotifyTarget =
  | { type: "session"; sessionId: string }
  | { type: "channel"; channelId: string; chatId?: string };

export type MetricLevel = "L0" | "L1" | "L2" | "L3";

// ===== Plugin Types (D-005, D-015) =====

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills: { name: string; description: string; error_patterns?: PluginErrorPattern[] }[];
  agents: { name: string; description: string }[];
  mcpServers: string[];
  hooks: string[];
  lspServers: string[];
}

export interface PluginErrorPattern {
  pattern: string;
  category: string;
  user_action: string;
}

// Marketplace types (Phase 3, D-008)

export interface MarketplacePluginEntry {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  source: { source: string; url: string };
  installCount: number;
}

export interface InstalledPluginEntry {
  id: string;
  name?: string;   // derived from id (id.split("@")[0]) if not present
  version: string;
  scope: "user" | "project" | "local";
  projectPath?: string;
  installPath: string;
  enabled: boolean;
  installedAt: string;
  lastUpdated: string;
}

export interface AvailablePluginsResponse {
  installed: InstalledPluginEntry[];
  available: MarketplacePluginEntry[];
}

export interface MarketplaceSource {
  name: string;
  url: string;
  addedAt: number;
}

export interface MarketplaceInfo {
  name: string;
  source: string;
  repo: string;
  installLocation: string;
}

// ===== Additional Directories (D-007) =====

export interface AdditionalDirectory {
  path: string;
  /** Access mode: 'rw' (default, for backwards compat) or 'ro' (read-only). */
  mode?: "ro" | "rw";
  inheritPlugins?: boolean;
  inheritMcp?: boolean;
  inheritPermissions?: boolean;
}

export type RoleStatus = "active" | "inactive" | "retired" | "probation" | "dead";

// ===== LearnedRules (Phase 3: podcast-stability pinned-parameters) =====

/**
 * A pinned default parameter for a Role.
 * `tool` is a glob pattern (DP-001):
 *   - Bash family: "Bash:<script>" matches when the Bash command contains <script>.
 *     The "Bash:" prefix is stripped before matching against the command string.
 *   - Other tools: matches against toolName directly (substring or glob).
 *     Contains "*" → anchored glob; otherwise → substring match.
 * `params` are merged into tool calls when the LLM does not provide those keys.
 * LLM-explicit values always win (DP-002).
 */
export interface PinnedParameter {
  tool: string;                    // glob pattern
  params: Record<string, unknown>;
  condition?: string;              // optional natural-language condition (informational)
  pinnedAt: number;                // Unix ms timestamp
}

/**
 * Structured learned rules for a Role.
 * - `stylePreferences`: positive style guidance (from [+]/[~] deviations, user saves).
 *   Legacy string[] rows land here after migration.
 * - `avoidedActions`: negative guidance (from [-] deviations, audit recommendations).
 * - `pinnedParameters`: tool-specific default params injected by canUseTool.
 */
export interface LearnedRules {
  stylePreferences: string[];
  avoidedActions: string[];
  pinnedParameters: PinnedParameter[];
}

/** Empty LearnedRules sentinel — used for initialised Roles with no learned data yet. */
export const EMPTY_LEARNED_RULES: LearnedRules = {
  stylePreferences: [],
  avoidedActions: [],
  pinnedParameters: [],
};

export type EffortTier = "low" | "medium" | "high";
export type SkillsConfig = string[] | "all";

export interface Role {
  id: string;
  name: string;              // 人名形式: 审慎者, 敏捷者, 探索者, 匠人
  cagPrompt: string;         // Character And Guidance prompt — free-text
  learnedRules: LearnedRules;
  memoryStreamId: string;
  status: RoleStatus;
  performanceScore?: number;
  preferences: RolePreferences;
  createdAt: number;
  updatedAt?: number;
  // Role-level tool permissions and execution config:
  allowedTools?: string[];
  disallowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: "isolated" | "inline";
  model?: string;
  maxBudgetUsd?: number;
  approvalRequired?: string[];
  source?: "system" | "user";
  // Additional working directories this role can access beyond its workspace cwd:
  additionalDirectories?: AdditionalDirectory[];
  allowedChannels?: string[];       // D-004: null=unrestricted, []=block all, ["name"]=whitelist
  mcpServers?: Record<string, unknown>;  // D-002: Role-bound MCP server configs
  inheritUserSettings?: boolean;          // D-013: true = settingSources: ["project", "user"]
  /** SDK permission mode controlling CLI's internal permission behavior. */
  permissionMode?: SdkPermissionMode;
  /** Bash commands matching these glob patterns are auto-executed without approval. */
  allowedBashPatterns?: string[];
  /** Bash commands matching these glob patterns are auto-rejected. */
  deniedBashPatterns?: string[];
  /** Preset identifier, set when this Role was seeded from a canonical preset. */
  presetId?: string;
  /** Custom environment variables injected into SDK subprocess for this role. */
  envVars?: Record<string, string>;
  /** Role-level OS capability selections enforced by Adam runtime where supported. */
  osCapabilities?: RoleOsCapability[];
  /** Resolved at dispatch to config.anthropic.default{Haiku|Sonnet|Opus}Model (DP-B1, DP-B5). */
  effortTier?: EffortTier;
  /** SDK skills option: array of skill names or "all". Replaces deprecated allowedTools: ["Skill"]. */
  skills?: SkillsConfig;
  /** Per-role token budget for memory context injection. Null/undefined → use global default from config.memory.globalBudgetTokens (default 1500). */
  memoryBudgetTokens?: number;
}

/**
 * Context shape used by buildExecutionSystemPrompt and buildExecutionSystemPromptParts.
 * Passed from ExecutionManager for each task.
 */
export interface ExecutionPromptContext {
  taskId: string;
  prompt: string;
  roleName?: string;
  roleCagPrompt?: string;
  allowedTools?: string[];
  cwd?: string;
  /** Set when this task is part of a template execution. */
  templateExecutionStep?: { executionId: string; stepId: string };
}

export interface RolePresetConfig {
  name: string;
  cagPrompt: string;
  preferences?: RolePreferences;
  // Absorbed from RolePresetConfig:
  allowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: "isolated" | "inline";
  model?: string;
}

export interface Goal {
  id: string;
  name: string;
  description?: string;
  roleId: string;
  metricType: string;
  targetValue: number;
  currentValue: number;
  deadline: number;
  budgetUsd: number;
  status: GoalStatus;
  createdAt: number;
  updatedAt?: number;
  sourceSessionId?: string;
  deliverTo?: NotifyTarget[];  // D-005: output delivery targets for goal completion notification
  reportTo?: NotifyTarget[];  // D-007: status report targets for goal completion notification
}

export interface SandboxViolationEvent {
  roleId: string;
  taskId?: string;
  path: string;
  operation: string;
  timestamp: number;
}

export interface MetricNode {
  id: string;
  goalId: string;
  level: MetricLevel;
  parentId?: string;
  name: string;
  description?: string;
  weight: number;
  calibrationFactor: number;
  createdAt: number;
}

export interface Strategy {
  id: string;
  roleId: string;
  taskType: string;
  name: string;
  promptTemplate: string;
  alpha: number;
  beta: number;
  totalTrials: number;
  avgReward?: number;
  toolProfile?: string[];
  createdAt: number;
  updatedAt?: number;
}

export interface Trial {
  id: string;
  strategyId: string;
  goalId: string;
  taskId?: string;
  reward?: number;
  metricL2Score?: number;
  metricL3Score?: number;
  context?: string;
  completedAt: number;
}

// ===== Agent Intelligence System Types =====

export type MemoryNodeType = "event" | "thought" | "reflection";

export type MemoryTier = "working" | "episodic" | "semantic";

export type MemorySourceType =
  | "task_complete"
  | "pre_compact" // legacy rows written before GAP-03 fix
  | "post_compact"
  | "app_compact" // application-layer compaction (replaces SDK auto-compact after issue #221)
  | "reflection"
  | "observation"
  | "session_archive"
  | "manual";

export type TaskTemplateTriggerType =
  | "cron"
  | "manual"
  | "once"
  | "template_complete"    // fires when a TemplateExecution for the target Template reaches final success; targetId in trigger.event
  | "event";              // fires when an event_def fires; eventDefId in trigger.eventDefId

export interface ServerState {
  id: number; // always 1 (single-row pattern)
  // sdkSessionId / toolsFingerprint removed (issue #221 cleanup): ChatManager no longer
  // persists or resumes SDK sessions, so neither field has any runtime consumer.
  // The DB columns (sdk_session_id, tools_fingerprint) are retained per the SQLite
  // migration rule "never DROP user data"; they exist as dead storage only.
  userTaskSessionId?: string;   // (legacy, keep for migration)
  chatSessionId?: string;       // ChatManager's chat session identifier
  workspacePath?: string;
  createdAt: number;
  lastActiveAt?: number;
}

export interface RolePreferences {
  model?: string;
  effort?: EffortLevel;
  maxTurns?: number;
}

// RBAC: Per-agent permission set (D-005) — kept for RBAC config reference (Phase 2 will refactor)
export interface RolePermissions {
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalRequired?: string[];
  /** Bash commands matching these glob patterns are auto-executed without approval. */
  allowedBashPatterns?: string[];
  /** Bash commands matching these glob patterns are auto-rejected. */
  deniedBashPatterns?: string[];
  maxBudgetUsd?: number;
  plugins?: string[];
}

// RBAC: Computed effective permissions after intersection with defaults (D-006)
export interface EffectivePermissions {
  allowedTools: string[];
  disallowedTools: string[];
  approvalRequired: string[];
  maxBudgetUsd: number;
  plugins: string[];
}

export type TaskExecutionProfile = Role;

export interface AdmissionSuccess {
  ok: true;
  roleId: string;
  executionProfile: TaskExecutionProfile;
  fitScore: number;
  warnings: AdmissionWarning[];
  tieBreakReason?: string;
  auditCandidates?: Array<{
    roleId: string;
    name: string;
    fitScore: number;
    fits: boolean;
  }>;
}

export interface AdmissionFailure {
  ok: false;
  code: AdmissionFailureCode;
  reason: string;
  missing?: {
    tools?: string[];
    paths?: TaskRequirementPath[];
    osCapabilities?: RoleOsCapability[];
    plugins?: string[];
    network?: boolean;
  };
  candidates?: Array<{
    roleId: string;
    name: string;
    fitScore: number;
    missing?: AdmissionFailure["missing"];
  }>;
}

export type AdmissionResult = AdmissionSuccess | AdmissionFailure;

export interface MemoryNode {
  id: string;
  roleId: string;
  type: MemoryNodeType;
  content: string;
  embedding?: Float32Array;
  keywords: string[];
  importance: number; // 1-5
  sourceType: MemorySourceType;
  sourceTaskId?: string;
  evidence?: string[]; // memory IDs referenced during reflection
  createdAt: number;
  lastAccessed: number;
  retrievedCount: number;
  tier: MemoryTier;
  supersededBy?: string; // ID of the memory that supersedes this one
}

export interface Belief {
  id: string;
  roleId: string;
  content: string;
  isAnti: boolean;
  evidenceObsIds: string[]; // memory IDs that supported this belief
  embedding?: Float32Array;
  supersededBy?: string;
  createdAt: number;
  lastUsedAt: number;
  lastValidatedAt: number;
  scopeKey?: string;
  status: "active" | "archived";
  /** Exponential-weighted recent success rate. NULL until first task completion. */
  successEma?: number;
  /** Number of times this belief has been injected into prompts (DP-001). */
  injectCount: number;
  // ----- v90: prediction ledger fields (only set when kind='prediction') -----
  /** Discriminator: 'behavior' = stable belief; 'prediction' = falsifiable claim. Defaults to 'behavior'. */
  kind?: "behavior" | "prediction";
  /** Caller's confidence in the prediction (0..1). */
  predictionConfidence?: number;
  /** Free-form statement of what would prove the prediction wrong. */
  falsifyCondition?: string;
  /** ISO date the prediction was issued (used to schedule settlement). */
  predictionDate?: string;
  /** Settlement status: null (behavior) or 'unsettled' | 'confirmed' | 'refuted' | 'partial'. */
  settlementStatus?: "unsettled" | "confirmed" | "refuted" | "partial";
  /** Unix ms when the prediction was settled. */
  settledAt?: number;
  /** Free-form description of what the evidence said. */
  settledOutcome?: string;
}

export interface BeliefVectorSearchResult {
  node: Belief;
  cosine: number;
}

// Concrete audit-source labels we recognize at the type level. The DB column itself is TEXT,
// so maintenance callers may pass more specific tags via the `string & {}` escape. This preserves
// autocomplete for the known labels while accepting custom strings without `as any` casts.
export type EvolutionAuditSource =
  | "reflection"
  | "admin"
  | "monitor"
  | "audit"
  | "manual"
  | "rule-cleanup"
  | (string & {});

export interface EvolutionAudit {
  id: string;
  timestamp: number;
  oldRules: string;
  newRules: string;
  diff: string;
  triggerTaskId?: string;
  roleId?: string; // null = orchestrator-level, non-null = per-agent
  source?: EvolutionAuditSource;
  traceId?: string;
}

export interface TaskStepConfig {
  timeout?: number;
  maxTurns?: number;
}

export interface TaskStep {
  id: string;
  prompt: string;
  dependsOn?: string[];
  /**
   * N-of-M tolerance: this step runs as long as at least minDependencies of dependsOn
   * succeeded. Absent = strict-AND (all must succeed). Note: no_content deps always
   * count as failed regardless of mode (DP-002 Chosen A — Bundle C's chokepoint already
   * treats no_content as a delivery gap; downstream consuming no_content was already
   * producing an empty pipeline result from the user's perspective).
   */
  minDependencies?: number;
  outputAs?: string;
  roleId?: string;
  requirements?: TaskRequirements;
  autoSelectRole?: boolean;
  config?: TaskStepConfig;
  /** Required upstream step IDs whose artifacts must be present before this step runs. Missing artifacts cause a hard-fail. */
  consumesFrom?: string[];
  /** Optional upstream step IDs. Missing artifacts are soft-fail (recorded, step continues). */
  consumesFromOptional?: string[];
  /** Persona constraints injected into the assembled prompt. */
  persona?: {
    /** Display name or persona label the agent should speak as (e.g. "卞旸"). */
    speakAs: string;
    /** Additional voice/style constraints. */
    voiceConstraints?: string;
  };
  /** Output contract expectations injected into the assembled prompt. */
  outputContract?: {
    /** Phase 2 enforcement: agent should show evidence of having consumed upstream artifacts. */
    mustReferenceArtifacts?: boolean;
    /** Up to 8 assertion strings evaluated by a Haiku judge after the step succeeds Layer A/B. */
    customAssertions?: string[];
    /**
     * The ONE contract vocabulary (single-vocabulary pure design — the legacy lengthTarget/
     * format/expectedArtifacts fields were removed). Track A/B rules enforced at SDK hook time:
     * Track A = content (PreToolUse on write_artifact); Track B = file-on-disk (PostToolUse on
     * publish_artifact_file). Schema in src/store/contract-rules.ts.
     */
    contractRules?: ContractRule[];
  };
  /** Phase 3: content-level assertions evaluated at publish_artifact_file time. Each string is a DSL expression like "audio.zc_rate_per_s < 5000" or "markdown.word_count between 100 and 5000". Empty/omitted = no validation runs. */
  assertions?: string[];
  /**
   * Podcast Phase 2: when true, the template-executor parses this step's result as the
   * 钱钟书 scoring JSON ({ candidates: [{ candidate_id, scores, selected, editor_notes }] })
   * and persists each candidate to the editor_scores table for the retrospective query.
   * Parse failures are logged at WARN and do not fail the run.
   */
  recordEditorScores?: boolean;
  /**
   * Podcast Phase 2 parallel-N: stable candidate id for this path (e.g. "稿-A").
   * persistEditorScores builds a candidateId → briefPerturbation map from the steps
   * that carry it, then maps the review-editor's per-candidate scores back to the
   * template-author-declared perturbation.
   */
  candidateId?: string;
  /**
   * Podcast Phase 2 parallel-N: the brief perturbation applied to this path, declared
   * by the template author (the "brief-layer author" per locked decision 1). It is the
   * canonical brief_diff written to editor_scores — never the LLM's output — so the
   * retrospective groups on a trusted value, not an LLM-produced string.
   */
  briefPerturbation?: { cross_domain_bucket: string | null; contrarian_source: string };
  /**
   * Step functional category — used as belief scope label.
   * Beliefs are bucketed per (roleId, stepKind); steps without kind fall back to 'default' scope.
   */
  kind?: string;
  /**
   * v90 Belief Ledger: opt-in. When set, the platform (prompt-assembler) injects
   * a settlement section block for the named owner at the top of this step's
   * assembled prompt. The owner id is opaque to the platform (e.g. 'podcast-show')
   * and typically comes from template config — NOT from agent output. Empty/unset
   * steps see no settlement block (zero regression on legacy templates).
   */
  settlementLedgerOwner?: string;
  /**
   * v90 Belief Ledger: opt-in. When set, the platform (template-executor) parses
   * this step's `outputAs` artifact as a JSON array of structured claims
   * `[{claim, confidence, falsifyCondition, date}]` and persists each to the
   * named owner (e.g. 'podcast-show'). Empty/unset steps see no claims
   * persistence. The step's prompt must declare claims as its single output
   * — DO NOT use this field on script-writing steps that output `{title,body}`;
   * the parser will reject the wrong shape and emit a warn.
   */
  publishesClaimsTo?: string;
  /**
   * v90 Belief Ledger (Phase 1.5): opt-in, the REVERSE of `publishesClaimsTo`.
   * When set, the platform (template-executor) parses this step's `outputAs`
   * artifact as a JSON array of settle-verdicts
   * `[{predictionId, status, outcome, newConfidence?, rewriteClaim?}]` and calls
   * `settlePrediction` for each, closing the self-falsification loop. Each
   * `predictionId` is validated against the owner's unsettled predictions
   * (unknown / cross-owner / already-settled ids are skipped). Set ONLY on a
   * dedicated verdict-producing step (e.g. a 结算 step) whose sole deliverable is
   * that array — typically the same step also sets `settlementLedgerOwner` to
   * receive the due predictions (with ids) in its prompt.
   */
  settlesPredictionsFor?: string;
  /**
   * v90 Belief Ledger (Phase 2): opt-in. When set, the platform (prompt-assembler)
   * injects an open-questions section block for the named owner at the top of this
   * step's assembled prompt. The block is DISJOINT from settlementLedgerOwner by age
   * (open-questions = age < lookbackDays; settlement = age >= dueDays), so the same
   * prediction never appears in both. Empty/unset steps see no open-questions block
   * (zero regression on legacy templates). Lookback window is clamped to
   * [1, dueDays-1] inside findRecentOpenPredictions — callers cannot widen it past
   * the settlement boundary even by passing a larger value.
   */
  openLedgerOwner?: string;
  /**
   * v90 Belief Ledger (Phase 2): optional window (in days) for the open-questions
   * block. Default 2. Clamped to [1, dueDays-1] inside findRecentOpenPredictions.
   * Ignored when openLedgerOwner is not set.
   */
  openLedgerLookbackDays?: number;
}

export interface AuditViolation {
  id: string;
  stepTaskId: string;
  executionId?: string;
  roleId: string;
  contractField: "lengthTarget" | "format" | "persona.speakAs" | "mustReferenceArtifacts" | "outputAs" | "race-rescue" | "customAssertions" | "expectedArtifacts";
  layer: "A" | "B" | "C";
  severity: "error" | "warning";
  message: string;
  metadata?: { confidence?: number; issues?: string[]; verifierTaskId?: string; nudgeAttempted?: boolean; raceRescued?: boolean; hasOutputContract?: boolean; hasPersona?: boolean };
  createdAt: number;
}

export interface TaskTemplateTrigger {
  type: TaskTemplateTriggerType;
  /** Cron expression, required when type='cron'. */
  cron?: string;
  /**
   * Contextual event string. Format depends on type:
   * - 'template_complete': 'template_complete:<templateId>' — fires when the specified Template's TemplateExecution reaches completed or partial
   */
  event?: string;
  /** ISO 8601 timestamp, required when type='once'. */
  runAt?: string;
  /** Event def ID, required when type='event'. */
  eventDefId?: string;
}

export interface TaskTemplate {
  id: string;
  name: string;
  description?: string;
  trigger: TaskTemplateTrigger;
  steps: TaskStep[];
  rolePreference?: string;
  config?: Partial<TaskConfig>;
  tags?: string[];
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
  sourceSessionId?: string;
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
  goalIds?: string[];
  /** True when this template was seeded from a canonical preset. */
  isPreset?: boolean;
  /** Preset identifier, set when this template was seeded from a canonical preset. */
  presetId?: string;
  /** Retry policy for validator-driven retries. When absent/null, validator retries are disabled. */
  retryPolicy?: { maxAttempts: number };
}

// ===== Chat & Channels Types =====

export type ChatSessionStatus = "active" | "archived";

export interface ChatSource {
  type: "tui" | "web" | "api" | "channel";
  channelId?: string;
  chatId?: string;
}

export interface ChatSession {
  id: string;
  status: ChatSessionStatus;
  source: ChatSource;
  title?: string;
  createdAt: number;
  lastActiveAt: number;
  archivedAt?: number;
  messageCount: number;
  /** SDK session id for cross-restart resume. NULL = no live SDK session yet. */
  sdkSessionId?: string;
}

// ============================================================================
// Chat Envelope Protocol (2026-05-05) — see docs/06-plans/2026-05-05-chat-envelope-protocol-design.md
// ============================================================================

/** Envelope kind — semantic role of a chat message in the conversation flow. */
export type ChatEnvelopeKind =
  | "user_message"
  | "assistant_text"
  | "status_report"
  | "result_delivery"
  | "approval_prompt"
  | "system_note"
  | "audit_note";

/** Approval prompt sub-shape (only meaningful when kind === 'approval_prompt'). */
export type ApprovalShape = "yes_no" | "choose_one" | "free_input";

/** Artifact storage backend scheme — 8 fixed values; only `local` is implemented this round. */
export type ArtifactLocatorScheme =
  | "local"
  | "webdav"
  | "gdrive"
  | "s3"
  | "mcp_kb"
  | "icloud"
  | "notion"
  | "obsidian";

/** Artifact retention policy hint. */
export type RetentionHint = "transient" | "session" | "persistent" | "archive";

/** Artifact at-rest encryption class. */
export type EncryptionClass = "none" | "at_rest" | "e2e";

/** Artifact semantic purpose (orthogonal to retention_hint). */
export type ArtifactPurpose = "report" | "media" | "data" | "scratch" | "archive";

export interface ArtifactCollectionManifest {
  type: "artifact_collection";
  outputAs: string;
  items: Array<{
    artifactId: string;
    key: string;
    filename?: string;
    mime?: string;
    sizeBytes: number;
    purpose?: ArtifactPurpose;
    /** Logical artifact role, set when the producing step declares outputContract.expectedArtifacts. */
    role?: string;
  }>;
}

/** Artifact access scope. */
export type ArtifactAccess = "private" | "shared" | "public";

/** Channel adapter capability declaration. */
export interface ChannelCapabilities {
  canEdit: boolean;
  canQuote: boolean;
  canParseQuote: boolean;
  canInlineButtons: boolean;
  maxTextLength: number;
  supportsAttachments: boolean;
  maxAttachmentsPerMessage?: number;
}

/** Outbound attachment carried inside an envelope. */
export interface ChatAttachment {
  artifactId: string;
  locator: string;
  filename: string;
  mimeType: string;
  size: number;
  purpose?: ArtifactPurpose;
  contentHash?: string;
  retentionHint?: RetentionHint;
  preview?: { thumbnail?: string; excerpt?: string };
}

/** Pending prompt resolution path tag. */
export type PromptResolvedVia =
  | "native_quote"
  | "token"
  | "button"
  | "auto_unique"
  | "cross_channel";

/** Reason a pending prompt expired without resolution. */
export type PromptExpiredReason = "timeout" | "task_terminated";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  source: ChatSource;
  taskId?: string;
  channelMessageId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  traceId?: string;
  kind?: ChatEnvelopeKind;
  parentMessageId?: string;
  threadRoot?: string;
  promptId?: string;
  approvalShape?: ApprovalShape;
  roleId?: string;
  attachments?: ChatAttachment[];
  mirroredToTargets?: DeliveryTarget[];
  platformMessageId?: string;
  seq?: number;
}

export type DeliveryCommitmentType = "future_delivery";
export type DeliveryCommitmentStatus = "pending" | "fulfilled" | "failed" | "blocked" | "cancelled";
export type DeliveryArtifactKind = "image" | "file" | "audio" | "video" | "report" | "result";

export interface DeliveryArtifactExpectation {
  kind: DeliveryArtifactKind;
  count?: number;
}

export interface DeliveryCommitmentEvidenceItem {
  deliveryLogId?: string;
  eventId?: string;
  artifactId?: string;
  attachmentIndex?: number;
  filename?: string;
  mimeType?: string;
  target?: NotifyTarget | DeliveryTarget;
  status: "delivered" | "failed";
  error?: string;
  deliveredAt?: number;
}

export interface AssistantDeliveryCommitment {
  id: string;
  traceId?: string;
  sessionId: string;
  sourceMessageId?: string;
  taskId?: string;
  commitmentType: DeliveryCommitmentType;
  status: DeliveryCommitmentStatus;
  target: NotifyTarget;
  artifactExpectation?: DeliveryArtifactExpectation;
  evidence?: DeliveryCommitmentEvidenceItem[];
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
  fulfilledAt?: number;
}

export interface CapturedDispatch {
  taskId: string;
  toolName: "dispatch_to_role" | "dispatch_by_requirements" | "dispatch_task" | string;
  origin?: { chatSessionId: string; source: ChatSource };
  reportTo?: NotifyTarget[];
  deliverTo?: NotifyTarget[];
  traceId?: string;
}

export interface ChatManagerResponse {
  text: string;
  traceId?: string;
  dispatches: CapturedDispatch[];
  /** True when the turn ended abnormally (inactivity timeout or external abort) with no content.
   *  Lets the chat path surface a visible notice instead of a blank reply. */
  timedOut?: boolean;
  /** Full cost recompute for this turn (perModel[] included). Set by runQuery after the SDK loop. */
  cost?: CostRecompute;
  /** Number of SDK turns for this chat turn. */
  numTurns?: number;
}

/** Aggregation API types for the Cost page */
export interface CostSummaryGroup {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  callCount: number;
}

export interface CostSummary {
  totalCostUsd: number;
  callCount: number;
  topModel?: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  unpricedCallCount: number;
  unpricedTokens: number;
  groups: CostSummaryGroup[];
  trend: Array<{ bucket: string; costUsd: number; callCount: number }>;
  /** Present only when trendStackBy was requested: per-bucket cost pivoted by stack key. */
  trendStacked?: Array<Record<string, string | number>>;
  /** The distinct stack keys (source or model values) present in trendStacked. */
  trendStackKeys?: string[];
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

export type ChannelPlatform =
  | "telegram"
  | "slack"
  | "discord"
  | "wechat"
  | "whatsapp"
  | "openclaw"
  | string;

export type ChannelStatus = "disconnected" | "connecting" | "connected" | "degraded" | "error";

export interface Channel {
  id: string;
  name: string;
  platform: ChannelPlatform;
  enabled: boolean;
  status: ChannelStatus;
  config: Record<string, unknown>;
  linkedRoleId?: string;
  allowedChatIds?: string[];
  viewerKey?: ViewerKey;
  createdAt: number;
  updatedAt?: number;
  lastMessageAt?: number;
  messageCount: number;
  recipientCapMap?: Record<string, number>;
  defaultRecipientCapBytes?: number;
}

export interface InboundMessage {
  channelId: string;
  platform: ChannelPlatform;
  chatId: string;
  senderId: string;
  senderName?: string;
  content: string;
  mediaUrl?: string;
  /** Local path to downloaded media file (after CDN download + decrypt, DP-003). */
  mediaPath?: string;
  mediaType?: "image" | "audio" | "video" | "file";
  /**
   * Legacy field: platform message ID being replied to. Slack adapter dual-writes both this and
   * `quotedPlatformMessageId` for backward compat (D-A3). New code should read `quotedPlatformMessageId`.
   */
  replyToMessageId?: string;
  /**
   * Envelope-protocol field: platform message ID being quoted (WeChat ref_msg / Telegram reply_to_message /
   * Slack thread_ts / Discord message_reference). Phase 5 message-handler resolution step #1 (native_quote)
   * looks up `chat_messages WHERE platform_message_id = ?` to find the parent envelope.
   */
  quotedPlatformMessageId?: string;
  /**
   * Envelope-protocol field: structured payload from a button click (Telegram callback_query / Slack action /
   * Web button). When set, message-handler resolution step #3 (button) directly binds to the prompt by promptId.
   */
  buttonPayload?: {
    promptId: string;
    rawValue: string;
  };
  isGroup: boolean;
  timestamp: number;
  raw: unknown;
  /** Set by system to prevent anti-loop. "system" = sent by DeliveryEngine. */
  source?: "user" | "system";
}

export interface OutboundAttachment {
  path: string;
  mediaType?: "image" | "audio" | "video" | "file";
  filename?: string;
  contentType?: string;
  artifactId?: string;
  locator?: string;
  mimeType?: string;
  sizeBytes?: number;
  purpose?: ArtifactPurpose;
  contentHash?: string;
}

export interface OutboundMessage {
  content: string;
  replyToMessageId?: string;
  mediaUrl?: string;
  mediaType?: "image" | "audio" | "video" | "file";
  attachments?: OutboundAttachment[];
  messageType?: string;
  /**
   * Telegram inline keyboard (typed shape).
   * Slack adapter ALSO reads `.blocks` field via runtime cast (Phase 3 D-A1; type-system bypass acknowledged).
   * Future cleanup: promote `blocks` to a first-class `OutboundMessage.blocks?: unknown[]` field once
   * Slack-specific patterns stabilize, then remove the runtime cast in slack.ts.
   */
  replyMarkup?: {
    inlineKeyboard: Array<Array<{ text: string; callbackData?: string; url?: string }>>;
  };
  /**
   * WeChat-specific: text shown inside the ref_msg quote block (parent message excerpt, ≤80 chars).
   * Other adapters ignore this field. Set by Phase 4 handleTaskCompletion alongside replyToMessageId
   * (which carries the parent envelope's platform_message_id).
   */
  quoteExcerpt?: string;
  /**
   * WeChat-specific: title rendered above the ref_msg quote (typically the thread brief).
   * Other adapters ignore this field.
   */
  quoteTitle?: string;
}

export interface ChannelAdapter {
  readonly platform: ChannelPlatform;
  readonly id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ChannelStatus;
  /** Channel adapter capability declaration (envelope protocol Phase 2). */
  getCapabilities(): ChannelCapabilities;
  sendMessage(chatId: string, message: OutboundMessage): Promise<string>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  sendTypingIndicator?(chatId: string): Promise<void>;
  editMessage?(chatId: string, messageId: string, content: string): Promise<void>;
  deleteMessage?(chatId: string, messageId: string): Promise<void>;
}

// ===== Delivery Rules (D-001 through D-009) =====

export type DeliveryEventType =
  | "task_complete"
  | "task_error"
  | "plan_approval_request"
  | "template_execution_failed"
  | "*";  // "plan_approval_request": historical naming — actual semantic is privilege escalation. See privilege-escalation-timezone-crystal D-005.
export type DeliveryTargetType = "channel" | "webhook";
export type DeliveryStatus = "pending" | "delivered" | "failed" | "expired";

/** Mistake pattern status values. */
export type MistakePatternStatus = "new" | "acknowledged" | "dismissed";

/** Aggregation dimension types for cross-role mistake patterns. */
export type MistakeDimensionType = "event_type" | "score_degradation" | "tool_call_pattern";

/**
 * Cross-role mistake pattern.
 * dimension_type + dimension_value form the unique bucket key.
 */
export interface MistakePattern {
  id: string;
  dimensionType: MistakeDimensionType;
  dimensionValue: string;
  count: number;
  /** Role IDs that have triggered this pattern. */
  roleIds: string[];
  /**
   * Sample evidence IDs, capped at 10 most-recent (DP-4.9).
   * source: which table the evidence came from.
   */
  sampleEvidenceIds: Array<{ source: "evolution_audit" | "role_scores" | "delivery_log"; id: string }>;
  status: MistakePatternStatus;
  firstSeen: number;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryMatchCriteria {
  templateId?: string;
  roleId?: string;
  promptPattern?: string;
  /** Regex patterns; if any matches the prompt, the rule does NOT fire for this event. */
  excludePromptPatterns?: string[];
  taskStatus?: string;
}

export interface DeliveryTarget {
  type: DeliveryTargetType;
  channelId?: string;
  chatId?: string;
  webhookUrl?: string;
}

export interface DeliveryRule {
  id: string;
  eventType: DeliveryEventType;
  matchCriteria: DeliveryMatchCriteria;
  target: DeliveryTarget;
  formatTemplate?: string;
  maxPerMinute: number;
  skipOriginChannel: boolean;
  enabled: boolean;
  createdAt: number;
  createdBy?: string;
}

export interface DeliveryLogEntry {
  id: string;
  ruleId?: string;
  taskId?: string;
  executionId?: string;
  status: DeliveryStatus;
  target: DeliveryTarget;
  content: string;
  attempts: number;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  expiresAt: number;
  source?: "rule" | "direct" | "tool" | "audit";
  messageType?: string;
  traceId?: string;
}

export type UserVisibleSourceType = "task" | "template_execution" | "unknown";

export interface UserVisibleTarget {
  type: "channel" | "webhook" | "session";
  channelId?: string;
  chatId?: string;
  webhookUrl?: string;
  sessionId?: string;
  label?: string;
}

export interface UserVisibleAttachment {
  artifactId?: string;
  locator?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  purpose?: ArtifactPurpose;
  contentHash?: string;
}

export interface UserVisibleEvent {
  id: string;
  eventKey: string;
  sourceType: UserVisibleSourceType;
  sourceId: string;
  taskId?: string;
  templateId?: string;
  templateName?: string;
  messageType: string;
  viewerKey: ViewerKey;
  title?: string;
  contentPreview: string;
  attachments: UserVisibleAttachment[];
  targets: UserVisibleTarget[];
  firstDeliveredAt: number;
  lastDeliveredAt: number;
  createdAt: number;
  traceId?: string;
}

export type AuditDiagnosticSource = "delivery_ledger" | "viewer_identity" | "commitment_audit" | (string & {});
export type AuditDiagnosticSeverity = "info" | "warning" | "error";

export interface AuditDiagnostic {
  id: string;
  source: AuditDiagnosticSource;
  severity: AuditDiagnosticSeverity;
  traceId?: string;
  sourceId?: string;
  message: string;
  createdAt: number;
}

export type AuditorDivergenceSubtype = "old_blocks_new_passes" | "old_passes_new_blocks";

/** Source of claims for a turn: implicit (from receipts), explicit (from commit_claim tool), hybrid (both), vacuous (none), conflict (explicit mismatches implicit), fallback_legacy (synthesizer threw) */
export type ClaimSource = "implicit" | "explicit" | "hybrid" | "vacuous" | "conflict" | "fallback_legacy";

/** 4-way verdict comparison between old and new auditor. Agreed cases included to support 30-day retirement metric. */
export type VerdictPair = "agreed_pass" | "agreed_block" | "old_blocks_new_passes" | "old_passes_new_blocks";

export interface AuditorDivergenceRow {
  id: string;
  traceId: string;
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  wirePoint: "message_handler" | "chat_manager_envelope";
  oldVerdict: "passed" | "blocked";
  newVerdict: "passed" | "blocked";
  divergenceSubtype: AuditorDivergenceSubtype;
  /** @deprecated since Phase 6 — use verdictPair for the full 4-way breakdown (including agreed_* cases) */
  verdictPair: VerdictPair;
  oldReplacementText?: string;
  newReplacementText?: string;
  recordedAt: number;
}

export interface RuntimeEffect {
  id: string;
  traceId?: string;
  effectType: string;
  effectCategory: string;
  entityType: string;
  entityId?: string;
  fieldPath?: string;
  before?: unknown;
  after?: unknown;
  createdAt: number;
  actorRoleId?: string;
  toolName?: string;
}

export interface AssistantCommitmentAudit {
  id: string;
  traceId?: string;
  sessionId?: string;
  messageId?: string;
  status: "passed" | "blocked";
  claimType: string;
  claimText: string;
  evidenceEffectIds: string[];
  createdAt: number;
  reason?: string;
}

export interface AssistantCommitmentAuditResult {
  status: "passed" | "blocked";
  claimType?: string;
  claimText?: string;
  evidenceEffectIds?: string[];
  reason?: string;
  replacementText?: string;
}

// ============================================================================
// Effect Receipt — unified action receipt for claim-receipt audit architecture
// (Phase 1 of 2026-05-13 claim-receipt-architecture dev-guide)
// ============================================================================

export type EffectCategory = "outbound_message" | "entity_mutation";

/** For outbound_message receipts: where the message went. */
export interface EffectReceiptTarget {
  channelId: string;
  chatId?: string;
  platform?: string;
}

/** For outbound_message receipts: what was sent. attachmentRefs are artifact IDs or
 *  user-visible filenames depending on source — Phase 4 will standardize per writer. */
export interface EffectReceiptPayload {
  textChars: number;
  attachmentCount: number;
  attachmentRefs?: string[];
}

/** For entity_mutation receipts: one field-level change. */
export type EffectReceiptFieldChangeOp = "set" | "list_add" | "list_remove";

export interface EffectReceiptFieldChange {
  path: string;                        // e.g. "deliverTo", "name", "config.timeout"
  op: EffectReceiptFieldChangeOp;
  added?: unknown[];                   // op=list_add: items appended
  removed?: unknown[];                 // op=list_remove: items removed
  before?: unknown;                    // op=set: prior value (for diff visibility)
  after?: unknown;                     // op=set: new value
  beforeCount?: number;                // op=list_add/list_remove: list length before
  afterCount?: number;                 // op=list_add/list_remove: list length after
}

/** For batch entity_mutation receipts (e.g., cancel-many). */
export interface EffectReceiptScope {
  filter: string;                      // human-readable description, e.g. "status=running AND role_id=role-x"
  matchedCount: number;                // total entities affected
}

/** Actor metadata — who wrote this receipt. trace_id always required for cross-row joins. */
export interface EffectReceiptActor {
  traceId: string;
  toolName: string;
  taskId?: string;
  roleId?: string;
}

/** A single effect receipt — what actually happened, recorded by the tool that did it.
 *  One row in `effect_receipts`. Either entityId (single) or entityIds (batch) — never both. */
export interface EffectReceipt {
  id: string;
  traceId: string;
  taskId?: string;
  sessionId?: string;
  effectCategory: EffectCategory;
  verb: string;                        // "send" | "update" | "create" | "delete" | "cancel" | "enable" | "disable" | "bind" | "unbind" | ...
  entityType: string;                  // "channel_message" | "task_template" | "task" | "goal" | "role" | ...
  entityId?: string;                   // for single-entity receipts
  entityIds?: string[];                // for batch-entity receipts (mutually exclusive with entityId)
  target?: EffectReceiptTarget;        // required for outbound_message
  payload?: EffectReceiptPayload;      // required for outbound_message
  fieldChanges?: EffectReceiptFieldChange[];  // for entity_mutation single-entity
  scope?: EffectReceiptScope;          // for entity_mutation batch
  actor: EffectReceiptActor;
  /** Phase 2 DP-002: success | failure. Both outcomes produce receipts; verifier only
   * treats outcome='success' as delivery evidence. Failure receipts are debugging substrate. */
  outcome: "success" | "failure";
  createdAt: number;
}

/** Input shape for writeEffectReceipt — id and createdAt are auto-filled. */
export type EffectReceiptInput = Omit<EffectReceipt, "id" | "createdAt" | "outcome"> & {
  id?: string;
  createdAt?: number;
  /** Phase 2 DP-002: defaults to 'success' when omitted. */
  outcome?: "success" | "failure";
};

// ============================================================================
// Claim Spec — what an LLM declares it did. Verified against effect_receipts.
// (Phase 3 of 2026-05-13 claim-receipt-architecture dev-guide)
// ============================================================================

export interface ClaimSpecOutboundExpected {
  kind: "outbound";
  target: { channelId: string; chatId?: string };
  attachmentCount?: number;   // verifier requires receipt.attachmentCount >= this
  textPresent?: boolean;       // verifier requires receipt.textChars > 0 when true
}

export interface ClaimSpecFieldChangeExpected {
  kind: "field_change";
  entityId: string;
  fieldPath: string;
  op: EffectReceiptFieldChangeOp;  // reuse Phase 1 op type
  added?: unknown[];        // op=list_add: claimed items (verifier: superset)
  removed?: unknown[];      // op=list_remove: claimed items (verifier: superset)
  after?: unknown;          // op=set: claimed new value (verifier: deep-equal)
}

export interface ClaimSpecBatchExpected {
  kind: "batch";
  entityType: string;       // restrict match to this entity_type
  entityIds?: string[];    // verifier: receipt.entityIds ⊇ claimed entityIds
  scope?: {
    filter: string;          // free-text label only (verifier ignores; just for human read)
    expectedCount: number;   // verifier: receipt.scope.matchedCount >= expectedCount
  };
}

export type ClaimSpecExpected =
  | ClaimSpecOutboundExpected
  | ClaimSpecFieldChangeExpected
  | ClaimSpecBatchExpected;

export interface ClaimSpec {
  verb: string;                // free-text, mirrors EffectReceipt.verb
  entityType: string;          // free-text, mirrors EffectReceipt.entityType
  expected: ClaimSpecExpected;
  note?: string;               // human-readable, audit log only — not consumed by verifier
  /** Set only when this claim was synthesized purely from completion language in the
   *  reply text with NO backing tool-call receipt (the silent-failure path). Typed marker
   *  (not a note-prefix convention) so the audit replacement text can render a plain-language
   *  "claimed done but called no tool" message instead of the technical outbound/_unspecified
   *  wording. verbFamily mirrors the completion-language detector's VerbFamily union. */
  textDerivedStub?: { verbFamily: string; evidenceSpan: string };
}

export interface AssistantClaim {
  id: string;
  traceId: string;
  sessionId?: string;
  taskId?: string;
  sourceMessageId?: string;
  claims: ClaimSpec[];
  declaredAt: number;
}

export interface ClaimAuditPerClaimResult {
  claim: ClaimSpec;
  verdict: "passed" | "blocked";
  matchedReceiptIds: string[];     // receipt IDs (effect_receipts.id) that support this claim
  missingEvidence?: string;         // human-readable reason when verdict=blocked
}

export interface ClaimAuditResult {
  status: "passed" | "blocked";
  perClaim: ClaimAuditPerClaimResult[];
  claimSource: ClaimSource;
  replacementText?: string;         // populated when status=blocked
}

export interface AssistantClaimAudit {
  id: string;
  traceId: string;
  sessionId?: string;
  messageId?: string;
  status: "passed" | "blocked";
  perClaim: ClaimAuditPerClaimResult[];
  claimSource: ClaimSource;
  replacementText?: string;
  createdAt: number;
}

// ============================================================================
// Template Execution — shared step result types
// (used by template-executor + template-summary-assembler)
// ============================================================================

/** Result of a single TemplateExecution step. */
export interface StepResult {
  stepId: string;
  taskId: string;
  status: "completed" | "failed" | "skipped" | "cancelled" | "no_content";
  roleId?: string;
  roleName?: string;
  result?: string;
  error?: string;
  /** D-004: Admission failure info when step could not be dispatched */
  admissionError?: {
    code: string;
    reason: string;
    candidates?: Array<{ roleId: string; name: string; fitScore: number }>;
  };
}

/** Final result of a TemplateExecution run. */
export interface TemplateExecutionResult {
  executionId: string;
  status: "completed" | "failed" | "partial" | "cancelled";
  stepResults: Map<string, StepResult>;
}

// ===== Event Slot Types =====

export type EventSourceType = "webhook" | "directory_watch" | "cron" | "manual";

export interface EventDef {
  id: string;
  name: string;
  sourceType: EventSourceType;
  sourceConfig: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export class RoleHasActiveTasksError extends Error {
  readonly code = "ROLE_HAS_ACTIVE_TASKS";
  constructor(
    public readonly roleId: string,
    public readonly roleName: string,
    public readonly activeTaskCount: number,
    public readonly taskStatuses: string[],
  ) {
    super(`Role '${roleName}' has ${activeTaskCount} active task(s) (${taskStatuses.join(", ")}) and cannot be deleted without the force flag.`);
    this.name = "RoleHasActiveTasksError";
  }
}
