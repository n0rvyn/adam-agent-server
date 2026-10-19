/**
 * Per-step delivery completeness check.
 *
 * A delivery is "complete" iff every template step that declares `outputAs` has
 * a delivered artifact. A delivered artifact is EITHER a file blob (kind="file"
 * with a non-null blobPath) OR a non-empty structured JSON value (kind="json") —
 * `format=json` contracts are first-class deliverables (critique objects, scoring
 * results, structured step-to-step handoff), so they legitimately store kind="json"
 * with no blobPath and must count as delivered. JSON markers matching
 * {status:"no_content"} count as gaps; missing artifacts count as gaps;
 * artifact_collection manifests recurse into their items.
 *
 * Single chokepoint consumed by:
 * - template-summary-assembler.ts (banner prepending)
 * - template-executor.ts (execution-status predicate + delivery dispatch)
 * - assembleSummaryFromDb (redelivery path)
 */

import { listArtifactsByExecution, type Artifact } from "../store/artifacts.js";
import { stepRequiresFileArtifact } from "./resolve-contract-rules.js";
import type { TaskTemplate } from "../shared/types.js";

export interface DeliveryGap {
  stepId: string;
  key: string;
  kind: "no_content" | "missing";
  reason?: string;
}

export interface DeliveryCompleteness {
  complete: boolean;
  gaps: DeliveryGap[];
}

interface NoContentMarker {
  status: "no_content";
  reason?: string;
}

function isNoContentMarker(value: unknown): value is NoContentMarker {
  return typeof value === "object"
    && value !== null
    && (value as { status?: unknown }).status === "no_content";
}

interface ArtifactCollectionManifest {
  type: "artifact_collection";
  outputAs: string;
  items: Array<{ key: string }>;
}

function isArtifactCollectionManifest(value: unknown): value is ArtifactCollectionManifest {
  return typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "artifact_collection"
    && Array.isArray((value as { items?: unknown }).items);
}

export function checkDeliveryCompleteness(
  executionId: string,
  template: TaskTemplate,
): DeliveryCompleteness {
  const artifacts = listArtifactsByExecution(executionId);
  const byStepKey = new Map<string, Artifact>();
  for (const a of artifacts) {
    if (a.stepId && a.key) byStepKey.set(`${a.stepId}/${a.key}`, a);
  }

  const gaps: DeliveryGap[] = [];

  for (const step of template.steps) {
    if (!step.outputAs) continue;
    const key = step.outputAs;
    const lookup = byStepKey.get(`${step.id}/${key}`);

    if (!lookup) {
      gaps.push({ stepId: step.id, key, kind: "missing" });
      continue;
    }

    // Manifest collection — recurse into items; the manifest itself is structural
    // and does not count as a deliverable gap (only its children do).
    if (lookup.kind === "json" && isArtifactCollectionManifest(lookup.value)) {
      for (const item of lookup.value.items) {
        const childKey = item.key;
        const childLookup = byStepKey.get(`${step.id}/${childKey}`);
        if (!childLookup) {
          gaps.push({ stepId: step.id, key: childKey, kind: "missing" });
          continue;
        }
        if (childLookup.kind === "json" && isNoContentMarker(childLookup.value)) {
          gaps.push({
            stepId: step.id,
            key: childKey,
            kind: "no_content",
            reason: childLookup.value.reason,
          });
        } else if (childLookup.kind === "file" && !childLookup.blobPath) {
          // A file child that lost its blob is a gap; a real kind="json" child is delivered.
          // The parent step's file requirement is NOT propagated to children here — manifest
          // children are published files whose quality Track B validates at publish time, so
          // the manifest path trusts Track B for child file-quality.
          gaps.push({ stepId: step.id, key: childKey, kind: "missing" });
        }
      }
      continue;
    }

    // no_content marker
    if (lookup.kind === "json" && isNoContentMarker(lookup.value)) {
      gaps.push({
        stepId: step.id,
        key,
        kind: "no_content",
        reason: lookup.value.reason,
      });
      continue;
    }

    // What counts as delivered depends on what the step's CONTRACT requires (single
    // source of truth — stepRequiresFileArtifact). no_content markers and collection
    // manifests were handled above.
    if (stepRequiresFileArtifact(step)) {
      // Contract declares file-on-disk properties (binary/non-json mime, size, audio
      // duration/ZCR). A real published file is required; a kind="json" value here means
      // the step never produced the binary deliverable → gap.
      if (lookup.kind !== "file" || !lookup.blobPath) {
        gaps.push({ stepId: step.id, key, kind: "missing" });
      }
    } else {
      // Content contract (format=json/markdown/text, or no contract): a file blob OR a
      // structured JSON value both count. format=json deliverables (critique objects,
      // scoring results, structured step-to-step handoff) legitimately store kind="json"
      // with no blobPath and are first-class deliverables. Only a file artifact that lost
      // its blob is a gap. (Track A's format=json check validates parseability, not
      // non-emptiness, so a degenerate `{}` counts as delivered — emptiness is a content
      // concern owned by the boundary contract, not the delivery-presence gate.)
      if (lookup.kind === "file" && !lookup.blobPath) {
        gaps.push({ stepId: step.id, key, kind: "missing" });
      }
    }
  }

  return { complete: gaps.length === 0, gaps };
}
