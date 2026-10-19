/**
 * Phase 1 seed: persona + outputContract for the two podcast cron templates.
 *
 * Pure logic only — no CLI / no env reads. Imported by:
 *   - scripts/seed-podcast-templates-phase1.ts (CLI wrapper)
 *   - src/__tests__/scripts/seed-podcast-templates-phase1.test.ts (in-memory DB test)
 *
 * Field mapping:
 *   Text-producing steps (达芬奇写稿 / digest / 快刀润色):
 *     persona.speakAs           = "卞旸"
 *     persona.voiceConstraints  = "自然口语、有观点态度、不要报菜名式陈列"
 *     outputContract.lengthTarget = { min: 2200, max: 2800, unit: "characters" }
 *     outputContract.format       = "markdown"
 *     outputContract.mustReferenceArtifacts = true
 *
 *   Audio / image steps (jay / picasso / audio):
 *     persona and outputContract are left unset (binary output, no first-person voice).
 *
 *   consumesFrom is intentionally NOT set explicitly — the assembler synthesises a
 *   soft consume from dependsOn (DP-000). Setting explicit consumesFrom would activate
 *   hard-fail on the first run after seed, which is a Phase 2/3 follow-up.
 */

import type Database from "better-sqlite3";
import { taskStepSchema } from "../server/routes/task-templates.js";
import type { TaskStep } from "../shared/types.js";

const TEMPLATE_IDS = [
  "95a97f8c-2168-4195-9188-e2245f1b4ff2",
  "3b696bb6-9d4a-463b-a9da-eb5c86cac8ed",
] as const;

const TEXT_PRODUCING_PATTERNS = [
  "达芬奇写稿",
  "digest",
  "快刀润色",
];

const BINARY_STEP_PATTERNS = [
  "jay",
  "picasso",
  "audio",
];

const PERSONA = {
  speakAs: "卞旸",
  voiceConstraints: "自然口语、有观点态度、不要报菜名式陈列",
};

const OUTPUT_CONTRACT = {
  contractRules: [
    { kind: "lengthTarget" as const, min: 2200, max: 2800, unit: "characters" as const },
    { kind: "format" as const, value: "markdown" as const },
  ],
  mustReferenceArtifacts: true,
};

/** Seeded lengthTarget min — used by the "already seeded?" idempotency check below. */
const SEEDED_LENGTH_MIN = 2200;

function isTextProducingStep(stepId: string): boolean {
  return TEXT_PRODUCING_PATTERNS.includes(stepId);
}

function isBinaryStep(stepId: string): boolean {
  return BINARY_STEP_PATTERNS.some((p) => stepId.toLowerCase().includes(p.toLowerCase()));
}

function seedStep(step: TaskStep, revert = false): TaskStep {
  if (isTextProducingStep(step.id)) {
    if (revert) {
      const { persona: _persona, outputContract: _oc, ...rest } = step as TaskStep & {
        persona: typeof PERSONA;
        outputContract: typeof OUTPUT_CONTRACT;
      };
      void _persona;
      void _oc;
      return rest as TaskStep;
    }
    const seededLengthRule = step.outputContract?.contractRules?.find((r) => r.kind === "lengthTarget");
    if (
      step.persona?.speakAs === PERSONA.speakAs &&
      seededLengthRule?.kind === "lengthTarget" &&
      seededLengthRule.min === SEEDED_LENGTH_MIN
    ) {
      return step;
    }
    return { ...step, persona: { ...PERSONA }, outputContract: { ...OUTPUT_CONTRACT } };
  }

  if (isBinaryStep(step.id)) {
    return step;
  }

  return step;
}

/**
 * Apply (or revert) Phase 1 new fields on all steps of both podcast templates.
 * Pure function — accepts any better-sqlite3 Database instance.
 */
export function applySeed(db: Database.Database, revert = false): void {
  const placeholders = TEMPLATE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, enabled, steps FROM task_templates WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...TEMPLATE_IDS) as Array<{ id: string; name: string; enabled: number; steps: string }>;

  if (rows.length !== TEMPLATE_IDS.length) {
    const found = rows.map((r) => r.id).join(", ");
    throw new Error(
      `Expected ${TEMPLATE_IDS.length} templates, found ${rows.length} (found: ${found || "none"})`,
    );
  }

  const now = Date.now();
  const serialized: Array<{ id: string; name: string; steps: string }> = [];

  for (const row of rows) {
    const originalSteps = JSON.parse(row.steps) as unknown as TaskStep[];
    const updatedSteps = originalSteps.map((step) => seedStep(step, revert));

    for (const step of updatedSteps) {
      taskStepSchema.parse(step);
    }

    const before = JSON.stringify(originalSteps);
    const after = JSON.stringify(updatedSteps);

    if (before === after) {
      process.stdout.write(`[no-change] ${row.id}  ${row.name}\n`);
    } else {
      const added = updatedSteps.filter(
        (s, i) => !originalSteps[i].persona && !!s.persona,
      );
      process.stdout.write(
        `[${revert ? "revert" : "apply"}] ${row.id}  ${row.name}  (${added.length} steps updated)\n`,
      );
    }

    serialized.push({ id: row.id, name: row.name, steps: after });
  }

  db.transaction(() => {
    const upsert = db.prepare(
      `UPDATE task_templates SET steps = ?, updated_at = ? WHERE id = ?`,
    );
    for (const row of serialized) {
      upsert.run(row.steps, now, row.id);
    }
  })();
}

