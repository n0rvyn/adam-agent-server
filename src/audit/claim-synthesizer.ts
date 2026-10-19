import { deriveClaimsFromReceipts } from "./implicit-claim-deriver.js";
import { detectCompletionLanguage } from "../chat/completion-language-detector.js";
import type { ClaimSpec, ClaimSource } from "../shared/types.js";
import type { VerbFamily } from "../chat/completion-language-detector.js";

export interface SynthesizeArgs {
  traceId: string;
  text: string;
  explicitClaims?: ClaimSpec[];
}

export interface ClaimConflict {
  explicitClaim: ClaimSpec;
  implicitClaim: ClaimSpec;
  reason: string;
}

export interface SynthesizeResult {
  claims: ClaimSpec[];
  claimSource: ClaimSource;
  conflicts: ClaimConflict[];
  unmatchedCompletionLanguage: boolean;
}

/** Stub a ClaimSpec from a verb family for silent-failure paths. */
function stubClaimFromVerbFamily(verbFamily: VerbFamily, evidenceSpan: string): ClaimSpec {
  return {
    verb: verbFamily,
    entityType: "_unknown",
    expected: {
      kind: "outbound",
      target: { channelId: "_unspecified" },
    },
    note: `text-derived-stub:${verbFamily}:${evidenceSpan}`,
    textDerivedStub: { verbFamily, evidenceSpan },
  };
}

function detectConflicts(
  implicit: ClaimSpec[],
  explicit: ClaimSpec[],
): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  for (const e of explicit) {
    if (e.expected.kind !== "outbound") continue;
    for (const i of implicit) {
      if (i.expected.kind !== "outbound") continue;
      const eTarget = e.expected.target;
      const iTarget = i.expected.target;
      // Same channelId?
      if (eTarget.channelId !== iTarget.channelId) continue;
      // Disagree on attachmentCount?
      const eAtt = e.expected.attachmentCount;
      const iAtt = i.expected.attachmentCount;
      if (eAtt !== undefined && iAtt !== undefined && eAtt > iAtt) {
        conflicts.push({
          explicitClaim: e,
          implicitClaim: i,
          reason: `explicit attachmentCount=${eAtt} but receipt shows ${iAtt}`,
        });
      }
    }
  }
  return conflicts;
}

/** Merge claims, deduplicating by identity key — entity + verb + kind + channelId.
 *  attachmentCount/textPresent are not part of identity; they are verified by the
 *  per-claim verdict after dedup, so two claims with the same identity should merge. */
function mergeClaimsDedupe(implicit: ClaimSpec[], explicit: ClaimSpec[]): ClaimSpec[] {
  const seen = new Set<string>();
  const merged: ClaimSpec[] = [];
  for (const c of [...implicit, ...explicit]) {
    const key = `${c.entityType}|${c.verb}|${c.expected.kind}|${
      c.expected.kind === "outbound" ? (c.expected.target?.channelId ?? "_no_channel") : "_"
    }`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  return merged;
}

/**
 * Synthesizes the final claim set for a turn.
 *
 * Algorithm:
 * 1. Derive implicit claims from receipts (via deriveClaimsFromReceipts)
 * 2. Use explicit claims as provided
 * 3. Detect completion language in text
 * 4. Detect conflicts between explicit and implicit
 * 5. Determine provenance (claimSource) based on what is available
 *
 * @param args.traceId - Trace ID for receipt lookup
 * @param args.text - Assistant reply text (for completion-language detection)
 * @param args.explicitClaims - Claims from commit_claim tool (optional)
 * @returns SynthesizeResult with claims, claimSource, conflicts, unmatchedCompletionLanguage
 */
export function synthesizeImplicitClaims(args: SynthesizeArgs): SynthesizeResult {
  const implicit = args.traceId ? deriveClaimsFromReceipts(args.traceId) : [];
  const explicit = args.explicitClaims ?? [];
  const lang = detectCompletionLanguage(args.text ?? "");

  // Conflict detection: explicit vs implicit on outbound attachment counts
  const conflicts = detectConflicts(implicit, explicit);

  // Provenance decision
  if (conflicts.length > 0) {
    return {
      claimSource: "conflict",
      claims: explicit, // verifier will block on the inflated claim
      conflicts,
      unmatchedCompletionLanguage: false,
    };
  }

  if (explicit.length > 0 && implicit.length > 0) {
    return {
      claimSource: "hybrid",
      claims: mergeClaimsDedupe(implicit, explicit),
      conflicts: [],
      unmatchedCompletionLanguage: false,
    };
  }

  if (explicit.length > 0) {
    return {
      claimSource: "explicit",
      claims: explicit,
      conflicts: [],
      unmatchedCompletionLanguage: false,
    };
  }

  if (implicit.length > 0) {
    return {
      claimSource: "implicit",
      claims: implicit,
      conflicts: [],
      unmatchedCompletionLanguage: false,
    };
  }

  if (lang.detected) {
    // Silent-failure path: text says something was done, but no evidence in receipts
    return {
      claimSource: "implicit",
      claims: lang.matches.map((m) => stubClaimFromVerbFamily(m.verbFamily, m.evidenceSpan)),
      conflicts: [],
      unmatchedCompletionLanguage: true,
    };
  }

  return {
    claimSource: "vacuous",
    claims: [],
    conflicts: [],
    unmatchedCompletionLanguage: false,
  };
}
