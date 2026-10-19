import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveTierModel } from "./effort-tier-resolver.js";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { v4 as uuidv4 } from "uuid";
import { buildExecutionSystemPromptParts } from "./execution-system-prompt.js";
import { buildCanUseTool, buildSessionHooks, type PermissionResult } from "./hooks.js";
import { getSandboxProvider } from "../sandbox/provider.js";
import type { VisiblePath } from "../sandbox/types.js";
import { getRole } from "../store/roles.js";
import { getRoleWorkspacePath, ensureRoleWorkspace } from "../store/role-workspace.js";
import { updateTask, getTask, updateTaskConfig, updateContextMeta } from "../store/tasks.js";
import { createStepLog } from "../store/logs.js";
import { getDb } from "../store/db.js";
import { serverBus } from "../server/events/server-bus.js";
import { RUNTIME_DIR } from "../shared/constants.js";
import { getLogger } from "../lib/logger.js";
import type { Task, AdditionalDirectory, ExecutionPlan, EffectivePermissions, Role, TokenUsage } from "../shared/types.js";
import { recordTaskPlugins } from "../store/task-plugins.js";
import { createExecutionTools, EXECUTION_TOOLS_MCP_NAME } from "./execution-tools.js";
import { resolveRolePluginPaths } from "../lib/role-capabilities.js";
import { createTaskPlan, updateTaskPlanStatus } from "../store/task-plans.js";
import { findMatchingRule } from "../store/approval-rules.js";
import { buildSdkEnv, getRuntimeConfig } from "../config/runtime.js";
import { registerTaskPid, unregisterTaskPid } from "./execution-pool.js";
import { registerTask, unregisterTask } from "../platform/workspace-watcher.js";
import { snapshot, diff, serializeTuples, type SnapshotEntry, type SnapshotTuple } from "../platform/workspace-snapshot.js";
import { insertTaskFilesDiff } from "../store/task-files.js";
import { reportViolation } from "../audit/violation-watcher.js";
import { getConfigValue } from "../store/config.js";
import { getSdkMcpServersForRole, SYSTEM_MCP_PREFIXES, externalOAuthDenyGlobs } from "./role-mcp-registry.js";
import { resolveExtensionsForTask, type ExtensionMcpMap } from "../extensions/runtime-resolver.js";
import { upsertHealth } from "../store/extension-health.js";
import { listBindingsByRole } from "../store/role-extensions.js";
import { resolveTilde } from "../lib/path-permissions.js";
import { getTaskTemplate } from "../store/task-templates.js";
import { ContractRuleSchema, isTrackA } from "../store/contract-rules.js";
import { buildTrackAHook } from "../audit/pre-tool-verifier.js";
import { buildAuditWriter, buildStepLogWriter } from "../audit/hook-context-factory.js";
import { buildTrackBHook } from "../audit/post-tool-verifier.js";
import { resolveContractRules, INACTIVITY_SENTINEL, deriveLedgerShapeRules } from "../lib/resolve-contract-rules.js";
import { analyzeAudioFile } from "../lib/audio-analysis.js";
import { realpathSync, mkdirSync, appendFileSync, chmodSync, existsSync } from "node:fs";
import { stat, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHAT_MANAGER_ROLE_ID } from "../store/role-presets.js";
import { withTrace } from "../lib/trace-context.js";
import { classifyError } from "../lib/error-classifier.js";
import { recomputeCost, type CostRecompute, type ModelUsageEntry } from "../lib/cost-pricing.js";
import { recordLlmCost } from "../lib/record-llm-cost.js";

const log = getLogger("execution");

/** Per-session cache: if the user approves sandbox bypass once for a Role, skip the prompt for subsequent tasks. */
const sandboxBypassApproved = new Set<string>();

// ---------------------------------------------------------------------------
// Task 6-impl: Endpoint concurrency semaphore + hard per-request timeout.
//
// Module-level async semaphore caps simultaneous model-endpoint requests to
// `execution.maxEndpointConcurrency` (default 3). Each call to execute()
// acquires the semaphore before calling query() and releases it in a finally.
//
// Semaphore is module-level so it is shared across all ExecutionManager
// instances (ExecutionPool creates one instance per slot, but a single Adam
// process is one module context).
// ---------------------------------------------------------------------------

class AsyncSemaphore {
  private _capacity: number;
  private _available: number;
  private _queue: Array<() => void> = [];

  constructor(capacity: number) {
    this._capacity = capacity;
    this._available = capacity;
  }

  get capacity(): number { return this._capacity; }

  async acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._available++;
    }
  }

  /** Reset to a new capacity (for tests). */
  _resetForTests(capacity: number): void {
    this._capacity = capacity;
    this._available = capacity;
    this._queue = [];
  }
}

/** Process-wide semaphore bounding simultaneous model-endpoint requests.
 *  Size is read from config at first acquire; capacity stored as the module-level default. */
let _endpointSemaphore: AsyncSemaphore | null = null;

/** Get (or lazily create) the endpoint semaphore at the configured capacity. */
function getEndpointSemaphore(capacity: number): AsyncSemaphore {
  if (!_endpointSemaphore) {
    _endpointSemaphore = new AsyncSemaphore(capacity);
  }
  return _endpointSemaphore;
}

/** Exported for tests: reset the semaphore to a new capacity. */
export function _resetEndpointSemaphoreForTests(capacity: number): void {
  if (_endpointSemaphore) {
    _endpointSemaphore._resetForTests(capacity);
  } else {
    _endpointSemaphore = new AsyncSemaphore(capacity);
  }
}

// ---------------------------------------------------------------------------
// SDK transcript persistence (Task 4-impl)
// ---------------------------------------------------------------------------

/** Resolve the per-task SDK transcript dir per-call so ADAM_TEST_DIR isolation works
 *  (matches the `process.env.ADAM_TEST_DIR ?? RUNTIME_DIR` convention used across the codebase).
 *  Created with mode 0o700 on first use. */
function transcriptDirPath(): string {
  return join(process.env.ADAM_TEST_DIR ?? RUNTIME_DIR, "transcripts");
}
/** Maximum bytes per transcript file (5 MB). */
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
/** Tracks cumulative bytes written per task. -1 means already truncated. */
const transcriptBytesByTask = new Map<string, number>();
/** Tracks files whose mode has been chmod-corrected this process lifetime. */
const transcriptModeUpgraded = new Set<string>();

/**
 * Append an SDK event to the per-task transcript file.
 * Guarded by ADAM_PERSIST_SDK_TRANSCRIPTS=1; drops events silently on any error.
 */
