import { writeEffectReceipt, InvalidReceiptError } from "../store/effect-receipts.js";
import { getCurrentTraceId } from "../lib/trace-context.js";
import { getLogger } from "../lib/logger.js";
import type {
  EffectReceiptFieldChange,
  EffectReceiptScope,
  EffectReceiptActor,
} from "../shared/types.js";

const log = getLogger("adam");

export interface WriteMutationReceiptInput {
  toolName: string;
  entityType: string;
  verb: string;
  entityId?: string;
  entityIds?: string[];
  fieldChanges?: EffectReceiptFieldChange[];
  scope?: EffectReceiptScope;
  taskId?: string;
  sessionId?: string;
  roleId?: string;
  /** Override trace context (e.g. when called from createTaskWithAdmission with an explicit traceId). */
  traceIdOverride?: string;
}

/**
 * Write an entity_mutation receipt. Defensive: no-ops when no trace context is
 * available (e.g. server bootstrap, background tasks without a turn binding) and
 * swallows validation errors so receipt-write failures never break the calling tool.
 *
 * Phase 4 DP-001: success-only. Mutation tools call this once at the success return
 * point; failure paths do not write receipts.
 */
export function writeMutationReceipt(input: WriteMutationReceiptInput): void {
  const traceId = input.traceIdOverride ?? getCurrentTraceId();
  if (!traceId) {
    log.debug(
      { toolName: input.toolName, entityType: input.entityType, verb: input.verb },
      "Mutation receipt skipped: no active trace context",
    );
    return;
  }
  const actor: EffectReceiptActor = {
    traceId,
    toolName: input.toolName,
    taskId: input.taskId,
    roleId: input.roleId,
  };
  try {
    writeEffectReceipt({
      traceId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      effectCategory: "entity_mutation",
      verb: input.verb,
      entityType: input.entityType,
      entityId: input.entityId,
      entityIds: input.entityIds,
      fieldChanges: input.fieldChanges,
      scope: input.scope,
      actor,
      outcome: "success",
    });
  } catch (err) {
    if (err instanceof InvalidReceiptError) {
      log.warn(
        { errors: err.errors, toolName: input.toolName, entityType: input.entityType },
        "Mutation receipt validation failed",
      );
    } else {
      log.warn(
        { error: err instanceof Error ? err.message : String(err), toolName: input.toolName },
        "Mutation receipt write failed",
      );
    }
  }
}
