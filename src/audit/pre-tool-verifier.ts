/**
 * Track A PreToolUse hook for the SDK orchestrator.
 *
 * Matches `mcp__execution-tools__write_artifact`. Reads `tool_input.value`,
 * applies Track A content rules (lengthTarget / format / requireHeading / mime).
 * On failure: returns `permissionDecision: 'deny'` + structured
 * `permissionDecisionReason` and calls the injected `auditWriter` to preserve
 * the legacy contract-verifier observability signal.
 *
 * Fail-CLOSED: on internal errors the write is denied (not admitted), and a
 * dual durable signal is written — audit_violations + forensic step_log row of
 * type 'validator_internal_error' per Threat Model line 100.
 *
 * Phase 2 — SDK orchestrator content/file verifier rules.
 * Track A = content-checkable from tool_input.value.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { AuditViolation } from '../shared/types.js';
import { isTrackA, type ContractRule } from '../store/contract-rules.js';

export interface TrackAHookCtx {
  auditWriter: (v: Omit<AuditViolation, 'id' | 'createdAt' | 'layer' | 'severity'> & { severity?: 'warning' | 'error' }) => void;
  /**
   * Per Threat Model line 100: internal errors must write a step_logs row of type
   * 'validator_internal_error' for forensic traceability — not just audit_violations.
   */
  stepLogWriter: (row: { taskId: string; type: 'validator_internal_error'; content: string }) => void;
  taskId: string;
  roleId: string;
  executionId: string;
  stepId: string;
  /**
   * v90 (Gap 1 fix): the step's `outputAs` artifact key. When set, the
   * `format=jsonArray` rule is gated to `tool_input.key === outputAs`, so
   * ledger-shape enforcement only applies to the declared ledger artifact —
   * not to scratch / helper / intermediate writes in the same step. Optional
   * (older caller paths may not pass it; in that case the rule is skipped
   * rather than mis-applied to every key).
   */
  outputAs?: string;
}

const WRITE_ARTIFACT_TOOL = 'mcp__execution-tools__write_artifact';

/**
 * Maps a ContractRule kind to the AuditViolation.contractField enum value.
 * Uses the existing enum values (no Phase 2 extension per pre-flight risk note).
 * Phase 5 follow-up: add 'mime' and 'fileContent' enum values for better reverse-attribution.
 */
function contractFieldOf(rule: ContractRule): AuditViolation['contractField'] {
  switch (rule.kind) {
    case 'lengthTarget':
      return 'lengthTarget';
    case 'format':
      return 'format';
    case 'requireHeading':
      return 'format'; // reuses format; Phase 5 will add 'requireHeading' enum value
    case 'mime':
      return 'customAssertions'; // reuses customAssertions; Phase 5 will add 'mime' enum value
    default:
      return 'customAssertions';
  }
}

/**
 * Checks a single Track A rule against a value.
 * Returns null on pass, or an error message string on fail.
 */
