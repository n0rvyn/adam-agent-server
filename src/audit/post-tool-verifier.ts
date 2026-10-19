/**
 * Track B PostToolUse hook for the SDK orchestrator.
 *
 * Matches `mcp__execution-tools__publish_artifact_file`. After a file artifact
 * is published, runs file-on-disk checks (fileSizeBytes, audioZeroCrossingRatePerS,
 * audioDurationMs). On failure: unlinks the just-published file (best-effort),
 * writes an audit_violations row, writes a step_logs validator_error row, and
 * calls the onFailure callback so the retry-coordinator can record the event.
 *
 * PostToolUse cannot communicate denial via permissionDecision to the LLM —
 * feedback to the orchestrator LLM is routed via the retry-coordinator's
 * SubagentStart additionalContext injection on the next subagent dispatch.
 *
 * Fail-CLOSED: on internal errors, best-effort unlink is still attempted; the
 * durable audit_violations + step_logs rows serve as the forensic signal.
 *
 * Phase 2 — SDK orchestrator content/file verifier rules.
 * Track B = file-on-disk checks from publish_artifact_file.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AuditViolation } from '../shared/types.js';
import type { ContractRule } from '../store/contract-rules.js';
import { getLogger } from '../lib/logger.js';
import { inferMimeFromPath } from '../manager/execution-tools.js';

const log = getLogger('manager');

const PUBLISH_ARTIFACT_TOOL = 'mcp__execution-tools__publish_artifact_file';

export interface TrackBHookCtx {
  auditWriter: (v: Omit<AuditViolation, 'id' | 'createdAt' | 'layer' | 'severity'> & { severity?: 'warning' | 'error' }) => void;
  stepLogWriter: (row: { taskId: string; type: 'validator_error'; content: string }) => void;
  audioAnalyzer: (filePath: string) => Promise<{ zcRatePerS: number; durationMs: number }>;
  statFn: (filePath: string) => Promise<{ size: number }>;
  unlinkFn: (filePath: string) => Promise<void>;
  /** Reads a published artifact's UTF-8 text content (for textContentForbidden rules). */
  readTextFn: (filePath: string) => Promise<string>;
  /**
   * Returns the resumable sessionId for the agent_id that originated this publish call,
   * or undefined when the orchestrator-runner has not yet forked a session for it.
   * Populated by orchestrator-runner via a SubagentStart hook that calls
   * SDK forkSession(parent_session_id) and stores agent_id → returned sessionId.
   */
  getSubagentSessionId: (agentId: string) => string | undefined;
  /**
   * Called on every Track B failure to record the agent_id → reason → sessionId mapping
   * in the retry-coordinator's internal map. Decoupled callback so the post-tool-verifier
   * does not import the retry-coordinator directly.
   */
  onFailure?: (agentId: string, agentType: string, reason: string, sessionId: string | undefined) => void;
  taskId: string;
  roleId: string;
  executionId: string;
  stepId: string;
}

/**
 * Checks a single Track B rule against file stats / audio analysis results.
 * Returns null on pass, or an error message string on fail.
 */
function checkTrackBRule(
  rule: ContractRule,
  ctx: { size?: number; audio?: { zcRatePerS: number; durationMs: number }; text?: string },
): string | null {
  switch (rule.kind) {
    case 'fileSizeBytes': {
      const size = ctx.size;
      if (size === undefined) return null;
      if (rule.min !== undefined && size < rule.min) {
        return `fileSizeBytes — actual ${size} bytes / min ${rule.min} bytes`;
      }
      if (rule.max !== undefined && size > rule.max) {
        return `fileSizeBytes — actual ${size} bytes / max ${rule.max} bytes`;
      }
      return null;
    }

    case 'audioZeroCrossingRatePerS': {
      const zcRate = ctx.audio?.zcRatePerS;
      if (zcRate === undefined) return null;
      if (zcRate > rule.max) {
        return `audioZeroCrossingRatePerS — actual ${zcRate} / max ${rule.max}`;
      }
      return null;
    }

    case 'audioDurationMs': {
      const duration = ctx.audio?.durationMs;
      if (duration === undefined) return null;
      if (rule.min !== undefined && duration < rule.min) {
        return `audioDurationMs — actual ${duration}ms / min ${rule.min}ms`;
      }
      if (rule.max !== undefined && duration > rule.max) {
        return `audioDurationMs — actual ${duration}ms / max ${rule.max}ms`;
      }
      return null;
    }

    case 'textContentForbidden': {
      const text = ctx.text;
      // Non-text artifact (or content not read): rule does not apply.
      if (text === undefined) return null;
      const label = rule.label ? `${rule.label}: ` : '';
      for (const pat of rule.patterns) {
        let re: RegExp;
        try {
          re = new RegExp(pat, 'iu');
        } catch {
          // Malformed pattern source: skip it rather than crash the verifier.
          // (Patterns come from template config; a bad one must not block publish.)
          continue;
        }
        if (re.test(text)) {
          return `textContentForbidden — ${label}matched /${pat}/`;
        }
      }
      return null;
    }

    default:
      // Track A rules (lengthTarget, format, requireHeading, mime) are not checked here.
      return null;
  }
}

