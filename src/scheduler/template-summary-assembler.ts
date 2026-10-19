/**
 * Template Execution Summary Assembler — Phase 2 DP-001 Option C.
 *
 * Lifted from src/scheduler/template-executor.ts as a pure free-function module so both
 * the live template-execution path and the post-hoc dispatch_outbound_batch path can
 * call the same assembler without circular imports.
 *
 * Public API:
 *   assembleSummary(input)       — core summary builder (used by template-executor + dispatch_outbound_batch)
 *   assembleSummaryFromDb(id)   — DB-reconstructed entry point (dispatch_outbound_batch only)
 *   tryAssembleFallbackDelivery  — primary-artifact fallback for failure reports (template-executor only)
 *   DeliveryNotImplementedError, PrimaryArtifactNotFoundError — re-exported for compat
 */

import { basename, extname } from "node:path";
import { readFileSync } from "node:fs";
import { getLogger } from "../lib/logger.js";
import { getExtensionFromMime } from "../channels/adapters/wechat/media/mime.js";
import { listArtifactsByExecution, type Artifact, type TemplateStepArtifact } from "../store/artifacts.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { getTaskTemplate } from "../store/task-templates.js";
import { checkDeliveryCompleteness, type DeliveryGap } from "../lib/delivery-completeness.js";
import { isInternalSentinel } from "../lib/resolve-contract-rules.js";
import type {
  ArtifactCollectionManifest,
  TaskTemplate,
  StepResult,
} from "../shared/types.js";

const log = getLogger("scheduler");

// ---------------------------------------------------------------------------
// Error classes — re-exported for backward compat with existing test imports
// ---------------------------------------------------------------------------

/** Thrown when a primary-artifact lookup finds no matching artifact. */
export class PrimaryArtifactNotFoundError extends Error {
  constructor(
    public stepId: string,
    public key: string,
    public availableKeys: string[],
  ) {
    super(`Primary artifact not found: stepId="${stepId}" key="${key}". Available keys: [${availableKeys.join(", ")}]`);
    this.name = "PrimaryArtifactNotFoundError";
  }
}

/** Thrown when delivery mode "custom" is selected at runtime. */
export class DeliveryNotImplementedError extends Error {
  constructor(public mode: string) {
    super(`Delivery mode "${mode}" is not implemented. Use "concat-step-results" or "primary-artifact".`);
    this.name = "DeliveryNotImplementedError";
  }
}

// ---------------------------------------------------------------------------
// Input/output types
// ---------------------------------------------------------------------------

export interface AssembleSummaryInput {
  executionId: string;
  template: TaskTemplate;
  stepResults: Map<string, StepResult>;
}

// ---------------------------------------------------------------------------
// Helper: formatBytes (used by renderArtifactCollectionManifest)
// ---------------------------------------------------------------------------

function formatBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)}MB`;
  if (sizeBytes >= 1024) return `${(sizeBytes / 1024).toFixed(1)}KB`;
  return `${sizeBytes}B`;
}

// ---------------------------------------------------------------------------
// Helper: isArtifactCollectionManifestValue (standalone predicate)
// ---------------------------------------------------------------------------

function isArtifactCollectionManifestValue(value: unknown): value is ArtifactCollectionManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArtifactCollectionManifest>;
  return candidate.type === "artifact_collection"
    && typeof candidate.outputAs === "string"
    && Array.isArray(candidate.items);
}

// ---------------------------------------------------------------------------
// Helper: banner for delivery completeness gaps
// ---------------------------------------------------------------------------

function formatGapLine(gap: DeliveryGap): string {
  if (gap.kind === "no_content") {
    const reason = gap.reason ? `\n  (${gap.reason})` : "";
    return `原因: ${gap.stepId} 步骤的 ${gap.key} 产出被标记为 no_content${reason}`;
  }
  return `原因: ${gap.stepId} 步骤的 ${gap.key} 未产出`;
}

function assembleBanner(gaps: DeliveryGap[]): string {
  if (gaps.length === 0) return "";
  const lines = ["⚠️ 本期音频缺失", ...gaps.map(formatGapLine)];
  return `${lines.join("\n")}\n\n---\n\n`;
}

// ---------------------------------------------------------------------------
// Helper: resolvePrimaryArtifactRef
// ---------------------------------------------------------------------------

function resolvePrimaryArtifactRef(input: AssembleSummaryInput): { stepId: string; key: string } {
  const ref = input.template.config?.delivery?.primaryArtifact;
  if (!ref) {
    throw new Error("Delivery mode is 'primary-artifact' but primaryArtifact is missing — Zod schema should have rejected this; check template config validation.");
  }
  let resolvedKey = ref.key;
  if (!resolvedKey) {
    const step = input.template.steps.find((s) => s.id === ref.stepId);
    resolvedKey = step?.outputAs ?? undefined;
    if (!resolvedKey) {
      throw new PrimaryArtifactNotFoundError(ref.stepId, "", []);
    }
  }
  return { stepId: ref.stepId, key: resolvedKey };
}

// ---------------------------------------------------------------------------
// Helper: resolvePrimaryArtifact
// ---------------------------------------------------------------------------

function resolvePrimaryArtifact(
  input: AssembleSummaryInput,
  ref: { stepId: string; key: string },
): TemplateStepArtifact {
  const artifacts = listArtifactsByExecution(input.executionId);
  const match = artifacts.find((a) => a.stepId === ref.stepId && a.key === ref.key);
  if (!match) {
    const available = artifacts
      .filter((a) => a.stepId === ref.stepId)
      .map((a) => a.key);
    throw new PrimaryArtifactNotFoundError(ref.stepId, ref.key, available);
  }
  return match;
}

// ---------------------------------------------------------------------------
// Helper: renderArtifactCollectionManifest
// ---------------------------------------------------------------------------

function renderArtifactCollectionManifest(manifest: ArtifactCollectionManifest): string {
  const lines = [`Artifact collection "${manifest.outputAs}" (${manifest.items.length} files):`];
  for (const item of manifest.items) {
    const name = item.filename ?? item.key;
    const mime = item.mime ? `, ${item.mime}` : "";
    const purpose = item.purpose ? `, purpose=${item.purpose}` : "";
    lines.push(`- ${name} (${formatBytes(item.sizeBytes)}${mime}${purpose}; key=${item.key})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helper: renderPrimaryArtifactBody
