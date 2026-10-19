/**
 * AuditManager — unified security + quality monitoring sidecar.
 *
 * Absorbs the former Monitor module (score, retirement, diagnostic)
 * and adds sandbox violation monitoring.
 *
 * Public API:
 *   auditManager.start()           — start all watchers + timers
 *   auditManager.stop()            — stop all watchers + timers
 *   auditManager.evaluateTask()    — from monitor.ts: scoring + EMA + retirement/probation
 *   auditManager.reportViolation() — from violation-watcher: sandbox violation
 *   auditManager.getSecurityPosture() — per-Role sandbox status summary
 */

import { recordTaskScore } from "./score.js";
import { evaluateIntentFulfillment } from "./intent-eval.js";
import { updateRoleScoreWithIntent, getLatestRoleScore } from "../store/role-scores.js";
import { getTask, getContextMeta } from "../store/tasks.js";
import { getBelief } from "../store/beliefs.js";
import { applyFitnessUpdate } from "../agent/belief-mechanism.js";
import { serverBus } from "../server/events/server-bus.js";
import { computeWeighted, EMA_ALPHA } from "./score.js";
import { checkRetirement, reinstateAgent, checkProbationGraduation } from "./retirement.js";
import { generateDiagnosticReport } from "./diagnostic.js";
import { startViolationWatcher, reportViolation as handleViolation, getViolationCount, getRecentViolations } from "./violation-watcher.js";
import { getRole, listRoles, updateRole, incrementRoleTaskSeq, getRoleTaskSeq } from "../store/roles.js";
import { getSandboxProvider, isSandboxAvailable } from "../sandbox/provider.js";
import type { SandboxViolationEvent, SandboxPlatform } from "../sandbox/types.js";
import { getLogger } from "../lib/logger.js";
import {
  auditAssistantCommitment as runAssistantCommitmentAudit,
  type AuditAssistantCommitmentArgs,
} from "./commitment-auditor.js";
import {
  auditDeliveryClaims as runDeliveryClaimAudit,
  type AuditDeliveryClaimsArgs,
} from "./delivery-claim-auditor.js";
import type { AssistantCommitmentAuditResult } from "../shared/types.js";
import { getRuntimeConfig } from "../config/runtime.js";
import { checkAndFlipAntiPattern } from "./anti-flip.js";

const log = getLogger("audit");

const DEFAULT_RETIREMENT_THRESHOLD = 0.4;
const DAILY_DIAGNOSTIC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface RolePosture {
  roleId: string;
  roleName: string;
  sandboxed: boolean;
  violationCount: number;
  lastViolation?: number;
}

export interface SecurityPosture {
  platform: SandboxPlatform;
  available: boolean;
  violationCount24h: number;
  rolePostures: RolePosture[];
}

let diagnosticTimerId: ReturnType<typeof setInterval> | null = null;
let stopWatcher: (() => void) | null = null;

/**
 * Evaluate a completed task and update role scores.
 * Called synchronously from main process after task completion.
 */