/**
 * Builds a PostToolUse HookCallback that enforces Track B file-on-disk rules on
 * `mcp__execution-tools__publish_artifact_file` calls.
 *
 * @param rules - ContractRule array; non-Track-B rules are silently ignored.
 * @param ctx - Injected writers and analyzers (vitest mocks in tests; production wrappers from hook-context-factory).
 */
export function buildTrackBHook(rules: ContractRule[], ctx: TrackBHookCtx): HookCallback {
  const trackBRules = rules.filter(
    (r) =>
      r.kind === 'fileSizeBytes' ||
      r.kind === 'audioZeroCrossingRatePerS' ||
      r.kind === 'audioDurationMs' ||
      r.kind === 'textContentForbidden',
  );

  return async (input, _toolUseId, _options) => {
    // Guard: only handle publish_artifact_file PostToolUse events — must be BEFORE try/catch
    const hookEvent = (input as { hook_event_name?: string }).hook_event_name;
    const toolName = (input as { tool_name?: string }).tool_name;
    if (hookEvent !== 'PostToolUse') return {};
    if (toolName !== PUBLISH_ARTIFACT_TOOL) return {};

    const typedInput = input as {
      tool_input: { sourcePath?: string };
      agent_id?: string;
      agent_type?: string;
    };
    const sourcePath = typedInput.tool_input?.sourcePath ?? '';
    const agentId = typedInput.agent_id ?? '';
    const agentType = typedInput.agent_type ?? '';

    try {
      // Determine which checks are needed
      const hasSizeRules = trackBRules.some((r) => r.kind === 'fileSizeBytes');
      const hasAudioRules = trackBRules.some(
        (r) =>
          r.kind === 'audioZeroCrossingRatePerS' || r.kind === 'audioDurationMs',
      );
      const hasTextRules = trackBRules.some((r) => r.kind === 'textContentForbidden');

      let fileSize: number | undefined;
      let audioResult: { zcRatePerS: number; durationMs: number } | undefined;
      let textContent: string | undefined;

      if (hasSizeRules) {
        const stat = await ctx.statFn(sourcePath);
        fileSize = stat.size;
      }

      if (hasAudioRules) {
        audioResult = await ctx.audioAnalyzer(sourcePath);
      }

      // Only read text content for text/* artifacts (or unknown extension).
      // Scope by the file's OWN extension (deterministic) rather than the
      // LLM-passed mime arg, which the broadcast (口播稿) publish omits — the
      // mime is inferred internally from the .txt path. This avoids decoding
      // audio/image blobs as UTF-8 while reliably scanning the script.
      const inferredMime = inferMimeFromPath(sourcePath);
      if (hasTextRules && (inferredMime === undefined || inferredMime.startsWith('text/'))) {
        textContent = await ctx.readTextFn(sourcePath);
      }

      const checkCtx = { size: fileSize, audio: audioResult, text: textContent };

      // Check all Track B rules; first violation wins
      for (const rule of trackBRules) {
        const violation = checkTrackBRule(rule, checkCtx);
        if (violation) {
          // Rejection branch: unlink + audit + step_log + onFailure
          await ctx.unlinkFn(sourcePath).catch((e: unknown) =>
            log.warn({ err: e, sourcePath }, 'Track B: unlink failed; audit row remains durable'),
          );

          ctx.auditWriter({
            stepTaskId: ctx.taskId,
            executionId: ctx.executionId,
            roleId: ctx.roleId,
            contractField: 'expectedArtifacts',
            message: violation,
          });

          ctx.stepLogWriter({
            taskId: ctx.taskId,
            type: 'validator_error',
            content: `Track B rejected: ${violation}`,
          });

          const sessionId = agentId ? ctx.getSubagentSessionId(agentId) : undefined;
          ctx.onFailure?.(agentId, agentType, violation, sessionId);

          return {};
        }
      }

      return {};
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Internal-error fail-closed: best-effort unlink attempted
      await ctx.unlinkFn(sourcePath).catch((e: unknown) =>
        log.warn({ err: e, sourcePath }, 'Track B: unlink failed in error handler'),
      );

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
          type: 'validator_error',
          content: `Track B internal error: ${errMsg}`,
        });
      } catch {
        // stepLogWriter itself threw — still fail-closed
      }

      return {};
    }
  };
}
