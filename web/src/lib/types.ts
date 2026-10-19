// Types mirroring the Adam server's shared/types.ts

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type GoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed";

export type NotifyTarget =
  | { type: "session"; sessionId: string }
  | { type: "channel"; channelId: string; chatId?: string };

export interface TokenUsage {
  input: number;
  output: number;
}

export interface Task {
  id: string;
  parentId?: string;
  status: TaskStatus;
  prompt: string;
  originalPrompt?: string;
  result?: string;
  error?: string;
  blockReason?: {
    reason: string;
    missingPrereqs?: string[];
    resumeHint?: string;
  };
  roleId?: string;
  templateId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
  tokenUsage?: TokenUsage;
  numTurns?: number;
  totalDurationMs?: number;
  sourceSessionId?: string;
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
}

export interface RolePreferences {
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  maxTurns?: number;
}

export type OsCapabilityStatus =
  | "runtime-enforced"
  | "host-only"
  | "registered-unwired";

export type DerivedOsCapabilityAvailability =
  | "editable"
  | "host-only"
  | "registered-unwired"
  | "platform-unsupported";

export interface RoleOsCapability {
  id: string;
  targets?: string[];
}

export interface OsCapabilityMeta {
  id: string;
  label: string;
  description: string;
  platform: "darwin";
  status: OsCapabilityStatus;
  supportsTargets?: boolean;
  disabledReason?: string;
}

export interface ResolvedOsCapabilityMeta extends OsCapabilityMeta {
  availability: DerivedOsCapabilityAvailability;
  editable: boolean;
  effectiveDisabledReason?: string;
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
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
}

export interface RoleConfigCapabilities {
  registry: ResolvedOsCapabilityMeta[];
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

export interface TaskTemplateTrigger {
  type: "cron" | "manual" | "once" | "template_complete";
  cron?: string;
  event?: string;
  runAt?: string;
}

export interface TaskStepConfig {
  timeout?: number;
  maxTurns?: number;
}

export interface TaskStep {
  id: string;
  prompt: string;
  dependsOn?: string[];
  outputAs?: string;
  roleId?: string;
  config?: TaskStepConfig;
  consumesFrom?: string[];
  consumesFromOptional?: string[];
  persona?: {
    speakAs: string;
    voiceConstraints?: string;
  };
  outputContract?: {
    lengthTarget?: { min: number; max: number; unit: "characters" | "words" | "bytes" };
    format?: "markdown" | "text" | "json";
    mustReferenceArtifacts?: boolean;
    expectedArtifacts?: Array<{ role: string; mime?: string; count: number; required?: boolean }>;
  };
}

export interface PrimaryArtifactRef {
  stepId: string;
  key?: string;
}

export interface DeliveryConfig {
  mode: "concat-step-results" | "primary-artifact" | "custom";
  primaryArtifact?: PrimaryArtifactRef;
  customRenderer?: string;
}

export interface TaskConfig {
  timeout?: number;
  maxTurns?: number;
  continueOnError?: boolean;
  delivery?: DeliveryConfig;
  [key: string]: unknown;
}

export interface TaskTemplate {
  id: string;
  name: string;
  description?: string;
  trigger: TaskTemplateTrigger;
  steps: TaskStep[];
  rolePreference?: string;
  config?: TaskConfig;
  tags?: string[];
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
  sourceSessionId?: string;
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
  goalIds?: string[];
  /** True if this template was seeded from a preset. */
  isPreset?: boolean;
  /** The preset ID this template was seeded from, if any. */
  presetId?: string;
  /** Retry policy for validator-driven retries. When absent, validator retries are disabled. */
  retryPolicy?: { maxAttempts: number };
}

export interface ReadyCheck {
  status: "ready" | "not_ready";
  checks: {
    database: boolean;
    config: boolean;
    roles?: boolean;
    embedding?: boolean;
    taskHub?: boolean;
  };
}

export interface LogEntry {
  type: "log_event";
  timestamp: number;
  level: string;
  component: string;
  msg: string;
  metadata?: unknown;
}

// Plan approval types (D-010)
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
  requiredPermissions: Record<string, unknown>;
  overallRisk: RiskLevel;
}

export interface PlanApprovalRequest {
  taskId: string;
  planId: string;
  plan: ExecutionPlan;
}

export interface Deviation {
  stepIndex: number;
  planned: string;
  actual: string;
  deviationType: "skipped" | "added" | "modified" | "failed";
}

export interface DeviationReport {
  stepsPlanned: number;
  stepsExecuted: number;
  deviations: Deviation[];
  overallAccuracy: number;
}

export interface TaskPlan {
  id: string;
  taskId: string;
  roleId?: string;
  plan: ExecutionPlan;
  status: "pending" | "approved" | "denied" | "completed";
  approvalType?: "once" | "permanent";
  deviationReport?: DeviationReport;
  learnedRules?: string[];
  createdAt: number;
  approvedAt?: number;
  reviewedAt?: number;
}

// Step log types (for execution timeline)
export type StepLogType =
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_response"
  | "permission_denied"
  | "error"
  | "plugin_error";

export interface StepLog {
  id: string;
  taskId: string;
  index: number;
  type: StepLogType;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  truncated?: boolean;
  timestamp: number;
  tokenUsage?: TokenUsage;
  planStepIndex?: number;
}

export type DeliveryTarget =
  | { type: "session"; sessionId: string }
  | { type: "channel"; channelId: string; chatId?: string }
  | { type: "webhook"; webhookUrl: string };

export type DeliveryStatus = "pending" | "delivered" | "failed" | "expired";

export interface DeliveryLogEntry {
  id: string;
  ruleId?: string;
  taskId?: string;
  status: DeliveryStatus;
  target: DeliveryTarget;
  content: string;
  attempts: number;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  expiresAt: number;
  source?: "rule" | "direct" | "tool";
  messageType?: string;
}

