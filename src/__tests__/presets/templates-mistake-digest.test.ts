import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import { seedPresets, restorePreset, TEMPLATE_PRESETS } from "../../presets/index.js";

// Mock the filesystem-dependent workspace functions
vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-role-workspace"),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the audit aggregator so the digester role can be seeded
vi.mock("../../audit/mistake-aggregator.js", () => ({
  aggregateMistakes: vi.fn().mockResolvedValue({ patternsUpserted: 0, totalEventsScanned: 0, dimensionCounts: {} }),
}));

// Mock the audit-tools MCP factory (used by role-mcp-registry when binding mistake-digester)
vi.mock("../../manager/audit-tools.js", () => ({
  createAuditTools: vi.fn(() => ({ name: "audit-tools", version: "1.0.0", tools: [] })),
}));

describe("mistake-digest template preset", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  it("template exists in TEMPLATE_PRESETS with presetId=mistake-digest", () => {
    const t = TEMPLATE_PRESETS.find((t) => t.presetId === "mistake-digest");
    expect(t).toBeDefined();
    expect(t!.presetId).toBe("mistake-digest");
  });

  it("trigger is cron with expression 0 8 * * 0", () => {
    const t = TEMPLATE_PRESETS.find((t) => t.presetId === "mistake-digest")!;
    expect(t.trigger).toEqual({ type: "cron", cron: "0 8 * * 0" });
  });

  it("boundRolePresetId equals mistake-digester", () => {
    const t = TEMPLATE_PRESETS.find((t) => t.presetId === "mistake-digest")!;
    expect(t.boundRolePresetId).toBe("mistake-digester");
  });

  it("config.delivery_message_type equals mistake_digest", () => {
    const t = TEMPLATE_PRESETS.find((t) => t.presetId === "mistake-digest")!;
    expect(t.config?.delivery_message_type).toBe("mistake_digest");
  });

  it("seedPresets creates both the Role and Template; re-seed is idempotent", () => {
    const r1 = seedPresets();
    expect(r1.rolesCreated).toBeGreaterThan(0);
    expect(r1.templatesCreated).toBeGreaterThan(0);

    const r2 = seedPresets();
    expect(r2.rolesCreated).toBe(0);
    expect(r2.templatesCreated).toBe(0);
  });

  it("seedPresets seeds Template with undefined deliverTo (user configures post-seed)", () => {
    seedPresets();
    // Verify by querying the DB directly (avoids module-level mock complications)
    const db = getTestDb();
    const rows = db.prepare("SELECT deliver_to FROM task_templates WHERE preset_id = ?").all("mistake-digest") as { deliver_to: string | null }[];
    expect(rows).toHaveLength(1);
    // deliver_to is NULL in DB for templates seeded without a deliverTo value
    expect(rows[0].deliver_to).toBeNull();
  });

  it("restorePreset(template, mistake-digest) self-heals missing Role before resolving", () => {
    // Never seed — go straight to restore
    const result = restorePreset("template", "mistake-digest");
    expect(result.ok).toBe(true);

    // The bound Role should also be re-created — check DB directly
    const db = getTestDb();
    const roles = db.prepare("SELECT preset_id FROM roles WHERE name = ?").all("Mistake Digester") as { preset_id: string }[];
    expect(roles).toHaveLength(1);
    expect(roles[0].preset_id).toBe("mistake-digester");
  });

  it("user-edited Template name is restored to canonical on restorePreset", () => {
    seedPresets();
    // Get the template id, then update its name directly in DB
    const db = getTestDb();
    const rows = db.prepare("SELECT id FROM task_templates WHERE preset_id = ?").all("mistake-digest") as { id: string }[];
    expect(rows).toHaveLength(1);
    const templateId = rows[0].id;

    // Simulate user editing the name
    db.prepare("UPDATE task_templates SET name = ? WHERE id = ?").run("My Custom Digest Name", templateId);

    restorePreset("template", "mistake-digest");

    const restored = db.prepare("SELECT name FROM task_templates WHERE preset_id = ?").get("mistake-digest") as { name: string } | undefined;
    expect(restored).toBeDefined();
    expect(restored!.name).toBe("Mistake Digest (preset)");
  });
});
