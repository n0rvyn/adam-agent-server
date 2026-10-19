import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";
import { seedPresets, restorePreset, CHAT_MANAGER_ROLE_ID } from "../../presets/index.js";

// Mock the filesystem-dependent workspace functions
vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => "/tmp/test-role-workspace"),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

describe("presets seed + restore", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  it("seedPresets creates rows when DB is empty", () => {
    const result = seedPresets();
    expect(result.rolesCreated).toBeGreaterThan(0);
  });

  it("seedPresets is idempotent (second call inserts 0)", () => {
    seedPresets();
    const result2 = seedPresets();
    expect(result2.rolesCreated).toBe(0);
    expect(result2.templatesCreated).toBe(0);
  });

  it("restorePreset role/nonexistent returns ok:false", () => {
    seedPresets();
    const result = restorePreset("role", "nonexistent-preset");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("restorePreset role/feature-miner works on existing row", () => {
    seedPresets();
    // User edits CAG — confirmed in the row before restore
    const result = restorePreset("role", "feature-miner");
    expect(result.ok).toBe(true);
  });

  it("restorePreset role/feature-miner on missing Role re-creates it", () => {
    // Never seed — go straight to restore
    const result = restorePreset("role", "feature-miner");
    expect(result.ok).toBe(true);
  });

  it("restorePreset template/feature-mining works for extant template", () => {
    seedPresets();
    const result = restorePreset("template", "feature-mining");
    expect(result.ok).toBe(true);
  });

  it("restorePreset template/feature-mining on missing template re-creates it", () => {
    const result = restorePreset("template", "feature-mining");
    expect(result.ok).toBe(true);
  });

  it("chat-manager preset uses fixed ID role-chat-manager not uuid", () => {
    seedPresets();
    expect(CHAT_MANAGER_ROLE_ID).toBe("role-chat-manager");
  });
});
