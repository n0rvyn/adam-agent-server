/**
 * Adapter that wraps audit/log store functions into the simplified writer interfaces
 * expected by the Track A/B SDK hook callbacks.
 *
 * Responsibilities:
 * - Supply id (uuidv4), createdAt (Date.now), layer ('A'|'B'), severity (default 'warning')
 * - Supply id, index (0), timestamp, truncated (false) for step_logs rows
 * - Silently swallow DB write failures (log.warn) so hook exceptions don't propagate
 *   to the SDK and cause unintended denial of unrelated tool calls
 */

import type { AuditViolation, StepLog } from '../shared/types.js';
import { recordAuditViolation } from '../store/audit-violations.js';
import { createStepLog } from '../store/logs.js';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../lib/logger.js';

const log = getLogger('audit');

/**
 * Builds a writer function that accepts the hook-layer simplified violation shape
 * (missing id, createdAt, layer, severity) and fills them in before delegating to
 * the durable recordAuditViolation store function.
 *
 * @param layer  'A' for content (PreToolUse) rules, 'B' for file-on-disk (PostToolUse) rules
 */
export function buildAuditWriter(
  layer: 'A' | 'B',
): (v: Omit<AuditViolation, 'id' | 'createdAt' | 'layer' | 'severity'> & { severity?: 'warning' | 'error' }) => void {
  return (v) => {
    try {
      const full: AuditViolation = {
        id: uuidv4(),
        createdAt: Date.now(),
        layer,
        severity: v.severity ?? 'warning',
        stepTaskId: v.stepTaskId,
        roleId: v.roleId,
        contractField: v.contractField,
        message: v.message,
        metadata: v.metadata,
      };
      recordAuditViolation(full);
    } catch (err) {
      // Fail-CLOSED: recordAuditViolation should not throw; swallow and warn
      log.warn({ err, taskId: v.stepTaskId }, 'hook-context-factory: recordAuditViolation failed');
    }
  };
}

/**
 * Builds a writer function that accepts a simplified step_log row (missing id,
 * index, timestamp, truncated) and fills them in before delegating to the durable
 * createStepLog store function.
 */
export function buildStepLogWriter(): (row: { taskId: string; type: string; content: string }) => void {
  return (row) => {
    try {
      const full: StepLog = {
        id: uuidv4(),
        index: 0,
        timestamp: Date.now(),
        truncated: false,
        taskId: row.taskId,
        type: row.type as StepLog['type'],
        content: row.content,
      };
      createStepLog(full);
    } catch (err) {
      log.warn({ err, taskId: row.taskId }, 'hook-context-factory: createStepLog failed');
    }
  };
}
