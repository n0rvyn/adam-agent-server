/**
 * Step Output Resolution — canonical helper for reading a completed step's output.
 *
 * - If step.outputAs is declared: reads the artifact at (executionId, stepId, step.outputAs).
 *   Missing artifact → throws StepOutputMissingError.
 * - If step.outputAs is undeclared: falls back to task.result (legacy back-compat).
 *
 * Callers (Phase 2 Layer A, Phase 4 delivery) MUST handle StepOutputMissingError.
 */

import { getArtifact, listArtifactsByExecution } from "../store/artifacts.js";
import type { Artifact, TemplateStepArtifact } from "../store/artifacts.js";
import { getTask } from "../store/tasks.js";
import { readFileSync } from "node:fs";
import type { TaskStep } from "../shared/types.js";

export interface StepOutputResult {
  content: string;
  mime: string;
  sizeBytes: number;
  source: "artifact" | "task-result-fallback";
  artifactId: string | null;
  key: string | null;
}

export class StepOutputMissingError extends Error {
  constructor(public readonly stepId: string, public readonly outputAs: string) {
    super(`Step "${stepId}" declares outputAs="${outputAs}" but no artifact with that key was published.`);
    this.name = "StepOutputMissingError";
  }
}

export class StepOutputBinaryError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly outputAs: string,
    public readonly mime: string,
  ) {
    super(
      `Step "${stepId}" output (key="${outputAs}", mime="${mime}") is binary; contract verification cannot decode as UTF-8.`,
    );
    this.name = "StepOutputBinaryError";
  }
}

/** Set of mime prefixes treated as text-decodable. Anything else → binary. */
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml"];

function isTextMime(mime: string | null | undefined): boolean {
  if (!mime) return true; // unknown defaults to text (existing behavior compatibility)
  return TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function artifactToResult(artifact: TemplateStepArtifact, stepId: string): StepOutputResult {
  let content: string;
  if (artifact.kind === "json") {
    content = JSON.stringify(artifact.value, null, 2);
  } else {
    // file artifact: only decode as UTF-8 when mime says so
    if (!isTextMime(artifact.mime)) {
      throw new StepOutputBinaryError(stepId, artifact.key, artifact.mime ?? "application/octet-stream");
    }
    content = artifact.blobPath ? readFileSync(artifact.blobPath, "utf8") : "";
  }
  return {
    content,
    mime: artifact.mime ?? "text/plain",
    sizeBytes: artifact.sizeBytes,
    source: "artifact",
    artifactId: artifact.id,
    key: artifact.key,
  };
}

/**
 * Resolve the canonical "output" of a completed step.
 *
 * - If step.outputAs is declared: read artifact (executionId, stepId, step.outputAs).
 *   Missing artifact → throw StepOutputMissingError.
 * - If step.outputAs is undeclared: fall back to task.result (legacy back-compat).
 */
export function getStepOutput(args: {
  step: TaskStep;
  executionId: string;
  taskId: string;
}): StepOutputResult {
  const { step, executionId, taskId } = args;

  if (step.outputAs) {
    const artifact = getArtifact(executionId, step.id, step.outputAs);
    if (!artifact) {
      throw new StepOutputMissingError(step.id, step.outputAs);
    }
    return artifactToResult(artifact, step.id);
  }

  // Legacy back-compat: read task.result
  const task = getTask(taskId);
  const content = task?.result ?? "";
  return {
    content,
    mime: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    source: "task-result-fallback",
    artifactId: null,
    key: null,
  };
}

/**
 * Count published artifacts per logical `role` for a step that declares
 * outputContract.expectedArtifacts. Reads the artifact rows directly (each carries
 * `artifactRole`) — does not decode any artifact content, so it is safe for binary
 * (audio/video) outputs where getStepOutput would throw StepOutputBinaryError.
 * Returns a Map<role, count>; an absent role has no entry.
 */
export function getPublishedRoleCounts(args: {
  step: TaskStep;
  executionId: string;
}): Map<string, number> {
  const counts = new Map<string, number>();
  if (!args.step.outputAs) return counts;
  for (const artifact of listArtifactsByExecution(args.executionId, args.step.id)) {
    const role = artifact.artifactRole;
    if (role) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return counts;
}