export interface TaskDimensionScores {
  taskSuccess: number;
  planAccuracy: number;
  permissionCompliance: number;
  efficiency: number;
  /** Phase 2: optional 5th dimension; null/missing when LLM eval is pending/unavailable. */
  intentFulfillment?: number | null;
  weighted: number;
}

export interface RoleScoreRecord {
  id: string;
  roleId: string;
  taskId: string;
  scores: TaskDimensionScores;
  emaScore: number;
  createdAt: number;
}

export type RoleStatus = "active" | "inactive" | "retired" | "probation" | "dead";

// ===== LearnedRules (mirrors src/shared/types.ts — Phase 3) =====
export interface PinnedParameter {
  tool: string;
  params: Record<string, unknown>;
  condition?: string;
  pinnedAt: number;
}

export interface LearnedRules {
  stylePreferences: string[];
  avoidedActions: string[];
  pinnedParameters: PinnedParameter[];
}

export interface AdditionalDirectoryEntry {
  path: string;
  mode?: "ro" | "rw";
  inheritPlugins?: boolean;
  inheritMcp?: boolean;
  inheritPermissions?: boolean;
}

export type SdkPermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan" | "auto";

export interface Role {
  id: string;
  name: string;
  cagPrompt: string;
  learnedRules: LearnedRules;
  memoryStreamId: string;
  status: RoleStatus;
  performanceScore?: number;
  preferences: RolePreferences;
  createdAt: number;
  updatedAt?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  evaluationCriteria?: Record<string, number>;
  executionMode?: "isolated" | "inline";
  model?: string;
  /** Resolved at dispatch to config.anthropic.default{Haiku|Sonnet|Opus}Model per effort tier. */
  effortTier?: "low" | "medium" | "high";
  maxBudgetUsd?: number;
  additionalDirectories?: AdditionalDirectoryEntry[];
  approvalRequired?: string[];
  source?: "system" | "user";
  allowedChannels?: string[];
  inheritUserSettings?: boolean;
  /** SDK permission mode controlling CLI's internal permission behavior. */
  permissionMode?: SdkPermissionMode;
  /** Bash commands matching these glob patterns are auto-executed without approval. */
  allowedBashPatterns?: string[];
  /** Bash commands matching these glob patterns are auto-rejected. */
  deniedBashPatterns?: string[];
  /** Custom environment variables injected into SDK subprocess for this role. */
  envVars?: Record<string, string>;
  osCapabilities?: RoleOsCapability[];
  /** The preset ID this role was seeded from, if any. */
  presetId?: string;
}

export interface RolePlugin {
  roleId: string;
  pluginId: string;
  boundAt: number;
}

export interface ExecutionPoolStatus {
  active: number;
  max: number;
  queued: number;
}

export type GlobalEvent =
  | { type: "task_status_change"; taskId: string; oldStatus: string; newStatus: string }
  | { type: "approval_request"; taskId: string; approvalId: string; toolName: string; toolInput: Record<string, unknown>; matchedPattern: string }
  | { type: "stats_update"; activeTasks: number; queuedTasks: number; totalCostToday: number }
  | { type: "goal_status_change"; goalId: string; oldStatus: string; newStatus: string }
  | { type: "config_changed"; changes: { path: string; value: unknown }[] }
  | { type: "plan_approval_request"; taskId: string; planId: string; plan: ExecutionPlan }
  | { type: "plan_approval_decision"; taskId: string; planId: string; decision: "allow" | "deny"; approvalType?: "once" | "permanent"; reason?: string }
  | { type: "task_created"; taskId: string }
  | { type: "execution_slot_change"; active: number; max: number; queued: number }
  | { type: "execution_task_start"; taskId: string; slotIndex: number }
  | { type: "execution_task_end"; taskId: string; slotIndex: number; status: "completed" | "failed" | "blocked" }
  | { type: "delivery_status_change"; taskId?: string; logEntryId: string; target: DeliveryTarget; status: DeliveryStatus; error?: string; messageType?: string }
  | LogEntry;

// ─── Artifacts (mirrors src/store/artifacts.ts) ───────────────────────────────

export type ArtifactKind = "json" | "file";

export interface Artifact {
  id: string;
  sourceKind: "template_step" | "task_published" | "chat_sent";
  executionId?: string;
  taskId?: string;
  chatSessionId?: string;
  stepId?: string;
  roleId?: string;
  key?: string;
  kind: ArtifactKind;
  value?: unknown;
  blobPath?: string;
  mime?: string;
  originalFilename?: string;
  sizeBytes: number;
  createdAt: number;
  locator?: string;
  contentHash?: string;
  retentionHint?: string;
  encryptionClass?: string;
  purpose?: string;
  replaces?: string;
  producedByRole?: string;
  access?: string;
}

export interface Belief {
  id: string;
  roleId: string;
  content: string;
  isAnti: boolean;
  evidenceObsIds: string[];
  embedding?: unknown;
  supersededBy?: string;
  createdAt: number;
  lastUsedAt: number;
  lastValidatedAt: number;
  scopeKey?: string;
  status: "active" | "archived";
  successEma?: number;
  injectCount: number;
}

export interface AuditViolation {
  id: string;
  stepTaskId: string;
  executionId?: string;
  roleId: string;
  contractField: "lengthTarget" | "format" | "persona.speakAs" | "mustReferenceArtifacts" | "outputAs" | "race-rescue" | "customAssertions";
  layer: "A" | "B" | "C";
  severity: "error" | "warning";
  message: string;
  metadata?: { confidence?: number; issues?: string[]; verifierTaskId?: string };
  createdAt: number;
}