export async function evaluateTaskCompletion(
  taskId: string,
  roleId: string,
  retirementThreshold = DEFAULT_RETIREMENT_THRESHOLD,
): Promise<void> {
  // Skip inactive/retired/dead roles
  const role = getRole(roleId);
  if (!role || role.status === "retired" || role.status === "inactive" || role.status === "dead") return;

  // Bump role task counter — the monotonic clock that drives belief decay (Task 2-impl)
  incrementRoleTaskSeq(roleId);

  // Read taskType from the task record for per-task-type score attribution
  const task = getTask(taskId);
  const taskType = task?.config?.taskType;

  // 1. Compute and record per-task score + EMA for the role
  const emaScore = recordTaskScore(roleId, taskId, taskType);

  // Write the computed EMA back to the Role's performanceScore field
  updateRole(roleId, { performanceScore: emaScore });

  // 2. Check probation graduation (if role is on probation)
  const graduated = checkProbationGraduation(roleId, emaScore, retirementThreshold);
  if (graduated) {
    log.info({ roleId, emaScore }, "Probation role graduated");
  } else if (emaScore < retirementThreshold) {
    // Retire then immediately reinstate to probation
    const retired = checkRetirement(roleId, emaScore, retirementThreshold);
    if (retired) {
      reinstateAgent(roleId);
    }
  }

  // 3. Belief-level fitness: update success_ema for all injected active beliefs
  try {
    const ctxMeta = getContextMeta(taskId);
    const usedIds = ctxMeta?.usedMemoryIds ?? [];
    const latest = getLatestRoleScore(roleId);
    if (latest && latest.taskId === taskId && usedIds.length > 0) {
      const weighted = latest.scores.weighted;
      const currentSeq = getRoleTaskSeq(roleId); // already incremented by Task 2
      for (const id of usedIds) {
        try {
          const belief = getBelief(id);
          if (belief?.status === "active") {
            applyFitnessUpdate(belief, weighted, currentSeq);
          }
        } catch (err) {
          log.warn({ taskId, roleId, beliefId: id, err }, "Belief fitness update failed — skipping");
        }
      }
      // Anti-flip check on all touched actives (Task 8 handles internal logic)
      const cfg = getRuntimeConfig().memory!;
      checkAndFlipAntiPattern(usedIds, cfg).catch((err: unknown) => {
        log.warn({ taskId, roleId, err }, "Anti-flip check failed");
      });
    }
  } catch (err) {
    log.warn({ taskId, roleId, err: err instanceof Error ? err.message : String(err) }, "Belief attribution failed; continuing");
  }

  // 4. Fire-and-forget intent eval (D-S06: non-blocking)
  // Skip intent-eval for contract-verifier tasks to prevent recursion (DP-007).
  if (taskType !== "contract-verifier") {
    setImmediate(() => {
      evaluateIntentFulfillment(taskId, roleId)
        .then((result) => {
          const newEma = updateRoleScoreWithIntent(
            taskId,
            result.score,
            result.failed,
            computeWeighted,
            EMA_ALPHA,
          );
          if (newEma === undefined) return;

          // Out-of-order safety: only update Role.performanceScore if THIS row is the latest.
          // Without this guard, an older task's late-arriving eval would overwrite a newer task's EMA.
          const latest = getLatestRoleScore(roleId);
          if (latest?.taskId !== taskId) {
            log.debug({ taskId, roleId, latestTaskId: latest?.taskId }, "Intent eval landed for non-latest task; skipping performanceScore update");
            return;
          }
          updateRole(roleId, { performanceScore: newEma });
          log.debug({ taskId, roleId, intentScore: result.score, failed: result.failed, newEma: newEma.toFixed(3) }, "Intent eval applied");
        })
        .catch((err) => {
          log.warn({ taskId, roleId, err: err instanceof Error ? err.message : String(err) }, "Intent eval pipeline error (swallowed)");
        });
    });
  }
}

/**
 * Start AuditManager — initialize all watchers and timers.
 */
export async function startAuditManager(): Promise<void> {
  if (diagnosticTimerId !== null) return;

  // Daily diagnostic reports
  diagnosticTimerId = setInterval(() => {
    log.info("Running daily diagnostic reports");
    const roles = listRoles(undefined, 1000);
    for (const role of roles) {
      if (role.status === "retired" || role.status === "inactive") continue;
      try {
        generateDiagnosticReport(role.id);
      } catch (err) {
        log.error({ roleId: role.id, error: err }, "Daily diagnostic failed");
      }
    }
  }, DAILY_DIAGNOSTIC_INTERVAL_MS);

  // Sandbox violation watcher (async — may await provider.isAvailable())
  stopWatcher = await startViolationWatcher();

  log.info("AuditManager started");
}

/**
 * Stop AuditManager — stop all watchers and timers.
 */
export function stopAuditManager(): void {
  if (diagnosticTimerId !== null) {
    clearInterval(diagnosticTimerId);
    diagnosticTimerId = null;
  }
  if (stopWatcher !== null) {
    stopWatcher();
    stopWatcher = null;
  }
  log.info("AuditManager stopped");
}

/**
 * Report a sandbox violation event.
 */
export function reportViolation(event: SandboxViolationEvent): void {
  handleViolation(event);
}

export function auditAssistantCommitment(args: AuditAssistantCommitmentArgs): AssistantCommitmentAuditResult {
  return runAssistantCommitmentAudit(args);
}

export function auditDeliveryClaims(args: AuditDeliveryClaimsArgs): AssistantCommitmentAuditResult {
  return runDeliveryClaimAudit(args);
}

/**
 * Get current security posture for all roles (async — awaits sandbox availability).
 */
export async function getSecurityPosture(): Promise<SecurityPosture> {
  const sandbox = getSandboxProvider();
  const roles = listRoles(undefined, 1000);

  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;
  const recent = getRecentViolations();
  const violations24h = recent.filter(v => v.timestamp >= cutoff24h).length;

  const rolePostures: RolePosture[] = roles.map(role => {
    const roleViolations = recent.filter(v => v.roleId === role.id);
    const lastV = roleViolations[roleViolations.length - 1];
    return {
      roleId: role.id,
      roleName: role.name,
      sandboxed: sandbox.platform !== "none",
      violationCount: getViolationCount(role.id),
      lastViolation: lastV?.timestamp,
    };
  });

  const available = await isSandboxAvailable();

  return {
    platform: sandbox.platform,
    available,
    violationCount24h: violations24h,
    rolePostures,
  };
}