// ---------------------------------------------------------------------------

function renderPrimaryArtifactBody(match: Artifact): string {
  // For json artifacts: stringify the value (handle undefined explicitly — JSON.stringify(undefined) returns undefined, not a string)
  if (match.kind === "json") {
    if (match.value === undefined) {
      throw new Error(`Primary artifact "${match.stepId}/${match.key}" has kind=json but value is undefined; cannot render as body`);
    }
    if (isArtifactCollectionManifestValue(match.value)) {
      return renderArtifactCollectionManifest(match.value);
    }
    return typeof match.value === "string" ? match.value : JSON.stringify(match.value, null, 2);
  }
  // For file artifacts: read from blobPath if it's a text mime type
  if (match.kind === "file" && match.blobPath) {
    const isText = !match.mime
      || match.mime.startsWith("text/")
      || match.mime === "application/json"
      || match.mime === "application/markdown"
      || match.originalFilename?.endsWith(".md");
    if (isText) {
      try {
        return readFileSync(match.blobPath, "utf-8");
      } catch (err) {
        throw new Error(`Failed to read primary artifact at ${match.blobPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`Primary artifact mime "${match.mime}" is not text-renderable; use "concat-step-results" or pick a text artifact key`);
  }
  throw new Error(`Primary artifact has no body: kind=${match.kind}, blobPath=${match.blobPath}`);
}

// ---------------------------------------------------------------------------
// Helper: resolvePrimaryArtifactBody
// ---------------------------------------------------------------------------

function resolvePrimaryArtifactBody(input: AssembleSummaryInput): string {
  return renderPrimaryArtifactBody(resolvePrimaryArtifact(input, resolvePrimaryArtifactRef(input)));
}

// ---------------------------------------------------------------------------
// Core assembler: assembleSummary
// ---------------------------------------------------------------------------

/**
 * Assemble the delivery summary for a TemplateExecution.
 *
 * @param input.executionId  — used only for artifact lookup in primary-artifact mode
 * @param input.template    — TaskTemplate (provides config.delivery.mode + primaryArtifact ref)
 * @param input.stepResults — Map<stepId, StepResult> built during execution
 */
export function assembleSummary(input: AssembleSummaryInput): string {
  const mode = input.template.config?.delivery?.mode ?? "concat-step-results";
  if (mode === "primary-artifact") {
    const body = resolvePrimaryArtifactBody(input);
    const completeness = checkDeliveryCompleteness(input.executionId, input.template);
    return assembleBanner(completeness.gaps) + body;
  }
  if (mode === "custom") {
    throw new DeliveryNotImplementedError("custom");
  }
  // Default: concat-step-results
  const completeness = checkDeliveryCompleteness(input.executionId, input.template);
  const sections: string[] = [];
  for (const [stepId, result] of input.stepResults) {
    const icon = result.status === "completed" ? "OK"
      : result.status === "skipped" ? "SKIP"
      : result.status === "no_content" ? "NO-CONTENT"
      : "FAIL";
    const roleLabel = result.roleName ? ` (${result.roleName})` : "";
    // Task 7-impl: Delivery-layer sentinel guard (defense-in-depth).
    // Even if an upstream path still produces the internal sentinel as a step result
    // or error, refuse to emit the raw string to the user. Replace with a sanitized
    // notice that communicates the failure without leaking internal details.
    const rawContent = result.result ?? result.error ?? "No output";
    const content = isInternalSentinel(rawContent)
      ? "该步骤因超时被中止，未产出有效内容。"
      : rawContent;
    sections.push(`## [${icon}] Step: ${stepId}${roleLabel}\n\n${content}`);
  }
  return assembleBanner(completeness.gaps) + sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Fallback delivery (for template-executor failure path)
// ---------------------------------------------------------------------------

export interface FallbackDeliveryResult {
  summary: string;
  fileArtifacts: Artifact[];
  usedFallback: true;
}

/**
 * Try to assemble a partial delivery using primary-artifact mode even when the
 * overall execution status is failure/partial/cancelled.
 *
 * @param assembleFailureReport — called to produce the leading failure banner;
 *   depends on context.failedStepIds which stays in template-executor
 *
 * NOTE: tryAssembleFallbackDelivery intentionally does NOT prepend assembleBanner —
 * the existing assembleFailureReport(status) already conveys what went wrong, and
 * duplicating it with the chokepoint banner would produce two failure blocks at the
 * top of the email body. The chokepoint banner runs in the normal-completion paths
 * (assembleSummary + assembleSummaryFromDb) where no failure report would otherwise
 * appear.
 */
export function tryAssembleFallbackDelivery(
  input: AssembleSummaryInput,
  status: "completed" | "failed" | "partial" | "cancelled",
  assembleFailureReport: (status: "completed" | "failed" | "partial" | "cancelled") => string,
): FallbackDeliveryResult | null {
  const mode = input.template.config?.delivery?.mode ?? "concat-step-results";
  if (mode !== "primary-artifact") return null;

  try {
    const ref = resolvePrimaryArtifactRef(input);
    const artifact = resolvePrimaryArtifact(input, ref);
    const body = renderPrimaryArtifactBody(artifact);
    const failureReport = assembleFailureReport(status);
    return {
      summary: `${input.template.name}: partial result delivered from ${ref.stepId}/${ref.key}.\n\n${failureReport}\n\n---\n\n${body}`,
      fileArtifacts: primaryArtifactFileAttachments(input.executionId, artifact),
      usedFallback: true,
    };
  } catch (err) {
    log.warn(
      {
        executionId: input.executionId,
        templateId: input.template.id,
        error: err instanceof Error ? err.message : String(err),
      },
      "TemplateExecution fallback delivery unavailable",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// primaryArtifactFileAttachments
// ---------------------------------------------------------------------------

export function primaryArtifactFileAttachments(
  executionId: string,
  artifact: TemplateStepArtifact,
): TemplateStepArtifact[] {
  if (artifact.kind === "file" && artifact.blobPath) return [artifact];
  if (artifact.kind !== "json" || !isArtifactCollectionManifestValue(artifact.value)) return [];

  const artifacts = listArtifactsByExecution(executionId);
  const byKey = new Map(artifacts.map((candidate) => [`${candidate.stepId}/${candidate.key}`, candidate]));
  return artifact.value.items
    .map((item) => byKey.get(`${artifact.stepId}/${item.key}`))
    .filter((candidate): candidate is TemplateStepArtifact => !!candidate && candidate.kind === "file" && !!candidate.blobPath);
}

// ---------------------------------------------------------------------------
// DB entry point for dispatch_outbound_batch (Phase 2 DP-001 Option C)
// ---------------------------------------------------------------------------

function readStepResultsJson(
  execution: { stepResultsJson?: string | null },
): Map<string, StepResult> | undefined {
  if (!execution.stepResultsJson) return undefined;
  try {
    const parsed = JSON.parse(execution.stepResultsJson) as Array<[string, StepResult]>;
    return new Map(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct a TemplateExecution's summary + file artifacts from DB, without
 * re-running any steps. Used by dispatch_outbound_batch to redeliver a completed
 * execution.
 *
 * Returns undefined when the execution row or step_results_json is absent
 * (older executions, or templates that failed before persisting results).
 */
export function assembleSummaryFromDb(
  executionId: string,
): { summary: string; fileArtifacts: Artifact[] } | undefined {
  const execution = getTemplateExecution(executionId);
  if (!execution) return undefined;
  const template = getTaskTemplate(execution.templateId);
  if (!template) return undefined;
  const stepResults = readStepResultsJson(execution);
  if (!stepResults) return undefined;
  const summary = assembleSummary({ executionId, template, stepResults });
  const fileArtifacts = listArtifactsByExecution(executionId).filter(
    (a) => a.kind === "file" && a.blobPath,
  );
  return { summary, fileArtifacts };
}
