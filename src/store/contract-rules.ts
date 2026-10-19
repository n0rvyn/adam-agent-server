/**
 * ContractRule Zod schemas and TypeScript types.
 *
 * Phase 2 — SDK orchestrator content/file verifier rules.
 * Track A = content-checkable (from tool_input.value in write_artifact).
 * Track B = file-on-disk checks (from publish_artifact_file).
 *
 * ContractRuleSchema is an array of discriminated-union items. Each rule kind
 * has its own sub-schema with literal `kind` discriminator.
 */

import { z } from 'zod';

// --- Track A: content-checkable rules ---

const trackALengthTargetSchema = z
  .object({
    kind: z.literal('lengthTarget'),
    min: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    unit: z.enum(['characters', 'words', 'bytes']),
  })
  .refine((v) => v.min <= v.max, { message: 'min must be <= max' });

const trackAFormatSchema = z.object({
  kind: z.literal('format'),
  // jsonArray is the ledger-shape gate (v90): forces the value to be a JSON
  // array. Empties (`[]`) are legal — that's the correct 0-due output for
  // settle/claim steps. Enforced only on steps that declare
  // settlesPredictionsFor or publishesClaimsTo (key-scoped to outputAs in
  // pre-tool-verifier.ts so other artifact keys in the same step aren't
  // affected). `json` (object) remains the default for non-ledger steps.
  value: z.enum(['markdown', 'json', 'text', 'jsonArray']),
});

const trackARequireHeadingSchema = z.object({
  kind: z.literal('requireHeading'),
  value: z.boolean(),
});

const trackAMimeSchema = z.object({
  kind: z.literal('mime'),
  declared: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+(\/)?$/i, {
    message: 'declared must be a valid MIME type (e.g. audio/mpeg, application/json)',
  }),
});

// --- Track B: file-on-disk rules ---

const trackBFileSizeBytesSchema = z
  .object({
    kind: z.literal('fileSizeBytes'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  })
  .refine((v) => v.min !== undefined || v.max !== undefined, {
    message: 'at least one of min/max required',
  })
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    { message: 'min must be <= max' },
  );

const trackBAudioZeroCrossingRatePerSSchema = z.object({
  kind: z.literal('audioZeroCrossingRatePerS'),
  max: z.number().positive(),
});

const trackBAudioDurationMsSchema = z
  .object({
    kind: z.literal('audioDurationMs'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  })
  .refine((v) => v.min !== undefined || v.max !== undefined, {
    message: 'at least one of min/max required',
  })
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    { message: 'min must be <= max' },
  );

// textContentForbidden (v91): rejects a published text artifact whose UTF-8
// content matches ANY of the given regex patterns. Track B (runs post-publish
// on publish_artifact_file). Purpose: keep machine-form handles out of
// listener-facing scripts — e.g. the broadcast (口播稿) must never voice a raw
// `预测ID` handle or a numeric `置信度 0.NN`, which are internal ledger
// plumbing (belief-ledger.ts buildSettlementSection/buildOpenQuestionsSection).
// Qualitative narration ("我看走眼了") has no number/handle and passes. Only
// text/* mime artifacts are scanned; non-text artifacts skip the rule.
const trackBTextContentForbiddenSchema = z.object({
  kind: z.literal('textContentForbidden'),
  patterns: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Regex source strings (case-insensitive) that MUST NOT appear in the published text artifact. ' +
        'Any match rejects the publish and forces a rewrite. Use for keeping internal machine handles ' +
        'out of listener-facing scripts — e.g. ["预测ID", "置信度\\\\s*\\\\d+(\\\\.\\\\d+)?%?"] bans a raw ' +
        'prediction-ID handle and a numeric confidence value from a broadcast (口播稿) script while ' +
        'still allowing qualitative phrasing.',
    ),
  label: z
    .string()
    .optional()
    .describe('Optional human-readable label surfaced in the violation reason.'),
});

// --- Combined discriminated union ---

export const ContractRuleItemSchema = z.discriminatedUnion('kind', [
  trackALengthTargetSchema,
  trackAFormatSchema,
  trackARequireHeadingSchema,
  trackAMimeSchema,
  trackBFileSizeBytesSchema,
  trackBAudioZeroCrossingRatePerSSchema,
  trackBAudioDurationMsSchema,
  trackBTextContentForbiddenSchema,
]);

export type ContractRule = z.infer<typeof ContractRuleItemSchema>;

export const ContractRuleSchema = z.array(ContractRuleItemSchema);

/**
 * Returns true for Track A rule kinds (content-checkable from tool_input.value).
 * Used by orchestrator-runner to partition rules when installing hooks.
 */
export function isTrackA(rule: ContractRule): boolean {
  return (
    rule.kind === 'lengthTarget' ||
    rule.kind === 'format' ||
    rule.kind === 'requireHeading' ||
    rule.kind === 'mime'
  );
}
