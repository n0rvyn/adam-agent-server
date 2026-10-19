import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";

// CRITICAL: vi.mock must be at module top, before importing anything that uses store/db.
// Pattern copied from src/__tests__/agent/learner.test.ts:6-10.
vi.mock("../../store/db.js", async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  const { db } = setupTestDb();
  return { getDb: () => db, closeDb: () => {} };
});

import { clearTestDb } from "../helpers/test-db.js";
import { createRole, getRoleByName } from "../../store/roles.js";
import { listEvolutionAuditByRole } from "../../store/evolution-audit.js";
import { cleanupRoleLearnedRules } from "../../agent/role-rule-cleanup.js";
import type { Role } from "../../shared/types.js";

/** Build a minimum valid Role with required NOT NULL fields populated. */
function buildRole(overrides: Partial<Role> & { name: string }): Role {
  const { name, ...rest } = overrides;
  return {
    id: uuidv4(),
    name,
    cagPrompt: rest.cagPrompt ?? "Test cagPrompt",
    learnedRules: rest.learnedRules ?? { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: uuidv4(),
    status: "active",
    preferences: {} as any,
    createdAt: Date.now(),
    ...rest,
  };
}

describe("cleanupRoleLearnedRules", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "rule-cleanup-test-"));
    process.env.ADAM_TEST_DIR = testDir;
    clearTestDb();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.ADAM_TEST_DIR;
  });

  it("removes matching entries and keeps unrelated ones", () => {
    const role = buildRole({
      name: "TestRole1",
      learnedRules: { stylePreferences: [
        '[-] Planned step "cp /path/to/template.html foo" was skipped during "task A"',
        '[-] Planned step "mkdir -p ~/.claude/session-reflect/reflections" was skipped',
        '[-] Unrelated mkdir for minimax-quota was skipped',
        "[+] Genuine human-curated rule about workflow",
      ], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);

    const result = cleanupRoleLearnedRules(role.name, [
      /cp\b.*template\.html/,
      /mkdir.*session-reflect/,
    ]);

    expect(result.removedCount).toBe(2);
    expect(result.remainingCount).toBe(2);
    const updated = getRoleByName(role.name)!;
    expect(updated.learnedRules.stylePreferences).toEqual([
      '[-] Unrelated mkdir for minimax-quota was skipped',
      "[+] Genuine human-curated rule about workflow",
    ]);
  });

  it("appends an addRule when provided and not already present", () => {
    const role = buildRole({
      name: "TestRole2",
      learnedRules: { stylePreferences: ['[-] Planned step "cp template.html" was skipped'], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);

    const result = cleanupRoleLearnedRules(role.name, [/cp.*template/], {
      addRule: "[+] 用 full-session-review 跑日报+反思",
    });

    expect(result.removedCount).toBe(1);
    expect(result.addedRule).toBe("[+] 用 full-session-review 跑日报+反思");
    const updated = getRoleByName(role.name)!;
    expect(updated.learnedRules.stylePreferences).toContain("[+] 用 full-session-review 跑日报+反思");
  });

  it("does not duplicate addRule on re-run", () => {
    const role = buildRole({
      name: "TestRole3",
      learnedRules: { stylePreferences: ["[+] EXISTING RULE"], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);
    cleanupRoleLearnedRules(role.name, [/never-matches/], { addRule: "[+] EXISTING RULE" });
    const updated = getRoleByName(role.name)!;
    expect(updated.learnedRules.stylePreferences.filter((r: string) => r === "[+] EXISTING RULE").length).toBe(1);
  });

  it("regenerates the role CLAUDE.md file (and creates workspace dir if missing)", () => {
    const role = buildRole({
      name: "TestRole4",
      cagPrompt: "I am Test",
      learnedRules: { stylePreferences: ['[-] Planned step "cp template.html" was skipped'], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);
    const claudePath = join(testDir, "roles", "TestRole4", "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(false); // workspace not yet created
    cleanupRoleLearnedRules(role.name, [/cp.*template/]);
    expect(existsSync(claudePath)).toBe(true); // ensureRoleWorkspace created it
    const claude = readFileSync(claudePath, "utf-8");
    expect(claude).not.toContain("cp template.html");
    expect(claude).toContain("(none yet)");
  });

  it("inserts an evolution_audit row with correct source", () => {
    const role = buildRole({
      name: "TestRole5",
      learnedRules: { stylePreferences: ['[-] Planned step "cp template.html" was skipped'], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);
    cleanupRoleLearnedRules(role.name, [/cp.*template/], { source: "phase-5-cleanup" });
    const audits = listEvolutionAuditByRole(role.id);
    expect(audits.length).toBe(1);
    expect(audits[0].source).toBe("phase-5-cleanup");
    expect(audits[0].diff).toContain("- ");
  });

  it("is idempotent: no-op when nothing matches and no addRule", () => {
    const role = buildRole({
      name: "TestRole6",
      learnedRules: { stylePreferences: ["[+] Rule that does not match"], avoidedActions: [], pinnedParameters: [] },
    });
    createRole(role);
    const result = cleanupRoleLearnedRules(role.name, [/never-matches/]);
    expect(result.removedCount).toBe(0);
    expect(result.addedRule).toBeNull();
    const audits = listEvolutionAuditByRole(role.id);
    expect(audits.length).toBe(0);
  });

  it("throws on unknown role", () => {
    expect(() => cleanupRoleLearnedRules("DoesNotExist", [])).toThrow(/not found/);
  });
});