function appendTranscript(taskId: string, event: unknown): void {
  if (process.env.ADAM_PERSIST_SDK_TRANSCRIPTS !== "1") return;
  const current = transcriptBytesByTask.get(taskId) ?? 0;
  if (current === -1) return; // already truncated; skip further events
  const line = JSON.stringify(event) + "\n";
  const lineBytes = Buffer.byteLength(line, "utf8");
  try {
    const transcriptDir = transcriptDirPath();
    mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
    const filePath = join(transcriptDir, `${taskId}.jsonl`);
    // appendFileSync({mode}) only applies on CREATE. Pre-existing files from prior runs
    // may have a looser mode — correct it on first touch this process.
    if (!transcriptModeUpgraded.has(filePath)) {
      try {
        if (existsSync(filePath)) chmodSync(filePath, 0o600);
      } catch { /* chmod failure does not block append */ }
      transcriptModeUpgraded.add(filePath);
    }
    if (current + lineBytes > MAX_TRANSCRIPT_BYTES) {
      appendFileSync(filePath, JSON.stringify({ type: "truncated", reason: "size_cap" }) + "\n", { mode: 0o600 });
      transcriptBytesByTask.set(taskId, -1);
      log.warn({ taskId, bytes: current }, "transcript size cap reached, future events dropped");
      return;
    }
    appendFileSync(filePath, line, { mode: 0o600 });
    transcriptBytesByTask.set(taskId, current + lineBytes);
  } catch (err) {
    log.warn({ taskId, error: err }, "transcript append failed");
  }
}

/**
 * Request sandbox bypass approval when no OS sandbox is available.
 * Reuses the plan_approval_request event with a synthetic single-step ExecutionPlan.
 * Returns true if approved, false if denied or timed out.
 */
