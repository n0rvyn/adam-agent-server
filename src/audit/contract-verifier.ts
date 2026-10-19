/**
 * Output Contract Verifier — Two-Layer Audit
 *
 * Layer A (runLayerA): synchronous rule-based checks — length, format, persona identity.
 *   Pure function, no side effects, no I/O.
 *
 * Layer B (runLayerB): semantic check via Reviewer-Role verifier task dispatch.
 *   Async, calls createTaskWithAdmission + waitForTaskCompletion.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskStep } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createTaskWithAdmission } from "../lib/task-dispatch.js";
import { listArtifactsByExecution } from "../store/artifacts.js";
import { truncateArtifactContent } from "./artifact-truncate.js";
import { waitForTaskCompletion } from "../scheduler/wait-for-task.js";
import { getTask } from "../store/tasks.js";
import { getStepOutput, StepOutputMissingError, StepOutputBinaryError } from "../lib/step-output.js";

// Phase 2 hard-coded Reviewer Role ID (verified system Role)
export const REVIEWER_ROLE_ID = "role-179cc83a";

// ---------------------------------------------------------------------------
// Layer A
// ---------------------------------------------------------------------------

export interface LayerAViolation {
  contractField: "lengthTarget" | "format" | "persona.speakAs" | "outputAs";
  message: string;
  actual?: number;  // structured measurement; present for lengthTarget violations
}

export interface LayerAResult {
  passed: boolean;
  violations: LayerAViolation[];
}

export interface LayerAInput {
  step: TaskStep;
  executionId: string;
  taskId: string;
}

export function runLayerA(args: LayerAInput): LayerAResult {
  const violations: LayerAViolation[] = [];

  // Role-tagging (expectedArtifacts) removed (D6): contract granularity is the key (outputAs),
  // enforced by the presence gate below plus the boundary hooks. No per-role count check here.

  let measured: { content: string; sizeBytes: number };
  try {
    const output = getStepOutput({ step: args.step, executionId: args.executionId, taskId: args.taskId });
    measured = { content: output.content, sizeBytes: output.sizeBytes };
  } catch (err) {
    if (err instanceof StepOutputMissingError) {
      violations.push({
        contractField: "outputAs",
        message: err.message,
      });
      return { passed: false, violations };
    }
    if (err instanceof StepOutputBinaryError) {
      // Binary artifact (audio/image/video) — content (length/format/persona) checks don't apply.
      // Binaries are validated by Track B (PostToolUse) + the presence gate; Layer A passes them.
      return { passed: true, violations };
    }
    throw err;
  }

  const taskResult = measured.content;

  // Content checks (length / format) are enforced at the PreToolUse boundary hook on write_artifact
  // (Track A), not post-hoc. Layer A does presence (above) + persona identity (below) only.
  // Identity regex check — only for non-podcast-Role personas
  if (args.step.persona?.speakAs) {
    const podcastRoleNames = ["达芬奇", "快刀青衣", "周杰伦", "毕加索"];
    if (!podcastRoleNames.includes(args.step.persona.speakAs)) {
      const matched = podcastRoleNames.find((name) => {
        const pattern = new RegExp(`我是\\s*(${name})`);
        return pattern.test(taskResult);
      });
      if (matched) {
        violations.push({
          contractField: "persona.speakAs",
          message: `expected first-person as ${args.step.persona.speakAs}, but output self-identifies as ${matched}`,
        });
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Artifact truncation helper (imported from artifact-truncate.ts for use in runLayerB)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layer B interfaces (declared before runLayerB)
// ---------------------------------------------------------------------------

export interface LayerBResult {
  passed: boolean;
  verifierTaskId: string | null;
  identityCoherent: boolean | null;
  upstreamGrounded: boolean | null;
  confidence: number | null;
  issues: string[];
  failed: boolean;
}

// ---------------------------------------------------------------------------
// runLayerB
// ---------------------------------------------------------------------------

/**
 * Resolve the contract-verifier prompt template path.
 * Matches the lazy-load + multi-path resolution pattern from intent-eval.ts.
 */
function resolveContractVerifierPromptPath(): string {
  const candidates = [
    join(process.cwd(), "src/audit/prompts/contract-verifier.md"),
    join(process.cwd(), "audit/prompts/contract-verifier.md"),
    join(__dirname, "prompts/contract-verifier.md"),
  ];
  for (const p of candidates) {
    try { readFileSync(p, "utf8"); return p; } catch { /* try next */ }
  }
  throw new Error("Could not find contract-verifier.md prompt template");
}

let cachedTemplate: string | null = null;

function getContractVerifierTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  cachedTemplate = readFileSync(resolveContractVerifierPromptPath(), "utf8");
  return cachedTemplate;
}

