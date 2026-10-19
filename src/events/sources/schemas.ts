import { z } from "zod/v4";

/**
 * Per-sourceType config schema registry.
 * Adding a new source type: add an entry here + implement the source runtime handler
 * in src/events/sources/ + wire into startEventDefSource/stopEventDefSource in index.ts.
 * Tools (adam-tools.ts) and REST routes (event-defs.ts) both read from this registry
 * via getSourceTypeKeys() / getSourceConfigSchema() and require no edits.
 */
export const SOURCE_TYPE_REGISTRY = {
  webhook: z.object({}).strict(),
  manual: z.object({}).strict(),
  cron: z.object({
    cron: z.string().min(1, "cron expression required"),
    payload_template: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  directory_watch: z.object({
    path: z.string().min(1, "watch path required"),
    glob: z.string().optional(),
    stability_delay_ms: z.number().int().positive().optional(),
  }).strict(),
} as const;

export type SourceTypeKey = keyof typeof SOURCE_TYPE_REGISTRY;

/** Dynamic enum of registered source types — for Zod validation at tool / route layer. */
export function getSourceTypeKeys(): readonly SourceTypeKey[] {
  return Object.keys(SOURCE_TYPE_REGISTRY) as SourceTypeKey[];
}

/** Return the Zod schema for a given source type, or undefined if unknown. */
export function getSourceConfigSchema(sourceType: string): z.ZodTypeAny | undefined {
  return SOURCE_TYPE_REGISTRY[sourceType as SourceTypeKey];
}

/** Validate a sourceConfig against the registry entry for its sourceType. */
export function validateSourceConfig(
  sourceType: string,
  sourceConfig: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const schema = getSourceConfigSchema(sourceType);
  if (!schema) {
    return { ok: false, error: `Unknown sourceType: '${sourceType}'. Known: ${getSourceTypeKeys().join(", ")}` };
  }
  const result = schema.safeParse(sourceConfig ?? {});
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) };
  }
  return { ok: true, data: result.data };
}