async function requestSandboxBypass(taskId: string, roleName?: string): Promise<boolean> {
  // Check per-session cache
  if (roleName && sandboxBypassApproved.has(roleName)) {
    log.info({ taskId, roleName }, "Sandbox bypass: approved from session cache");
    return true;
  }

  const operationId = uuidv4();

  // Synthetic single-step plan with high risk level
  const plan: ExecutionPlan = {
    steps: [{
      index: 0,
      description: "Execute task without OS sandbox — filesystem isolation not enforced",
      toolsNeeded: [],
      expectedOutput: "Task result or denial message",
      riskLevel: "high",
    }],
    requiredPermissions: {
      allowedTools: [],
      disallowedTools: [],
      approvalRequired: [],
      maxBudgetUsd: 0,
      plugins: [],
    } as EffectivePermissions,
    overallRisk: "high",
  };

  createTaskPlan({
    id: operationId,
    taskId,
    plan,
    status: "pending",
    createdAt: Date.now(),
  });

  serverBus.emit({
    type: "plan_approval_request",
    taskId,
    planId: operationId,
    plan,
  });

  log.info({ taskId, operationId, roleName }, "Sandbox unavailable: awaiting privilege escalation decision");

  return new Promise<boolean>((resolve) => {
    const TIMEOUT_MS = 120_000; // 2 minutes

    const timer = setTimeout(() => {
      cleanup();
      updateTaskPlanStatus(operationId, "denied");
      log.warn({ taskId, operationId }, "Sandbox bypass timed out, auto-denied");
      resolve(false);
    }, TIMEOUT_MS);

    const handler = (event: { planId: string; decision: string; approvalType?: string; reason?: string }) => {
      if (event.planId !== operationId) return;
      cleanup();
      if (event.decision === "allow") {
        log.info({ taskId, operationId }, "Sandbox bypass approved by user");
        if (roleName) sandboxBypassApproved.add(roleName);
        resolve(true);
      } else {
        log.info({ taskId, operationId }, "Sandbox bypass denied by user");
        resolve(false);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      serverBus.off("plan_approval_decision", handler);
    };

    serverBus.on("plan_approval_decision", handler);
  });
}

export interface ExecutionResult {
  taskId: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  result?: string;
  error?: string;
  costUsd?: number;
  tokenUsage?: TokenUsage;
  numTurns?: number;
  durationMs?: number;
}

function isAuthoritativeTerminalStatus(status: Task["status"] | undefined): status is ExecutionResult["status"] {
  return status === "completed" || status === "failed" || status === "blocked" || status === "cancelled";
}

function executionResultFromTerminalTask(task: Task, durationMs: number, fallbackError?: string): ExecutionResult {
  return {
    taskId: task.id,
    status: task.status as ExecutionResult["status"],
    result: task.result,
    error: task.error ?? fallbackError,
    costUsd: task.costUsd,
    tokenUsage: task.tokenUsage,
    numTurns: task.numTurns,
    durationMs: task.totalDurationMs ?? durationMs,
  };
}

// ---------------------------------------------------------------------------
// Workspace snapshot helpers (Task 4 — snapshot hooks)
// ---------------------------------------------------------------------------
// Both writes route through `updateContextMeta` (store/tasks.ts) so sibling keys
// (usedMemoryIds + any future additions) are preserved and concurrent callers
// (e.g. hooks.ts:appendUsedMemoryIds racing on the same task) cannot lose updates.

/** Merge-write startSnapshot into context_meta without clobbering sibling keys. */
function writeStartSnapshot(taskId: string, serialized: SnapshotTuple[]): void {
  updateContextMeta(taskId, (parsed) => {
    parsed.startSnapshot = serialized;
  });
}

/** Remove startSnapshot key from context_meta, preserving all sibling keys. */
function clearStartSnapshot(taskId: string): void {
  updateContextMeta(taskId, (parsed) => {
    delete parsed.startSnapshot;
  });
}

export class ExecutionManager {
  /**
   * Execute a single task. Creates a fresh SDK query(), runs to completion,
   * updates task record, and emits events.
   */
  async execute(task: Task, abortSignal?: AbortSignal): Promise<ExecutionResult> {
    const startTime = Date.now();
    let tokenUsage: TokenUsage | undefined;
    let costUsd: number | undefined;
    let costBreakdown: CostRecompute | undefined;
    let numTurns: number | undefined;
    // Workspace snapshot: declared at function scope so both start (after sandbox gate)
    // and end (in finally) can access the same Map without re-parsing context_meta.
    let startSnap: Map<string, SnapshotEntry> | null = null;
    // roleCwd also at function scope so the finally block (snapshot diff) can access it.
    let roleCwd = RUNTIME_DIR;

    // Local abort controller for T6: report_blocked tool can break the SDK loop
    const localAbort = new AbortController();

    // Update task status to running
    updateTask(task.id, { status: "running", startedAt: Date.now() });
    serverBus.emit({ type: "task_status_change", taskId: task.id, oldStatus: task.status, newStatus: "running" });

    log.info({ taskId: task.id, roleId: task.roleId }, "ExecutionManager: starting task");

    try {
      // D-006 + D-007: Read execution permissions from frozen executionProfile.
      // D-008: Lazy backfill for legacy tasks without executionProfile.
      let executionProfile: Role | undefined = task.config.executionProfile;

      if (!executionProfile) {
        // D-008: Legacy task — backfill snapshot from live role and persist
        const liveRole = task.roleId ? getRole(task.roleId) : undefined;
        if (liveRole) {
          log.info({ taskId: task.id, roleId: task.roleId }, "Lazy-backfilled executionProfile from live Role");
          executionProfile = liveRole;
          // Write the snapshot back to the task record so future executions use the snapshot
          const updatedTask = getTask(task.id);
          if (updatedTask) {
            updateTask(task.id, {
              config: {
                ...updatedTask.config,
                executionProfile: liveRole,
              },
            });
          }
        }
      }

      // D-007: Use executionProfile (frozen snapshot) workspace for cwd — never live role
      // (roleCwd declared at function scope above so finally block can also access it)
      if (executionProfile) {
        ensureRoleWorkspace(executionProfile);
        roleCwd = getRoleWorkspacePath(executionProfile.name);
        // Phase 4: register with workspace-watcher for mtime heartbeat.
        // Guarded by executionProfile so chat-only tasks (cwd=RUNTIME_DIR) are excluded.
        try { registerTask(task.id, roleCwd); } catch (err) { log.warn({ taskId: task.id, err }, "workspace-watcher registerTask failed (continuing)"); }
      }

      // Build system prompt — read persona from frozen snapshot only (D-006: zero live role reads)
      const promptContext = {
        taskId: task.id,
        prompt: task.prompt,
        roleName: executionProfile?.name,
        roleCagPrompt: executionProfile?.cagPrompt,
        allowedTools: executionProfile?.allowedTools,
        cwd: roleCwd,
        templateExecutionStep: task.parentId && task.stepId
          ? { executionId: task.parentId, stepId: task.stepId }
          : undefined,
      };
      const systemPromptParts = buildExecutionSystemPromptParts(promptContext);

      // Build hooks (audit logging + memory extraction, scoped to task's roleId)
      const hooks = buildSessionHooks({ currentTaskId: task.id, roleId: task.roleId, taskPrompt: task.prompt, stepKind: task.config.stepKind });

      // 2026-05-28 Phase: inject contractRules verifier hooks for template execution steps
      // Does NOT change buildSessionHooks signature (chat-manager also calls it).
      // Non-template tasks (no parentId+stepId+templateId) naturally skip this.
      if (task.parentId && task.stepId && task.templateId) {
        const template = getTaskTemplate(task.templateId);
        const step = template?.steps?.find((s) => s.id === task.stepId);
        // v90 Gap 1: ledger steps (settlesPredictionsFor / publishesClaimsTo)
        // get an auto-derived `format=jsonArray` rule, plus a dedup of the
        // legacy `format=json` rule that would otherwise coexist and
        // double-evaluate. Non-ledger steps get the original behavior
        // (resolveContractRules passthrough, untouched).
        const isLedgerStep = !!(step && (step.settlesPredictionsFor || step.publishesClaimsTo));
        const baseRules = step ? resolveContractRules(step) : [];
        const baseRulesDeduped = isLedgerStep
          ? baseRules.filter((r) => !(r.kind === 'format' && r.value === 'json'))
          : baseRules;
        const rulesRaw = isLedgerStep
          ? [...baseRulesDeduped, ...deriveLedgerShapeRules(step)]
          : baseRulesDeduped;
        if (Array.isArray(rulesRaw) && rulesRaw.length > 0) {
          // ContractRuleSchema is already z.array(...), no extra .array() wrapper needed (M2 fix)
          const parsed = ContractRuleSchema.safeParse(rulesRaw);
          if (parsed.success) {
            const trackARules = parsed.data.filter(isTrackA);
            if (trackARules.length > 0) {
              const trackAHook = buildTrackAHook(trackARules, {
                auditWriter: buildAuditWriter('A'),
                stepLogWriter: buildStepLogWriter(),
                taskId: task.id,
                roleId: task.roleId ?? '__unknown__',
                executionId: task.parentId,
                stepId: task.stepId,
                // v90 Gap 1: key-scope the jsonArray rule to the step's
                // outputAs artifact key (the ledger deliverable).
                outputAs: step?.outputAs,
              });
              // DP-002 Option A: append to existing PreToolUse entry.hooks array
              if (hooks.PreToolUse?.[0]?.hooks) {
                hooks.PreToolUse[0].hooks.push(trackAHook);
              }
            }

            // Track B: ALL file-on-disk rules (fileSizeBytes + audioDurationMs + audioZeroCrossingRatePerS).
            // Wired atomically with the REAL analyzeAudioFile below — never the zero-stub, which would make
            // any audioDurationMs.min>0 fail and unlink real audio (the prior M3-fix hazard).
            const trackBRules = parsed.data.filter((r) => !isTrackA(r));
            if (trackBRules.length > 0) {
              const trackBHook = buildTrackBHook(trackBRules, {
                auditWriter: buildAuditWriter('B'),
                stepLogWriter: buildStepLogWriter(),
                audioAnalyzer: analyzeAudioFile,
                statFn: (p) => stat(p),
                unlinkFn: (p) => unlink(p),
                readTextFn: (p) => readFile(p, "utf8"),
                getSubagentSessionId: () => undefined, // legacy — no session resume (DP-001 Option A)
                taskId: task.id,
                roleId: task.roleId ?? '__unknown__',
                executionId: task.parentId,
                stepId: task.stepId,
              });
              if (hooks.PostToolUse?.[0]?.hooks) {
                hooks.PostToolUse[0].hooks.push(trackBHook);
              }
            }
          } else {
            log.warn({ taskId: task.id, issues: parsed.error.issues }, 'execution-manager: contractRules schema parse failed, skipping hook injection');
          }
        }
      }

      // D-007: Build requestApproval closure for privilege escalation
      const approvalTimeout = task.config.approvalTimeout ?? 300;

      // Historical naming: "plan_approval_request" event and "task_plans" table date from the
      // original PAERL Plan-first design (governance crystal D-009). In Pure C architecture,
      // this is actually a tool operation privilege escalation request. Event name preserved
      // because downstream listeners (WebSocket, PlanApprovalDialog, PlanApprovalBanner,
      // Channel approval handler, DeliveryEngine) are all wired to this name.
      const requestApproval = async (
        toolName: string,
        input: Record<string, unknown>,
        matchedPattern: string,
        agentID?: string,
      ): Promise<PermissionResult> => {
        const operationId = uuidv4();

        // D-007: Check permanent approval rules first
        // findMatchingRule signature: (roleId, prompt, riskLevel)
        const matchingRule = findMatchingRule(agentID ?? task.roleId, task.prompt, "medium");
        if (matchingRule) {
          log.info({ operationId, ruleId: matchingRule.id, taskId: task.id }, "Auto-approved by permanent rule");
          return { behavior: "allow", updatedInput: input };
        }

        // Create operation record (reuses task_plans table; "plan" is historical naming)
        const plan: ExecutionPlan = {
          steps: [{
            index: 0,
            description: `${toolName}: ${JSON.stringify(input).slice(0, 300)}`,
            toolsNeeded: [toolName],
            expectedOutput: "",
            riskLevel: "medium",
          }],
          requiredPermissions: {} as EffectivePermissions,
          overallRisk: "medium",
        };
        createTaskPlan({
          id: operationId,
          taskId: task.id,
          roleId: agentID ?? task.roleId,
          plan,
          status: "pending",
          createdAt: Date.now(),
        });

        // Emit privilege escalation request
        serverBus.emit({
          type: "plan_approval_request",
          taskId: task.id,
          planId: operationId,
          plan,
        });

        log.info({ taskId: task.id, operationId, toolName, matchedPattern }, "Privilege escalation: awaiting user decision");

        // Await user decision with timeout
        return new Promise<PermissionResult>((resolve) => {
          const timer = setTimeout(() => {
            cleanup();
            updateTaskPlanStatus(operationId, "denied");
            log.warn({ taskId: task.id, operationId }, "Privilege escalation timed out, auto-denied");
            resolve({ behavior: "deny", message: `Operation timed out after ${approvalTimeout}s. Auto-denied. Try a safer alternative that does not require approval.` });
          }, approvalTimeout * 1000);

          const handler = (event: { planId: string; decision: string; approvalType?: string; reason?: string }) => {
            if (event.planId !== operationId) return;
            cleanup();
            if (event.decision === "allow") {
              log.info({ taskId: task.id, operationId, approvalType: event.approvalType }, "Operation authorized by user");
              resolve({ behavior: "allow", updatedInput: input });
            } else {
              // D-016: deny-and-continue. The denial message (with optional reason) is returned
              // to the LLM as the tool result. The LLM can then try a safer alternative approach.
              // interrupt is NOT set, so the LLM continues execution with the denial as context.
              const denyMsg = event.reason
                ? `Operation denied by user: ${event.reason}. Try a safer alternative.`
                : "Operation denied by user. Try a safer alternative approach.";
              log.info({ taskId: task.id, operationId, reason: event.reason ?? "no reason given" }, "Operation denied by user");
              resolve({ behavior: "deny", message: denyMsg });
            }
          };

          const cleanup = () => {
            clearTimeout(timer);
            serverBus.off("plan_approval_decision", handler);
          };

          serverBus.on("plan_approval_decision", handler);
        });
      };

      // Load global deniedReadPaths from config (Settings/Advanced)
      const rawDeniedReadPaths = (getConfigValue("defaults.deniedReadPaths") as string[] | undefined) ?? [];
      const resolvedDeniedReadPaths = rawDeniedReadPaths.map((p: string) => {
        const tildeResolved = resolveTilde(p);
        try { return realpathSync(tildeResolved); } catch { return tildeResolved; }
      });

      // D-007: Use executionProfile (frozen) for all permission fields — no live role fallback
      const profileForPerms = executionProfile;
      const addDirs: AdditionalDirectory[] = profileForPerms?.additionalDirectories ?? [];
      const taskPluginPaths: string[] = profileForPerms ? resolveRolePluginPaths(profileForPerms) : [];

      // additionalDirectories: SDK concept — equivalent to Claude Code's --add-dir.
      // These directories inherit MCP/plugin/permission configs (controlled by
      // AdditionalDirectory.inheritPlugins/inheritMcp/inheritPermissions).
      // NOT working directories — CWD is roleCwd (~/.adam/roles/{name}/).
      // Together with cwd, these define the CLI's "in-scope" boundary for path checking.
      // workspacePath has no UI entry — users configure extra directories via additionalDirectories.
      // Plugin install paths (resolved via Role-Plugin binding above) must enter the SDK's
      // path scope so the SDK does not emit `blockedPath` for Bash/Read against scripts inside
      // the bound plugin's directory. The `plugins:` SDK option below (line ~519) is for
      // plugin definition discovery only — per the official Claude Agent SDK docs, plugin
      // loading and filesystem access scope are independent concerns.
      // Mirror change at visiblePaths (sandbox) below; mode is `ro` there because Role does
      // not need to write to plugin dirs.
      const additionalDirPaths: string[] = [
        ...(addDirs.map((d) => d.path)),
        ...taskPluginPaths,
      ].filter((p, i, arr) => arr.indexOf(p) === i);

      // Build canUseTool: blockedPath + deniedReadPaths + 3-tier permission handler (D-015/D-016) + privilege escalation (D-001/D-002) + pinned-param injection (Phase 3)
      const canUseTool = buildCanUseTool(
        (_roleId: string) => ({
          allowedTools: profileForPerms?.allowedTools,
          disallowedTools: profileForPerms?.disallowedTools,
          approvalRequired: profileForPerms?.approvalRequired ?? task.config.approvalRequired,
          allowedBashPatterns: profileForPerms?.allowedBashPatterns,
          deniedBashPatterns: profileForPerms?.deniedBashPatterns,
        }),
        requestApproval,
        {
          deniedReadPaths: resolvedDeniedReadPaths,
          roleScope: [roleCwd, ...additionalDirPaths],
          pinnedParameters: profileForPerms?.learnedRules?.pinnedParameters ?? [],
        },
      );

      // SDK env overrides: global defaults.env + ANTHROPIC_* + role envVars + task env + DISABLE_* flags
      const sdkEnv = buildSdkEnv({
        roleEnvVars: profileForPerms?.envVars,
        taskEnv: task.config.env,
      });

      // Use task config budget or default
      const maxBudget = task.config.maxBudgetUsd ?? getRuntimeConfig().defaults.maxBudgetUsd;
      const maxTurns = task.config.maxTurns ?? 400;

      // D-002 + D-003 + D-S01 (Phase 3): Merge extension binding MCP + task MCP + preset Role MCP + execution-tools.
      // Legacy roleMcpServers (read from profileForPerms.mcpServers / roles.mcp_servers column) was removed
      // in Phase 3 — extensionBindingMcp now provides Role-level MCP via the role_extensions binding table.
      const executionToolsInstance = createExecutionTools(task.roleId ?? "", task.id, () => localAbort.abort());
      const extensionBindingMcp: ExtensionMcpMap = await resolveExtensionsForTask(task, { HOME: sdkEnv?.HOME ?? process.env.HOME ?? "" });
      const taskMcpServers = (task.config.mcpServers ?? {}) as Record<string, McpServerConfig>;
      const presetRoleMcpServers = profileForPerms
        ? getSdkMcpServersForRole(profileForPerms)
        : {};
      const mcpServers: Record<string, McpServerConfig> = {
        ...extensionBindingMcp,
        ...taskMcpServers,
        ...presetRoleMcpServers,
        [EXECUTION_TOOLS_MCP_NAME]: executionToolsInstance,
      };

      // Phase 3: snapshot the resolved extension MCP into task.config so in-flight binding edits don't affect this task.
      if (Object.keys(extensionBindingMcp).length > 0) {
        try {
          updateTaskConfig(task.id, { extensionsSnapshot: extensionBindingMcp });
        } catch (err) {
          log.warn({ err, taskId: task.id }, "Phase 3: failed to write extensionsSnapshot — continuing without persisted snapshot");
        }
      }

      // visiblePaths: sandbox concept — OS-level write whitelist + read blacklist.
      // Write: only visiblePaths with mode="rw" are writable (SBPL allow file-write*).
      // Read: deniedReadPaths are blocked (SBPL deny file-read-data, macOS only).
      // Only the Role's own workspace is writable. ~/.adam/ is NOT included for non-CM roles
      // (contains adam.db, .env, other role workspaces — sensitive data).
      const visiblePaths: VisiblePath[] = [
        { path: roleCwd, mode: "rw" },
      ];

      // ChatManager needs ~/.adam/ access for config and DB operations
      if (task.roleId === CHAT_MANAGER_ROLE_ID) {
        visiblePaths.push({ path: RUNTIME_DIR, mode: "ro" });
      }

      for (const dir of addDirs) {
        visiblePaths.push({ path: dir.path, mode: dir.mode ?? "rw" });
      }

      // Plugin install paths get read-only sandbox access so the Role can execute scripts
      // inside the bound plugin's directory (matches additionalDirPaths above). Mode is
      // forced to `ro` regardless of any addDirs collision — Role must not be able to
      // overwrite plugin scripts (supply-chain integrity).
      for (const pluginPath of taskPluginPaths) {
        visiblePaths.push({ path: pluginPath, mode: "ro" });
      }

      // Sandbox gate: when no OS sandbox is available, require privilege escalation before query()
      const sandbox = getSandboxProvider();

      if (sandbox.platform === "none") {
        // Reuse plan_approval_request event with synthetic single-step plan
        const approved = await requestSandboxBypass(task.id, executionProfile?.name);
        if (!approved) {
          updateTask(task.id, { status: "failed", error: "Sandbox unavailable; execution denied by user" });
          return { taskId: task.id, status: "failed", error: "Sandbox bypass denied" };
        }
      }

      // Workspace snapshot — start (Task 4 plan: after sandbox gate, before SDK query).
      // executionProfile guard ensures chat-only tasks (roleCwd=RUNTIME_DIR) are excluded.
      if (executionProfile) {
        try {
          startSnap = await snapshot(roleCwd);
          const serialized = serializeTuples(startSnap);
          writeStartSnapshot(task.id, serialized);
        } catch (err) {
          log.warn({ taskId: task.id, err }, "execution-manager: start snapshot failed (non-fatal)");
        }
      }

      // T6: Bridge external slot abort to local; handle pre-aborted race
      if (abortSignal) {
        if (abortSignal.aborted) {
          localAbort.abort();
        } else {
          abortSignal.addEventListener("abort", () => localAbort.abort());
        }
      }

      const runQuery = async (): Promise<ExecutionResult> => {
      // Task 6-impl: Acquire endpoint semaphore before making the model request.
      // Reads maxEndpointConcurrency from config; defaults to 3 if unset.
      const maxConcurrency = (getConfigValue("execution.maxEndpointConcurrency") as number | null) ?? 3;
      const semaphore = getEndpointSemaphore(maxConcurrency);
      await semaphore.acquire();

      // Hard per-request timeout (distinct from the inactivity window): fires localAbort.abort()
      // when the entire request exceeds the ceiling. Must be cleared on ALL exits (success/error/abort)
      // in the finally block — per project_adam_inactivity_loop_timer_leak.
      //
      // Breadcrumb (#287): this ceiling is what kills a podcast 口播/定稿 step when the LLM thrashes —
      // rebuilding the full multi-KB script inline via repeated shell writes (cat→python→rm→printf),
      // re-emitting the whole body each time. Measured exec ecf7bd75 (2026-06-06): attempt 1 burned the
      // full timeout (exactly task.config.timeout s) then was retried (template-executor maxRetries=2) and
      // succeeded in ~3min. This is a CORRECT kill of a runaway, not a false-kill of healthy long output:
      // the model never hangs (so the 180s inactivity gate rightly doesn't fire) — it streams a slow thrash.
      // Decision: not fixing the model behavior (treated as attempt-level variance + retry rescue). The
      // cheap lever if the tail starts hurting is a TIGHTER PER-STEP timeout on the mechanical 口播 step
      // (~360s) to bound the blast radius, not a higher global ceiling. See #287.
      const taskTimeoutForHard = task.config.timeout ?? 600;
      const hardTimeoutMs = (getConfigValue("execution.requestHardTimeoutMs") as number | null) ?? (taskTimeoutForHard * 1000);
      let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
      hardTimeoutHandle = setTimeout(() => {
        log.warn({ taskId: task.id, hardTimeoutMs }, "ExecutionManager: per-request hard timeout — aborting");
        localAbort.abort();
      }, hardTimeoutMs);

      // Stderr buffer shared between spawnClaudeCodeProcess callback and the catch block below
      const STDERR_CAP_BYTES = 4 * 1024;
      let processStderr = "";

      const pm = profileForPerms?.permissionMode ?? "default";
      const resolvedModel = resolveTierModel(task.config, profileForPerms);
      // #114: combine admin disallowedTools with the external OAuth MCP deny-glob so
      // dontAsk/bypassPermissions roles (which skip canUseTool entirely) still default-deny
      // Claude.ai OAuth integrations (Gmail/Notion/Drive) at the SDK layer. The helper
      // returns [] when the role has opted into any OAuth tool, so opted-in roles never
      // get an allowed+disallowed conflict.
      const effectiveDisallowedTools = [
        ...(profileForPerms?.disallowedTools ?? []),
        ...externalOAuthDenyGlobs(profileForPerms?.allowedTools),
      ];
      const q = query({
        prompt: task.prompt,
        options: {
          abortController: localAbort,
          cwd: roleCwd,
          additionalDirectories: additionalDirPaths,
          systemPrompt: systemPromptParts,
          maxTurns,
          maxBudgetUsd: maxBudget,
          // SDK options.allowedTools: when the role has a non-empty allowlist, augment it
          // with glob patterns for every SYSTEM_MCP_PREFIXES namespace. This protects
          // dontAsk-mode roles from blocking Adam-injected MCPs at the SDK layer (the
          // SDK denies anything not in this list BEFORE canUseTool fires when permissionMode
          // is dontAsk; see KB entry 2026-03-15-claude-agent-sdk-permissionmode-canuse.md).
          // Empty/undefined allowedTools = no allowlist → no augmentation needed.
          allowedTools: profileForPerms?.allowedTools?.length
            ? [
                ...profileForPerms.allowedTools,
                ...Array.from(SYSTEM_MCP_PREFIXES).map((p) => `${p}*`),
              ]
            : profileForPerms?.allowedTools,
          // Pass disallowedTools to the SDK so permissionMode: "dontAsk" and
          // "bypassPermissions" (which skip canUseTool entirely) still honor admin
          // per-tool blocks. Without this, the SYSTEM_MCP_PREFIXES glob augmentation
          // above would silently auto-approve tools the admin explicitly disallowed
          // when those modes are active. KB: 2026-03-15-claude-agent-sdk-permissionmode-canuse.md
          // (effectiveDisallowedTools is computed just above the query() call)
          ...(effectiveDisallowedTools.length
            ? { disallowedTools: effectiveDisallowedTools }
            : {}),
          ...(profileForPerms?.skills ? { skills: profileForPerms.skills } : {}),
          persistSession: false,
          // Stream partial messages so long-form generation (Chinese podcast scripts,
          // extended thinking) resets the 30s INACTIVITY_MS timer each token —
          // otherwise the SDK accumulates the whole response then emits one event,
          // and force-close fires mid-generation. Observed 2026-05-17 on every
          // step writing 2500+ char Chinese content.
          includePartialMessages: true,
          model: resolvedModel.model,
          ...(resolvedModel.fallbackModel ? { fallbackModel: resolvedModel.fallbackModel } : {}),
          mcpServers,
          settingSources: profileForPerms?.inheritUserSettings ? ["project", "user"] : ["project"],
          hooks,
          canUseTool,
          env: sdkEnv,
          plugins: taskPluginPaths.map((path) => ({ type: "local" as const, path })),
          permissionMode: pm,
          ...(pm === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
          spawnClaudeCodeProcess: (sdkSpawnOpts) => {
            const child = sandbox.spawn({
              command: sdkSpawnOpts.command,
              args: sdkSpawnOpts.args,
              cwd: sdkSpawnOpts.cwd,
              env: sdkSpawnOpts.env,
              signal: sdkSpawnOpts.signal,
              visiblePaths,
              deniedReadPaths: resolvedDeniedReadPaths,
              osCapabilities: profileForPerms?.osCapabilities,
            });

            // Cast to ChildProcess to access stderr and pid
            const childProc = child as unknown as import("node:child_process").ChildProcess;

            // Register PID → roleId mapping for OS-level violation correlation
            if (childProc.pid) {
              registerTaskPid(childProc.pid, task.roleId ?? "unknown", task.id);
              log.info({ pid: childProc.pid, taskId: task.id, roleId: task.roleId ?? "unknown" }, "spawn: pid registered");
              childProc.on("exit", () => unregisterTaskPid(childProc.pid!));
            }

            // Monitor stderr from the child process.
            // All stderr is captured in a single bounded buffer (4 KB cap).
            // Sandbox vs SDK errors are distinguished by content inspection.
            childProc.stderr?.on("data", (chunk: Buffer) => {
              const remaining = STDERR_CAP_BYTES - processStderr.length;
              if (remaining <= 0) return;
              const text = chunk.toString("utf8");
              processStderr += text.length > remaining ? text.slice(0, remaining) + "\n…(truncated)" : text;
            });
            childProc.on("exit", (code) => {
              if (code === null || code === 0) return;

              // Branch 1: sandbox wrapper failure (existing path)
              if (processStderr.includes("sandbox")) {
                log.error(
                  { taskId: task.id, roleId: task.roleId, exitCode: code, stderr: processStderr.slice(0, 500) },
                  "Sandbox wrapper failed — task process exited before execution",
                );
                reportViolation({
                  roleId: task.roleId ?? "unknown",
                  taskId: task.id,
                  path: roleCwd,
                  operation: `sandbox_init_failure:exit_${code}`,
                  timestamp: Date.now(),
                });
                return;
              }

              // Branch 2: non-sandbox, non-zero exit — persist stderr to step_logs for diagnostics
              if (processStderr.length === 0) return;

              // Compute next positive index for step_log ordering
              let nextIndex: number;
              try {
                const existingCount = getDb().prepare("SELECT COUNT(*) as n FROM step_logs WHERE task_id = ?").get(task.id) as { n: number };
                nextIndex = (existingCount?.n ?? 0) + 1;
              } catch {
                nextIndex = 100000 + (Date.now() % 100000); // fallback — stays positive
              }

              try {
                createStepLog({
                  id: uuidv4(),
                  taskId: task.id,
                  index: nextIndex,
                  type: "error",
                  content: processStderr,
                  truncated: processStderr.endsWith("…(truncated)"),
                  timestamp: Date.now(),
                });
              } catch (logErr) {
                log.warn({ taskId: task.id, error: logErr }, "Failed to persist stderr to step_logs");
              }
            });

            return child;
          },
          stderr: (data: string) => {
            if (data.trim()) log.debug({ stderr: data.trim().slice(0, 500) }, "ExecutionManager SDK stderr");
          },
        },
      });

      let resultText = "";

      try {
        // Phase 4 G-1: SDK loop force-close safeguard (DP-004 Option B fallback).
        // Fires on inactivity — if no SDK event arrives within INACTIVITY_MS,
        // force-close the iterator. Catches both (a) the a6dedea8 case where
        // result was emitted then SDK hung 15 min before closing, and (b) the
        // pure-hang case where the iterator never emits anything.
        // Inactivity window scales with task.config.timeout but caps at 3 min.
        // (Was 30s — observed 2026-05-17 to force-close mid-generation for
        // opus-4-6 doing extended thinking + writing 2500-char Chinese podcast
        // scripts. Even with includePartialMessages: true the SDK can go silent
        // for >30s during thinking/tool-wait phases. 3 min still bounded against
        // true hangs.)
        const taskTimeoutSec = task.config.timeout ?? 600;
        const INACTIVITY_MS = Math.max(500, Math.min(180_000, (taskTimeoutSec * 1000) / 2));
        let lastEventAt = Date.now();
        let loopTimedOut = false;

        // Phase 3: captured during iteration on the "result" event (post-iteration call throws
        // "ProcessTransport is not ready for writing" — verified by Task 1-impl probe 2026-05-16).
        let phase3McpStatuses: Array<{ name: string; status: string; error?: string }> = [];

        const iterator = q[Symbol.asyncIterator]();
        while (true) {
          const remainingMs = Math.max(0, INACTIVITY_MS - (Date.now() - lastEventAt));
          const racers: Array<Promise<{ done: boolean; value?: unknown; timedOut?: true }>> = [
            iterator.next().then((r) => ({ done: r.done ?? false, value: r.value })),
            new Promise((resolve) =>
              setTimeout(() => resolve({ done: true, timedOut: true }), remainingMs),
            ),
          ];
          const winner = await Promise.race(racers);
          if (winner.timedOut) {
            loopTimedOut = true;
            log.warn(
              { taskId: task.id, inactivityMs: INACTIVITY_MS },
              "ExecutionManager: SDK loop force-closed after inactivity timeout",
            );
            // Abort the underlying SDK request. localAbort is wired into query({ abortController })
            // so this cancels the request and frees the slot promptly.
            localAbort.abort();
            // Best-effort: also signal the iterator to clean up if the generator responds to return().
            void iterator.return?.(undefined).catch(() => {});
            break;
          }
          if (winner.done) break;
          lastEventAt = Date.now();
          const event = winner.value;
          const ev = event as Record<string, unknown>;
          log.debug({ eventType: ev["type"], taskId: task.id }, "ExecutionManager SDK event");
          appendTranscript(task.id, event);

          if (ev["type"] === "result" && typeof ev["result"] === "string") {
            resultText = ev["result"] as string;
          }

          if (ev["type"] === "result") {
            if (typeof ev["num_turns"] === "number") {
              numTurns = ev["num_turns"] as number;
            }
            // Recompute cost from per-model token counts when modelUsage is present.
            // Falls back to SDK total_cost_usd when modelUsage is absent/empty.
            const modelUsageRaw = ev["modelUsage"] as Record<string, ModelUsageEntry> | undefined;
            if (modelUsageRaw && Object.keys(modelUsageRaw).length > 0) {
              const priceTable = getRuntimeConfig().pricing?.models ?? {};
              const sdkTotal = typeof ev["total_cost_usd"] === "number" ? (ev["total_cost_usd"] as number) : undefined;
              const recompute = recomputeCost(modelUsageRaw, priceTable, sdkTotal);
              costUsd = recompute.costUsd;
              costBreakdown = recompute;
              // Derive aggregate token counts from modelUsage (includes cache tokens)
              let sumInput = 0, sumOutput = 0, sumCacheRead = 0, sumCacheCreation = 0;
              for (const entry of Object.values(modelUsageRaw)) {
                sumInput += (entry.inputTokens ?? 0);
                sumOutput += (entry.outputTokens ?? 0);
                sumCacheRead += (entry.cacheReadInputTokens ?? 0);
                sumCacheCreation += (entry.cacheCreationInputTokens ?? 0);
              }
              tokenUsage = { input: sumInput, output: sumOutput, cacheRead: sumCacheRead, cacheCreation: sumCacheCreation };
            } else {
              // Fallback: SDK total_cost_usd and legacy usage fields
              if (typeof ev["total_cost_usd"] === "number") {
                costUsd = ev["total_cost_usd"] as number;
              }
              const resultUsage = ev["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
              if (resultUsage?.input_tokens !== undefined && resultUsage?.output_tokens !== undefined) {
                tokenUsage = { input: resultUsage.input_tokens, output: resultUsage.output_tokens };
              }
            }
            // Phase 3: capture mcpServerStatus on the result event while transport is still live.
            // Post-iteration call throws "ProcessTransport is not ready for writing" (Task 1-impl probe).
            if (Object.keys(extensionBindingMcp).length > 0) {
              try {
                const statuses = await q.mcpServerStatus();
                phase3McpStatuses = statuses.map((s) => ({ name: s.name, status: s.status, error: s.error }));
              } catch (err) {
                log.warn({ err, taskId: task.id }, "Phase 3: mcpServerStatus() on result event failed — extension_health using fallback empty array");
              }
            }
          }

          // Fallback: token_usage events provide incremental token counts during execution
          if (ev["token_usage"]) {
            const usage = ev["token_usage"] as { input_tokens?: number; output_tokens?: number };
            if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
              tokenUsage = { input: usage.input_tokens, output: usage.output_tokens };
            }
          }
        }
        if (loopTimedOut && !resultText) {
          // Task 8: single source of truth — import INACTIVITY_SENTINEL from resolve-contract-rules.
          // The em:780 "after inactivity timeout" log line above is intentionally a separate literal.
          resultText = INACTIVITY_SENTINEL;
        }

        // Phase 3: extension_health upsert + mcp_load_error step_logs (Task 3).
        // Runs after the loop so it doesn't block the hot SDK iteration path.
        // extensionBindingMcp = {} for unbound Roles → loop is a no-op.
        // per-extension semantics (D-007): extension_health.extension_id is PRIMARY KEY —
        // concurrent tasks overwrite each other's "last" record (intended design).
        if (task.roleId && Object.keys(extensionBindingMcp).length > 0) {
          try {
            const db = getDb();
            const bindings = listBindingsByRole(db, task.roleId);
            const bindingByServerName = new Map(bindings.map((b) => [b.generatedServerName, b]));
            const statusByName = new Map(phase3McpStatuses.map((s) => [s.name, s]));

            for (const serverName of Object.keys(extensionBindingMcp)) {
              const binding = bindingByServerName.get(serverName);
              if (!binding) continue;

              const mcpStatus = statusByName.get(serverName);
              const isFailed = mcpStatus?.status === "failed";

              upsertHealth(db, {
                extensionId: binding.extensionId,
                lastRunAt: Date.now(),
                lastStatus: isFailed ? "failure" : "success",
                lastError: isFailed ? (mcpStatus?.error ?? null) : null,
                lastRoleId: task.roleId,
                lastTaskId: task.id,
              });

              if (isFailed) {
                // Write mcp_load_error step_log
                let nextIndex: number;
                try {
                  const existingCount = db.prepare("SELECT COUNT(*) as n FROM step_logs WHERE task_id = ?").get(task.id) as { n: number };
                  nextIndex = (existingCount?.n ?? 0) + 1;
                } catch {
                  nextIndex = 200000 + (Date.now() % 100000);
                }
                const mcpEntry = extensionBindingMcp[serverName];
                const spawnMeta = JSON.stringify({ command: mcpEntry.command, args: mcpEntry.args });
                const content = `MCP server failed to load: ${mcpStatus?.error ?? "(unknown error)"}\nspawn: ${spawnMeta}`.slice(0, 4096);
                try {
                  createStepLog({
                    id: uuidv4(),
                    taskId: task.id,
                    index: nextIndex,
                    type: "mcp_load_error",
                    content,
                    truncated: content.length >= 4096,
                    timestamp: Date.now(),
                  });
                } catch (logErr) {
                  log.warn({ taskId: task.id, serverName, error: logErr }, "Phase 3: failed to write mcp_load_error step_log");
                }
              }
            }

            // Fallback: if mcpServerStatus() errored (phase3McpStatuses empty) but we have
            // stderr heuristic markers, mark all bound extensions as failure.
            if (phase3McpStatuses.length === 0 && processStderr.length > 0) {
              const hasMcpFailureMarker =
                processStderr.includes("MCP server") && processStderr.includes("failed") ||
                processStderr.includes("Failed to initialize");
              if (hasMcpFailureMarker) {
                for (const serverName of Object.keys(extensionBindingMcp)) {
                  const binding = bindingByServerName.get(serverName);
                  if (!binding) continue;
                  upsertHealth(db, {
                    extensionId: binding.extensionId,
                    lastRunAt: Date.now(),
                    lastStatus: "failure",
                    lastError: "(stderr heuristic — mcpServerStatus unavailable)",
                    lastRoleId: task.roleId,
                    lastTaskId: task.id,
                  });
                }
              }
            }
          } catch (healthErr) {
            log.warn({ err: healthErr, taskId: task.id }, "Phase 3: extension_health upsert block failed — continuing");
          }
        }

        // Inactivity timeout is a failure, not a success. Throw here so execution
        // routes into the existing catch block (em:1010) which calls updateTask({status:"failed"}).
        // This prevents the sentinel from ever becoming a completed task result.
        // Must come BEFORE the completed finalization block and BEFORE the
        // authoritative-terminal-status guard — placing it here means the guard can
        // still short-circuit if another owner wrote terminal state during the abort.
        if (loopTimedOut) {
          throw new Error("ExecutionManager: inactivity timeout — request aborted");
        }

        // T6 + inactivity timeout: Guard against races where another owner already
        // wrote a terminal task state before the SDK loop exited.
        const durationMs = Date.now() - startTime;
        const currentAfterLoop = getTask(task.id);
        if (currentAfterLoop && isAuthoritativeTerminalStatus(currentAfterLoop.status)) {
          serverBus.emit({
            type: "task_complete_event",
            taskId: task.id,
            result: currentAfterLoop.result ?? resultText,
            error: currentAfterLoop.error,
          });
          return executionResultFromTerminalTask(currentAfterLoop, durationMs);
        }

        // Update task record (status/result/timestamps only — cost is written via recordLlmCost mirror below)
        updateTask(task.id, {
          status: "completed",
          result: resultText,
          completedAt: Date.now(),
          totalDurationMs: durationMs,
        });

        serverBus.emit({ type: "task_status_change", taskId: task.id, oldStatus: "running", newStatus: "completed" });
        serverBus.emit({ type: "task_complete_event", taskId: task.id, result: resultText });

        // DP-002: record plugin usage with pre-collected list
        if (taskPluginPaths.length > 0) {
          recordTaskPlugins(task.id, taskPluginPaths, task.roleId);
        }

        // Route cost through unified recordLlmCost (single writer for llm_costs + mirror to tasks).
        // When costBreakdown (CostRecompute from modelUsage) is present, use it directly.
        // Fallback path (no modelUsage): build a synthetic non-empty perModel so one llm_costs row
        // is always inserted and tasks.cost_usd is always mirrored (Phase-1 parity).
        {
          const recompute: CostRecompute = costBreakdown ?? {
            costUsd: costUsd ?? 0,
            perModel: [{
              model: "unknown",
              priced: false,
              estimated: false,
              inputTokens: tokenUsage?.input ?? 0,
              outputTokens: tokenUsage?.output ?? 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: costUsd ?? 0,
            }],
            pricingStatus: "unknown",
            unknownModels: ["unknown"],
            sdkTotalCostUsd: costUsd,
          };
          void recordLlmCost({
            source: "task",
            taskId: task.id,
            roleId: task.roleId ?? undefined,
            recompute,
            numTurns,
            mirror: true,
          }).catch((err) => {
            log.warn({ err, taskId: task.id }, "ExecutionManager: recordLlmCost (completed) failed — cost columns may be stale");
          });
        }

        log.info({ taskId: task.id, durationMs, costUsd }, "ExecutionManager: task completed");

        return {
          taskId: task.id,
          status: "completed",
          result: resultText,
          costUsd,
          tokenUsage,
          numTurns,
          durationMs,
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;

        // T6 + inactivity timeout: If another owner wrote terminal state before
        // the SDK abort/error surfaced, respect that state.
        // Detect via task status (authoritative) — SDK abort surfaces as plain Error with
        // message "Claude Code process aborted by user", not AbortError, so name-checking is unreliable.
        const currentInCatch = getTask(task.id);
        if (currentInCatch && isAuthoritativeTerminalStatus(currentInCatch.status)) {
          serverBus.emit({
            type: "task_complete_event",
            taskId: task.id,
            result: currentInCatch.result,
            error: currentInCatch.error ?? errorMessage,
          });
          return executionResultFromTerminalTask(currentInCatch, durationMs, errorMessage);
        }

        // "Prompt is too long" indicates the task prompt itself is too large for the model context.
        // This is unrecoverable without user action (cannot be fixed by retrying with a fresh session).
        // classifyError also handles this case via CONTEXT_OVERFLOW.
        if (errorMessage.includes("Prompt is too long") || errorMessage.includes("prompt is too long")) {
          log.warn({ taskId: task.id, error: errorMessage }, "Task prompt exceeds model context window -- task failed");
        }

        // DP-002: classify error at source for ChatManager routing
        const classified = classifyError(errorMessage);
        // Append stderr excerpt to make the error self-explanatory in API responses
        const stderrExcerpt = processStderr ? `\n--- stderr (last ${STDERR_CAP_BYTES} bytes) ---\n${processStderr}` : "";
        const enrichedMessage = classified.originalError + stderrExcerpt;

        updateTask(task.id, {
          status: "failed",
          error: JSON.stringify({ ...classified, originalError: enrichedMessage }),
          completedAt: Date.now(),
          totalDurationMs: durationMs,
          errorCategory: classified.category,
        });

        serverBus.emit({ type: "task_status_change", taskId: task.id, oldStatus: "running", newStatus: "failed" });
        serverBus.emit({ type: "task_complete_event", taskId: task.id, error: errorMessage });

        // Route cost through unified recordLlmCost (same as completed path).
        {
          const recompute: CostRecompute = costBreakdown ?? {
            costUsd: costUsd ?? 0,
            perModel: [{
              model: "unknown",
              priced: false,
              estimated: false,
              inputTokens: tokenUsage?.input ?? 0,
              outputTokens: tokenUsage?.output ?? 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: costUsd ?? 0,
            }],
            pricingStatus: "unknown",
            unknownModels: ["unknown"],
            sdkTotalCostUsd: costUsd,
          };
          void recordLlmCost({
            source: "task",
            taskId: task.id,
            roleId: task.roleId ?? undefined,
            recompute,
            numTurns,
            mirror: true,
          }).catch((err) => {
            log.warn({ err, taskId: task.id }, "ExecutionManager: recordLlmCost (failed) failed — cost columns may be stale");
          });
        }

        log.error({ taskId: task.id, error: err }, "ExecutionManager: task failed");

        return {
          taskId: task.id,
          status: "failed",
          error: enrichedMessage,
          costUsd,
          tokenUsage,
          numTurns,
          durationMs,
        };
      }
      } finally {
        // Task 6-impl: clear the hard per-request timer on ALL exits (success, error, abort).
        // Per project_adam_inactivity_loop_timer_leak: the existing inactivity racer leaks
        // its loser timer; this new timer MUST be cleared to avoid a second leaking timer.
        if (hardTimeoutHandle !== undefined) clearTimeout(hardTimeoutHandle);
        // Release the endpoint semaphore so the next queued request can proceed.
        semaphore.release();
      }
      }; // end runQuery

      // S6-A: wrap the entire query execution in the task's trace context so step_logs
      // written by hooks (createStepLog) carry the same trace_id.
      const traceId = task.traceId;
      if (traceId) {
        return await withTrace(traceId, "chat", runQuery);
      } else {
        return await runQuery();
      } // end inner dispatch try
    } catch (err) {
      // T6: Outer catch handles setup-phase errors (sandbox bypass, abort bridge)
      const errorMessage = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      log.error({ taskId: task.id, error: err }, "ExecutionManager: setup-phase error");
      return { taskId: task.id, status: "failed", error: errorMessage, durationMs };
    } finally {
      // Workspace snapshot — end (Task 4 plan: diff + insert + clear, BEFORE unregisterTask).
      // Only runs if startSnap was captured (executionProfile tasks that passed the sandbox gate).
      if (startSnap !== null) {
        try {
          const endSnap = await snapshot(roleCwd);
          // startSnap is in-scope and proven non-null by the guard above; no DB fallback needed.
          const d = diff(startSnap, endSnap);
          insertTaskFilesDiff(task.id, d);
          clearStartSnapshot(task.id);
        } catch (err) {
          log.warn({ taskId: task.id, err }, "execution-manager: workspace snapshot diff failed (non-fatal)");
        }
      }
      // Phase 4: workspace-watcher unregister — fires on ALL paths (success, failure, race, setup error).
      // Idempotent via Map.delete so safe even if register never ran.
      try { unregisterTask(task.id); } catch {}
    }
  }
}