export async function runLayerB(args: {
  step: TaskStep;
  producerRoleId: string;
  producerRoleName: string;
  producerTaskId: string;
  executionId: string;
  stepResult: string;
}): Promise<LayerBResult> {
  const { step, producerRoleId, producerRoleName, producerTaskId, executionId, stepResult } = args;

  // Hard constraint: verifier and producer must be different Roles
  if (REVIEWER_ROLE_ID === producerRoleId) {
    throw new Error("verifierRoleId must differ from producerRoleId");
  }

  // Cap stepResult at 32KB: head 24KB + tail 8KB
  const stepResultBytes = Buffer.byteLength(stepResult, "utf8");
  const MAX_STEP_OUTPUT_BYTES = 32 * 1024;
  const STEP_HEAD_BYTES = 24 * 1024;
  const STEP_TAIL_BYTES = 8 * 1024;
  let stepOutput: string;
  if (stepResultBytes <= MAX_STEP_OUTPUT_BYTES) {
    stepOutput = stepResult;
  } else {
    const head = stepResult.slice(0, STEP_HEAD_BYTES);
    const safeHead = head.slice(0, Math.max(0, head.lastIndexOf("\n")));
    const tail = stepResult.slice(Math.max(0, stepResult.length - STEP_TAIL_BYTES));
    stepOutput = `${safeHead}\n<TRUNCATED reason="size_cap_32KB" full_size="${stepResultBytes}"/>\n${tail}`;
  }

  // Read upstream artifacts: step.consumesFrom ∪ step.consumesFromOptional ∪ step.dependsOn
  const sourceStepIds = [
    ...(step.consumesFrom ?? []),
    ...(step.consumesFromOptional ?? []),
    ...(step.dependsOn ?? []),
  ];

  const allArtifacts = listArtifactsByExecution(executionId);
  const relevantArtifacts = allArtifacts.filter((a) => sourceStepIds.includes(a.stepId));

  let upstreamArtifactsSection: string;
  if (relevantArtifacts.length === 0) {
    upstreamArtifactsSection = "(no upstream artifacts available)";
  } else {
    upstreamArtifactsSection = relevantArtifacts.map((artifact) => {
      // Fetch content: json value or blob path
      let content: string;
      if (artifact.kind === "json" && artifact.value !== undefined) {
        content = JSON.stringify(artifact.value, null, 2);
      } else if (artifact.kind === "file" && artifact.blobPath) {
        try { content = readFileSync(artifact.blobPath, "utf8"); } catch { content = "(failed to read artifact file)"; }
      } else {
        content = "(no content available)";
      }
      const [truncatedContent] = truncateArtifactContent(content, artifact.sizeBytes);
      const escapedContent = escapeAngleLT(truncatedContent);
      return `<UPSTREAM_ARTIFACT stepId="${artifact.stepId}" key="${artifact.key}">\n${escapedContent}\n</UPSTREAM_ARTIFACT>`;
    }).join("\n\n");
  }

  // Escape step output before embedding
  const escapedStepOutput = escapeAngleLT(stepOutput);

  // Render prompt template
  const template = getContractVerifierTemplate();
  const renderedPrompt = template
    .replace("{{stepId}}", producerTaskId)
    .replace("{{producerRoleName}}", producerRoleName)
    .replace("{{personaSpeakAs}}", step.persona?.speakAs ?? "(none)")
    .replace("{{personaVoice}}", step.persona?.voiceConstraints ?? "(none)")
    .replace("{{mustReferenceArtifacts}}", String(step.outputContract?.mustReferenceArtifacts ?? false))
    .replace("{{upstreamArtifacts}}", upstreamArtifactsSection)
    .replace("{{stepOutput}}", escapedStepOutput);

  // Dispatch verifier task via createTaskWithAdmission
  const dispatchResult = await createTaskWithAdmission({
    prompt: renderedPrompt,
    roleId: REVIEWER_ROLE_ID,
    config: {
      timeout: 60,
      // 2026-05-29 raised 2→10: non-Claude proxied models (doubao/deepseek/glm via Ark)
      // need more turns than Claude to read the artifact + judge; maxTurns:2 force-closed
      // the narrative verifier mid-judge → {passed:false,failed:true} → quality gate silently off.
      maxTurns: 10,
      taskType: "contract-verifier",
    },
    sourceSessionId: executionId,
    dispatchSource: "contract_verifier",
  });

  if (!dispatchResult.ok) {
    return {
      passed: false,
      failed: true,
      verifierTaskId: null,
      identityCoherent: null,
      upstreamGrounded: null,
      confidence: null,
      issues: [`dispatch rejected: ${dispatchResult.reason}`],
    };
  }

  const verifierTaskId = dispatchResult.taskId;

  // Await completion
  const status = await waitForTaskCompletion(verifierTaskId, 60 * 1000);
  if (status !== "completed") {
    return {
      passed: false,
      failed: true,
      verifierTaskId,
      identityCoherent: null,
      upstreamGrounded: null,
      confidence: null,
      issues: [`verifier task ${status}`],
    };
  }

  // Read verifier result
  const verifierTask = getTask(verifierTaskId);
  let verifierResult: string;
  try {
    verifierResult = (verifierTask?.result ?? "").trim();
  } catch {
    return {
      passed: false,
      failed: true,
      verifierTaskId,
      identityCoherent: null,
      upstreamGrounded: null,
      confidence: null,
      issues: ["verifier task returned no result"],
    };
  }

  // Strip optional markdown fences
  const stripped = verifierResult
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Parse JSON
  let parsed: { identityCoherent?: unknown; upstreamGrounded?: unknown; confidence?: unknown; issues?: unknown };
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return {
      passed: false,
      failed: true,
      verifierTaskId,
      identityCoherent: null,
      upstreamGrounded: null,
      confidence: null,
      issues: [`verifier returned non-JSON: ${stripped.slice(0, 100)}`],
    };
  }

  const identityCoherent = typeof parsed.identityCoherent === "boolean" ? parsed.identityCoherent : null;
  const upstreamGrounded = typeof parsed.upstreamGrounded === "boolean" ? parsed.upstreamGrounded : null;
  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === "string") : [];

  // confidence >= 0.7 passes: the prompt tells the verifier "Below 0.7 means I am unsure",
  // so exactly 0.7 is the floor of "confident enough", not a failure. Strict > 0.7 contradicted
  // the prompt and hard-failed the single most common LLM hedge value (round 0.7).
  const passed = identityCoherent === true && upstreamGrounded === true && (confidence === null || confidence >= 0.7);

  return {
    passed,
    failed: false,
    verifierTaskId,
    identityCoherent,
    upstreamGrounded,
    confidence,
    issues,
  };
}

function escapeAngleLT(s: string): string {
  return s.replace(/</g, "&lt;");
}