/**
 * Phase 4 counterpart to applySeed.
 * Seeds config.delivery on the two podcast cron templates.
 *
 * See applySeed JSDoc for Phase 1 field documentation.
 *
 * applyDeliverySeed is idempotent: when a row already has the target delivery config,
 * it logs "[no-change-delivery]" and skips the UPDATE.
 * Revertable via applyDeliverySeed(db, true).
 *
 * Even when reverting, other config keys (continueOnError, delivery_message_type, mcpServers, etc.)
 * are preserved — only the "delivery" key is removed.
 *
 * Even when the template row has no config at all (config IS NULL), revert is safe:
 * destructuring { delivery: _d, ...rest } on a non-object yields {} and no delivery key exists to remove.
 */

const PRIMARY_ARTIFACT_REFS: Record<typeof TEMPLATE_IDS[number], { stepId: string }> = {
  "95a97f8c-2168-4195-9188-e2245f1b4ff2": { stepId: "快刀润色" }, // Morning — key resolved from step.outputAs at delivery time
  "3b696bb6-9d4a-463b-a9da-eb5c86cac8ed": { stepId: "快刀润色" }, // Evening — key resolved from step.outputAs at delivery time
};

export function applyDeliverySeed(db: Database.Database, revert = false): void {
  const placeholders = TEMPLATE_IDS.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, name, config FROM task_templates WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...TEMPLATE_IDS) as Array<{ id: string; name: string; config: string | null }>;

  if (rows.length !== TEMPLATE_IDS.length) {
    const found = rows.map((r) => r.id).join(", ");
    throw new Error(`Expected ${TEMPLATE_IDS.length} templates, found ${rows.length} (found: ${found || "none"})`);
  }

  const now = Date.now();
  const updates: Array<{ id: string; name: string; config: string }> = [];

  for (const row of rows) {
    const ref = PRIMARY_ARTIFACT_REFS[row.id as typeof TEMPLATE_IDS[number]];
    const existingConfig = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    const existingDelivery = existingConfig.delivery as { mode?: string; primaryArtifact?: { stepId?: string; key?: string | null } } | undefined;

    let nextConfig: Record<string, unknown>;
    if (revert) {
      // Remove delivery field; preserve other config keys
      const { delivery: _d, ...rest } = existingConfig;
      void _d;
      nextConfig = rest;
    } else {
      const nextDelivery = { mode: "primary-artifact", primaryArtifact: { stepId: ref.stepId } };
      // Idempotent: skip if already seeded with the same config (mode + stepId, no key)
      if (
        existingDelivery?.mode === "primary-artifact" &&
        existingDelivery?.primaryArtifact?.stepId === ref.stepId &&
        existingDelivery?.primaryArtifact?.key === undefined
      ) {
        process.stdout.write(`[no-change-delivery] ${row.id}  ${row.name}\n`);
        continue;
      }
      nextConfig = { ...existingConfig, delivery: nextDelivery };
    }

    process.stdout.write(`[${revert ? "revert-delivery" : "apply-delivery"}] ${row.id}  ${row.name}\n`);
    updates.push({ id: row.id, name: row.name, config: JSON.stringify(nextConfig) });
  }

  if (updates.length > 0) {
    db.transaction(() => {
      const upsert = db.prepare(`UPDATE task_templates SET config = ?, updated_at = ? WHERE id = ?`);
      for (const u of updates) {
        upsert.run(u.config, now, u.id);
      }
    })();
  }
}

const AUDIO_ASSERTIONS = [
  "audio.duration_s between 600 and 1800",
  "audio.zc_rate_per_s < 5000",
  "audio.rms > 0.01",
] as const;

/**
 * Phase 5 counterpart: seed audio-step assertions onto the two podcast cron templates.
 *
 * Idempotent: when the audio step already has exactly the three assertions, logs
 * "[no-change-assertions]" and skips the UPDATE.  Revertable via applyAssertionsSeed(db, true).
 */
export function applyAssertionsSeed(db: Database.Database, revert = false): void {
  for (const id of TEMPLATE_IDS) {
    const row = db.prepare("SELECT steps FROM task_templates WHERE id = ?").get(id) as { steps: string } | undefined;
    if (!row) {
      process.stdout.write(`[skip] template ${id} not found\n`);
      continue;
    }
    const steps = JSON.parse(row.steps) as TaskStep[];
    let changed = false;

    const next = steps.map((step) => {
      if (!isBinaryStep(step.id) || !step.id.toLowerCase().includes("audio")) return step;
      if (revert) {
        const { assertions: _a, ...rest } = step as TaskStep & { assertions?: string[] };
        void _a;
        if ("assertions" in step) changed = true;
        return rest as TaskStep;
      }
      const wanted = [...AUDIO_ASSERTIONS];
      const current = (step as TaskStep & { assertions?: string[] }).assertions ?? [];
      if (current.length === wanted.length && current.every((c, i) => c === wanted[i])) return step;
      changed = true;
      return { ...step, assertions: wanted };
    });

    if (!changed) {
      process.stdout.write(`[no-change-assertions] template ${id}\n`);
      continue;
    }
    db.prepare("UPDATE task_templates SET steps = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(next),
      Date.now(),
      id,
    );
    process.stdout.write(`[updated-assertions] template ${id}\n`);
  }
}