function checkTrackARule(rule: ContractRule, value: unknown): string | null {
  switch (rule.kind) {
    case 'lengthTarget': {
      const str = String(value);
      let actual: number;
      if (rule.unit === 'characters') {
        actual = str.length;
      } else if (rule.unit === 'words') {
        actual = str.trim().split(/\s+/).filter((w) => w.length > 0).length;
      } else {
        // bytes
        actual = Buffer.byteLength(str, 'utf8');
      }
      if (actual < rule.min || actual > rule.max) {
        return `lengthTarget — actual ${actual} ${rule.unit} / target ${rule.min}-${rule.max} ${rule.unit}`;
      }
      return null;
    }

    case 'format': {
      if (rule.value === 'markdown') {
        if (typeof value !== 'string') {
          return 'format=markdown declared but value is not a string';
        }
        if (value.trim().length === 0) {
          return 'format=markdown declared but value is empty';
        }
        // format=markdown: string must be non-empty; heading requirement is handled separately
        // by requireHeading rule. Format itself just requires "is a non-empty string".
        return null;
      }
      if (rule.value === 'json') {
        // Object inputs are unconditionally allowed (dominant LLM pattern — passes object directly).
        // Only catches "LLM submitted a non-parseable string claiming to be JSON".
        if (typeof value === 'object' && value !== null) {
          return null;
        }
        try {
          JSON.parse(String(value));
          return null;
        } catch {
          return 'format=json declared but value is not valid JSON';
        }
      }
      if (rule.value === 'jsonArray') {
        // v90 Gap 1 shape gate: the ledger step's outputAs artifact MUST be a
        // JSON array. `[]` is the correct 0-due / 0-publish output — explicit
        // allow (not nudge-loop bait). Object payloads (the morning-show
        // empirical failure mode) are denied with a precise message naming
        // the empty-array escape hatch.
        let parsed: unknown = value;
        if (typeof value === 'string') {
          try {
            parsed = JSON.parse(value);
          } catch {
            return 'format=jsonArray declared but value is not valid JSON';
          }
        }
        if (!Array.isArray(parsed)) {
          return 'format=jsonArray declared but value is not a JSON array (期望 JSON 数组，无内容时用 []) — emit an array of items, not an object';
        }
        return null;
      }
      if (rule.value === 'text') {
        if (typeof value !== 'string') {
          return 'format=text declared but value is not a string';
        }
        return null;
      }
      return null;
    }

    case 'requireHeading': {
      if (!rule.value) {
        // requireHeading=false: no check needed
        return null;
      }
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      if (!/^#{1,6}\s/m.test(str)) {
        return 'requireHeading=true but no markdown heading detected (expected /^#{1,6}\\s/m)';
      }
      return null;
    }

    case 'mime': {
      const declared = rule.declared.toLowerCase();
      if (declared.startsWith('application/json') || declared === 'application/json') {
        // JSON mime: object or parseable JSON string
        if (typeof value === 'object' && value !== null) {
          return null;
        }
        try {
          JSON.parse(String(value));
          return null;
        } catch {
          return `mime=${rule.declared} declared but value is not a JSON object or parseable JSON string`;
        }
      }
      if (declared.startsWith('text/')) {
        // text/* mimes require a string
        if (typeof value !== 'string') {
          return `mime=${rule.declared} declared but value is not a string`;
        }
        return null;
      }
      // For other mime types (including audio/, video/, image/ — though template-write validator
      // rejects those at write time, they should not appear here in production), we perform
      // no content-level check since Track A can only inspect JSON-serializable values.
      return null;
    }

    default:
      // Track B rules (fileSizeBytes, audioZeroCrossingRatePerS, audioDurationMs) are filtered
      // before this function is called via isTrackA(). This default is a safety fallback.
      return null;
  }
}

/**
 * Builds a PreToolUse HookCallback that enforces Track A content rules on
 * `mcp__execution-tools__write_artifact` calls.
 *
 * @param rules - ContractRule array; non-Track-A rules are silently ignored.
 * @param ctx - Injected writers (vitest mocks in tests; production wrappers from hook-context-factory).
 */
export function buildTrackAHook(rules: ContractRule[], ctx: TrackAHookCtx): HookCallback {
  const trackARules = rules.filter(isTrackA);

  return async (input, _toolUseId, _options) => {
    if ((input as { hook_event_name?: string }).hook_event_name !== 'PreToolUse') return {};
    if ((input as PreToolUseHookInput).tool_name !== WRITE_ARTIFACT_TOOL) return {};

    try {
      const toolInput = (input as PreToolUseHookInput).tool_input as { value?: unknown; key?: unknown };
      const value = toolInput.value;
      const key = typeof toolInput.key === 'string' ? toolInput.key : undefined;

      for (const rule of trackARules) {
        // v90 Gap 1: the jsonArray ledger-shape rule is key-scoped to the
        // step's outputAs. Without this guard, ledger steps that write
        // intermediate / scratch artifacts to OTHER keys would have those
        // writes incorrectly constrained. Other rules (lengthTarget, format
        // json/markdown/text, requireHeading, mime) keep their existing
        // un-scoped semantics — this is a deliberately narrow carve-out.
        if (rule.kind === 'format' && rule.value === 'jsonArray') {
          if (!ctx.outputAs || key !== ctx.outputAs) continue;
        }

        const violation = checkTrackARule(rule, value);
        if (violation) {
          ctx.auditWriter({
            stepTaskId: ctx.taskId,
            executionId: ctx.executionId,
            roleId: ctx.roleId,
            contractField: contractFieldOf(rule),
            message: violation,
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Verifier rejected: ${violation}. Please revise and call write_artifact again.`,
            },
          };
        }
      }

      return {};
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Dual durable signal per Threat Model line 100: audit + forensic step_log.
      try {
        ctx.auditWriter({
          stepTaskId: ctx.taskId,
          executionId: ctx.executionId,
          roleId: ctx.roleId,
          contractField: 'customAssertions',
          message: `Internal verifier error: ${errMsg}`,
          severity: 'error' as const,
        });
      } catch {
        // auditWriter itself threw — still fail-closed
      }
      try {
        ctx.stepLogWriter({
          taskId: ctx.taskId,
          type: 'validator_internal_error',
          content: `Track A internal error: ${errMsg}`,
        });
      } catch {
        // stepLogWriter itself threw — still fail-closed
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Verifier internal error — please retry',
        },
      };
    }
  };
}
