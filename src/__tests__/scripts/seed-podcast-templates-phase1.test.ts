/**
 * Unit tests for scripts/seed-podcast-templates-phase1.ts
 *
 * Covers:
 *  - applySeed adds persona + outputContract to text-producing steps
 *  - applySeed leaves binary (audio/image) steps unchanged
 *  - Idempotency: re-running produces no diff
 *  - --revert strips the new fields
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Intercept getDb so that if the script ever calls it (e.g. main path), it hits the test DB.
// applySeed itself is pure and takes db as a param, so no production DB access occurs in tests.
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { applySeed } from "../../lib/seed-podcast-templates.js";

// ---------------------------------------------------------------------------
// Test fixtures — mirrors the production step structure
// ---------------------------------------------------------------------------

const MORNING_STEPS = [
  {
    id: "达芬奇采集",
    prompt: "你是达芬奇。统一编排本期播客的全部素材收集…",
    roleId: "role-bb94548e",
    dependsOn: [],
    outputAs: "素材摘要",
  },
  {
    id: "达芬奇写稿",
    prompt: "你是达芬奇。基于素材摘要写成播客文字稿…",
    roleId: "role-bb94548e",
    dependsOn: ["达芬奇采集"],
    outputAs: "播客草稿",
  },
  {
    id: "快刀润色",
    prompt: "你是快刀青衣。润色播客草稿…",
    roleId: "role-a81e79ad",
    dependsOn: ["达芬奇写稿"],
    outputAs: "最终逐字稿",
  },
  {
    id: "jay",
    prompt: "你是周杰伦。读取最终逐字稿，生成播客音频…",
    roleId: "role-fd54cceb",
    dependsOn: ["快刀润色"],
    outputAs: "audio-files",
  },
  {
    id: "picasso",
    prompt: "你是毕加索。读取播客主题，生成 10 张风格完全不同的配图。",
    roleId: "role-ccdc6aee",
    dependsOn: ["快刀润色"],
    outputAs: "artworks",
  },
];

const EVENING_STEPS = [
  {
    id: "vault-scan",
    prompt: "你是达芬奇。聚焦今日知识沉淀与脑洞…",
    roleId: "role-bb94548e",
    dependsOn: [],
    outputAs: "knowledge-materials",
  },
  {
    id: "digest",
    prompt: "你是达芬奇。基于素材写成播客文字稿（约2500字，15分钟音频）…",
    roleId: "role-bb94548e",
    dependsOn: ["vault-scan"],
    outputAs: "podcast-script",
  },
  {
    id: "快刀润色",
    prompt: "你是快刀青衣。润色播客文字稿，以卞旸身份…",
    roleId: "role-a81e79ad",
    dependsOn: ["digest"],
    outputAs: "final-script",
  },
  {
    id: "audio",
    prompt: "你是周杰伦。读取最终逐字稿，生成播客音频…",
    roleId: "role-fd54cceb",
    dependsOn: ["快刀润色"],
    outputAs: "audio-file",
  },
];

const MORNING_TEMPLATE_ID = "95a97f8c-2168-4195-9188-e2245f1b4ff2";
const EVENING_TEMPLATE_ID = "3b696bb6-9d4a-463b-a9da-eb5c86cac8ed";

const NOW = 1_750_000_000_000;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const { cleanup } = setupTestDb();

function insertTemplate(
  db: Database.Database,
  id: string,
  name: string,
  steps: object[],
): void {
  // Upsert — delete first so tests can re-run without UNIQUE constraint errors.
  db.prepare("DELETE FROM task_templates WHERE id = ?").run(id);
  db.prepare(`
    INSERT INTO task_templates (id, name, description, trigger_type, trigger_cron, steps, enabled, created_at)
    VALUES (?, ?, ?, 'cron', '0 7 * * *', ?, 1, ?)
  `).run(id, name, "test template", JSON.stringify(steps), NOW);
}

function getSteps(db: Database.Database, id: string): Array<{ id: string; [key: string]: unknown }> {
  const row = db
    .prepare("SELECT steps FROM task_templates WHERE id = ?")
    .get(id) as { steps: string } | undefined;
  return JSON.parse(row!.steps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applySeed — add persona + outputContract", () => {
  beforeEach(() => {
    const db = getTestDb();
    insertTemplate(db, MORNING_TEMPLATE_ID, "每日综合播客流水线", MORNING_STEPS);
    insertTemplate(db, EVENING_TEMPLATE_ID, "晚间播客流水线", EVENING_STEPS);
  });

  it("adds persona + outputContract to text-producing steps", () => {
    const db = getTestDb();
    applySeed(db);

    // 达芬奇写稿 — morning
    const morningSteps = getSteps(db, MORNING_TEMPLATE_ID) as Record<string, unknown>[];
    const daVinciStep = morningSteps.find((s) => s.id === "达芬奇写稿")!;
    expect(daVinciStep).toHaveProperty("persona");
    expect((daVinciStep.persona as Record<string, unknown>).speakAs).toBe("卞旸");
    expect((daVinciStep.persona as Record<string, unknown>).voiceConstraints).toBe(
      "自然口语、有观点态度、不要报菜名式陈列",
    );
    expect(daVinciStep).toHaveProperty("outputContract");
    // Single-vocabulary pure design: the seeded contract is contractRules, not the removed
    // lengthTarget/format fields.
    const daVinciRules = (daVinciStep.outputContract as Record<string, unknown>).contractRules as Array<Record<string, unknown>>;
    const lengthRule = daVinciRules.find((r) => r.kind === "lengthTarget")!;
    expect(lengthRule.min).toBe(2200);
    expect(lengthRule.max).toBe(2800);
    expect(lengthRule.unit).toBe("characters");
    const formatRule = daVinciRules.find((r) => r.kind === "format")!;
    expect(formatRule.value).toBe("markdown");
    expect((daVinciStep.outputContract as Record<string, unknown>).mustReferenceArtifacts).toBe(true);

    // 快刀润色 — morning
    const kuaidaoMorning = morningSteps.find((s) => s.id === "快刀润色")!;
    expect((kuaidaoMorning.persona as Record<string, unknown>).speakAs).toBe("卞旸");

    // digest — evening
    const eveningSteps = getSteps(db, EVENING_TEMPLATE_ID) as Record<string, unknown>[];
    const digestStep = eveningSteps.find((s) => s.id === "digest")!;
    expect((digestStep.persona as Record<string, unknown>).speakAs).toBe("卞旸");

    // 快刀润色 — evening
    const kuaidaoEvening = eveningSteps.find((s) => s.id === "快刀润色")!;
    expect((kuaidaoEvening.persona as Record<string, unknown>).speakAs).toBe("卞旸");
  });

  it("leaves audio/image steps unchanged", () => {
    const db = getTestDb();
    applySeed(db);

    const morningSteps = getSteps(db, MORNING_TEMPLATE_ID) as Record<string, unknown>[];
    const jayStep = morningSteps.find((s) => s.id === "jay")!;
    const picassoStep = morningSteps.find((s) => s.id === "picasso")!;
    expect(jayStep).not.toHaveProperty("persona");
    expect(jayStep).not.toHaveProperty("outputContract");
    expect(picassoStep).not.toHaveProperty("persona");
    expect(picassoStep).not.toHaveProperty("outputContract");

    const eveningSteps = getSteps(db, EVENING_TEMPLATE_ID) as Record<string, unknown>[];
    const audioStep = eveningSteps.find((s) => s.id === "audio")!;
    expect(audioStep).not.toHaveProperty("persona");
    expect(audioStep).not.toHaveProperty("outputContract");
  });

  it("does not set consumesFrom explicitly", () => {
    const db = getTestDb();
    applySeed(db);

    const morningSteps = getSteps(db, MORNING_TEMPLATE_ID) as Record<string, unknown>[];
    for (const step of morningSteps) {
      expect(step).not.toHaveProperty("consumesFrom");
    }
  });

  it("is idempotent — re-running produces no diff", () => {
    const db = getTestDb();
    applySeed(db);
    const afterFirst = JSON.stringify(getSteps(db, MORNING_TEMPLATE_ID));
    applySeed(db);
    const afterSecond = JSON.stringify(getSteps(db, MORNING_TEMPLATE_ID));
    expect(afterSecond).toBe(afterFirst);
  });

  it("revert strips persona and outputContract", () => {
    const db = getTestDb();
    applySeed(db);
    applySeed(db, true); // revert

    const morningSteps = getSteps(db, MORNING_TEMPLATE_ID) as Record<string, unknown>[];
    const daVinciStep = morningSteps.find((s) => s.id === "达芬奇写稿")!;
    expect(daVinciStep).not.toHaveProperty("persona");
    expect(daVinciStep).not.toHaveProperty("outputContract");

    const digestStep = (
      getSteps(db, EVENING_TEMPLATE_ID) as Record<string, unknown>[]
    ).find((s) => s.id === "digest")!;
    expect(digestStep).not.toHaveProperty("persona");
    expect(digestStep).not.toHaveProperty("outputContract");
  });

  it("revert is idempotent — re-running revert produces no diff", () => {
    const db = getTestDb();
    applySeed(db);
    applySeed(db, true);
    const afterRevert = JSON.stringify(getSteps(db, MORNING_TEMPLATE_ID));
    applySeed(db, true);
    const afterSecondRevert = JSON.stringify(getSteps(db, MORNING_TEMPLATE_ID));
    expect(afterSecondRevert).toBe(afterRevert);
  });

  it("apply after revert re-adds the fields", () => {
    const db = getTestDb();
    applySeed(db);
    applySeed(db, true);
    applySeed(db); // re-apply

    const morningSteps = getSteps(db, MORNING_TEMPLATE_ID) as Record<string, unknown>[];
    const daVinciStep = morningSteps.find((s) => s.id === "达芬奇写稿")!;
    expect((daVinciStep.persona as Record<string, unknown>).speakAs).toBe("卞旸");
    const reappliedRules = (daVinciStep.outputContract as Record<string, unknown>).contractRules as Array<Record<string, unknown>>;
    const reappliedLength = reappliedRules.find((r) => r.kind === "lengthTarget")!;
    expect(reappliedLength.min).toBe(2200);
  });

  it("throws when a template ID is not found", () => {
    const db = getTestDb();
    // Remove the morning template
    db.prepare("DELETE FROM task_templates WHERE id = ?").run(MORNING_TEMPLATE_ID);
    expect(() => applySeed(db)).toThrow(/expected 2 templates/i);
  });

  it("non-matching step IDs are left completely unchanged", () => {
    const db = getTestDb();

    // vault-scan and 达芬奇采集 have no matching pattern — they should stay as-is
    const vaultScanOriginal = JSON.stringify(
      MORNING_STEPS.find((s) => s.id === "达芬奇采集"),
    );
    applySeed(db);
    const afterSteps = getSteps(db, MORNING_TEMPLATE_ID);
    const daVinciCollect = afterSteps.find((s) => s.id === "达芬奇采集");
    void vaultScanOriginal; // used in assertion below
    expect(JSON.stringify(daVinciCollect)).toBe(vaultScanOriginal);

    const eveningSteps = getSteps(db, EVENING_TEMPLATE_ID);
    const vaultScan = eveningSteps.find((s) => s.id === "vault-scan");
    const vaultScanOriginalEvening = JSON.stringify(
      EVENING_STEPS.find((s) => s.id === "vault-scan"),
    );
    expect(JSON.stringify(vaultScan)).toBe(vaultScanOriginalEvening);
  });
});

afterAll(() => {
  cleanup();
});
