import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));
vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(),
  getRoleWorkspacePath: vi.fn(),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => []),
  getArtifact: vi.fn(() => null),
}));
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual };
});
vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));
vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
}));

import { applyAssertionsSeed } from "../../lib/seed-podcast-templates.js";

afterAll(() => cleanup());

const MORNING_ID = "95a97f8c-2168-4195-9188-e2245f1b4ff2";
const EVENING_ID = "3b696bb6-9d4a-463b-a9da-eb5c86cac8ed";
const AUDIO_ASSERTIONS = [
  "audio.duration_s between 600 and 1800",
  "audio.zc_rate_per_s < 5000",
  "audio.rms > 0.01",
] as const;

function insertTemplate(
  db: ReturnType<typeof setupTestDb>["db"],
  id: string,
  name: string,
  steps: string,
) {
  db.prepare(`
    INSERT INTO task_templates (id, name, trigger_type, steps, config, enabled, created_at, updated_at)
    VALUES (?, ?, 'cron', ?, NULL, 1, ?, ?)
  `).run(id, name, steps, Date.now(), Date.now());
}

describe("applyAssertionsSeed", () => {
  beforeEach(() => {
    clearTestDb();
  });

  it("applies three assertions to audio step", () => {
    const db = getTestDb();
    insertTemplate(
      db,
      MORNING_ID,
      "每日综合播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );
    insertTemplate(
      db,
      EVENING_ID,
      "晚间播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );

    applyAssertionsSeed(db);

    const morningRow = db
      .prepare("SELECT steps FROM task_templates WHERE id = ?")
      .get(MORNING_ID) as { steps: string } | undefined;
    expect(morningRow).toBeDefined();
    const morningSteps = JSON.parse(morningRow!.steps);
    expect(morningSteps[0].assertions).toEqual([...AUDIO_ASSERTIONS]);

    const eveningRow = db
      .prepare("SELECT steps FROM task_templates WHERE id = ?")
      .get(EVENING_ID) as { steps: string } | undefined;
    expect(eveningRow).toBeDefined();
    const eveningSteps = JSON.parse(eveningRow!.steps);
    expect(eveningSteps[0].assertions).toEqual([...AUDIO_ASSERTIONS]);
  });

  it("does not touch text or image steps", () => {
    const db = getTestDb();
    insertTemplate(
      db,
      MORNING_ID,
      "每日综合播客流水线",
      JSON.stringify([
        { id: "达芬奇写稿", prompt: "write script" },
        { id: "jay", prompt: "generate audio via jay" },
        { id: "picasso", prompt: "generate image" },
        { id: "audio", prompt: "generate audio" },
      ]),
    );
    insertTemplate(db, EVENING_ID, "晚间播客流水线", JSON.stringify([{ id: "digest", prompt: "digest" }]));

    applyAssertionsSeed(db);

    const row = db
      .prepare("SELECT steps FROM task_templates WHERE id = ?")
      .get(MORNING_ID) as { steps: string };
    const steps = JSON.parse(row.steps);
    expect(steps[0]).not.toHaveProperty("assertions"); // 达芬奇写稿
    expect(steps[1]).not.toHaveProperty("assertions"); // jay
    expect(steps[2]).not.toHaveProperty("assertions"); // picasso
    expect(steps[3].assertions).toEqual([...AUDIO_ASSERTIONS]); // audio
  });

  it("idempotent — second apply no change", () => {
    const db = getTestDb();
    insertTemplate(
      db,
      MORNING_ID,
      "每日综合播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );
    insertTemplate(
      db,
      EVENING_ID,
      "晚间播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => { logs.push(chunk); return true; };

    try {
      applyAssertionsSeed(db); // first
      const updatedAt1 = (
        db.prepare("SELECT updated_at FROM task_templates WHERE id = ?").get(MORNING_ID) as { updated_at: number }
      ).updated_at;
      applyAssertionsSeed(db); // second — no-change
      const updatedAt2 = (
        db.prepare("SELECT updated_at FROM task_templates WHERE id = ?").get(MORNING_ID) as { updated_at: number }
      ).updated_at;
      expect(updatedAt1).toBe(updatedAt2);
      expect(logs.join("")).toContain("[no-change-assertions]");
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("revert removes assertions from audio step", () => {
    const db = getTestDb();
    insertTemplate(
      db,
      MORNING_ID,
      "每日综合播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );
    insertTemplate(
      db,
      EVENING_ID,
      "晚间播客流水线",
      JSON.stringify([{ id: "audio", prompt: "generate audio" }]),
    );

    applyAssertionsSeed(db); // apply
    applyAssertionsSeed(db, true); // revert

    const row = db
      .prepare("SELECT steps FROM task_templates WHERE id = ?")
      .get(MORNING_ID) as { steps: string };
    const steps = JSON.parse(row.steps);
    expect(steps[0]).not.toHaveProperty("assertions");
  });

  it("skips missing templates without throwing", () => {
    const db = getTestDb();
    // Do NOT insert any templates — both MORNING_ID and EVENING_ID are absent

    expect(() => applyAssertionsSeed(db)).not.toThrow();

    // Verify no steps JSON was written
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM task_templates")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
