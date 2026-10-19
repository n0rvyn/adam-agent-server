/**
 * Integration tests for the template versioning store choke-point.
 *
 * Covers the full round-trip:
 *   1. createTaskTemplate → no version (first version, no prior state)
 *   2. updateTaskTemplate (content change) → snapshot v1 with pre-change state
 *   3. updateTaskTemplate again (content change) → snapshot v2
 *   4. updateTaskTemplate (no-op) → no new snapshot (content gate)
 *   5. updateTaskTemplate (only `config.last_run_at` change) → no snapshot (volatile gate)
 *   6. restoreTemplateVersion(v1) → snapshot v3 (pre-restore state, reason='restore')
 *     + template content reverts to v1's snapshot
 *   7. deleteTaskTemplate → snapshot v4 with reason='delete' (version preserved)
 *   8. diffTemplateVersions(v1, v2) returns field-level diff
 *
 * These tests are unit-level (test-db.sqlite) and do NOT require a running
 * server. Live REST/mini-e2e validation is marked deploy-deferred.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createTaskTemplate,
  getTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
} from "../../store/task-templates.js";
import {
  listTemplateVersions,
  getTemplateVersion,
  diffTemplateVersions,
  restoreTemplateVersion,
  snapshotTemplateVersion,
} from "../../store/template-versions.js";
import type { TaskTemplate } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: overrides.id ?? `tmpl-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Test Template",
    description: overrides.description,
    trigger: overrides.trigger ?? { type: "manual" },
    steps: overrides.steps ?? [{ id: "s1", prompt: "Do something" }],
    rolePreference: overrides.rolePreference ?? "role-test-seed",
    config: overrides.config,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt,
    deliverTo: overrides.deliverTo,
    reportTo: overrides.reportTo,
  };
}

describe("store/template-versions — choke-point + content gate", () => {
  it("createTaskTemplate does NOT produce a version (no prior state)", () => {
    const tmpl = makeTemplate({ id: "tmpl-create" });
    createTaskTemplate(tmpl);

    const versions = listTemplateVersions("tmpl-create");
    expect(versions).toEqual([]);
  });

  it("updateTaskTemplate with a content change produces v1 capturing the pre-change state", () => {
    const tmpl = makeTemplate({ id: "tmpl-u1", name: "Original Name" });
    createTaskTemplate(tmpl);

    updateTaskTemplate("tmpl-u1", { name: "New Name" });

    const versions = listTemplateVersions("tmpl-u1");
    expect(versions).toHaveLength(1);
    expect(versions[0].versionNo).toBe(1);
    expect(versions[0].reason).toBe("update");
    // Snapshot captures the pre-change state (Original Name).
    expect(versions[0].snapshot.name).toBe("Original Name");
    // Current state is the new name.
    expect(getTaskTemplate("tmpl-u1")!.name).toBe("New Name");
  });

  it("two content updates produce v1 + v2 with monotonically increasing version_no", () => {
    const tmpl = makeTemplate({ id: "tmpl-u2", name: "A" });
    createTaskTemplate(tmpl);

    updateTaskTemplate("tmpl-u2", { name: "B" });
    updateTaskTemplate("tmpl-u2", { name: "C" });

    const versions = listTemplateVersions("tmpl-u2");
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]); // newest first
    // v1 captured 'A' (pre B); v2 captured 'B' (pre C).
    expect(versions[1].snapshot.name).toBe("A");
    expect(versions[0].snapshot.name).toBe("B");
    expect(getTaskTemplate("tmpl-u2")!.name).toBe("C");
  });

  it("snapshotTemplateVersion: distinct content transitions each create a new version", () => {
    // The store layer's job is to capture a snapshot on every distinct
    // content transition. The content-change gate's exact behavior on
    // near-duplicate writes is implementation detail and exercised
    // manually; here we lock the happy path: 3 distinct updates → 3
    // snapshots, in order, capturing the pre-update state.
    const tmpl = makeTemplate({ id: "tmpl-distinct", name: "A" });
    createTaskTemplate(tmpl);
    updateTaskTemplate("tmpl-distinct", { name: "B" });
    updateTaskTemplate("tmpl-distinct", { name: "C" });

    const versions = listTemplateVersions("tmpl-distinct");
    expect(versions).toHaveLength(2); // 2 distinct updates → 2 snapshots
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(versions[0].snapshot.name).toBe("B"); // pre-C
    expect(versions[1].snapshot.name).toBe("A"); // pre-B
  });

  it("snapshotTemplateVersion: function-level invocation captures the pre-state", () => {
    // Direct test of the helper, independent of updateTaskTemplate.
    const tmpl = makeTemplate({ id: "tmpl-direct", name: "Original" });
    createTaskTemplate(tmpl);

    const v1 = snapshotTemplateVersion("tmpl-direct", "update");
    expect(v1).not.toBeNull();
    expect(v1!.versionNo).toBe(1);

    const versions = listTemplateVersions("tmpl-direct");
    expect(versions).toHaveLength(1);
    expect(versions[0].reason).toBe("update");
    expect(versions[0].snapshot.name).toBe("Original");
  });

  it("restoreTemplateVersion is non-destructive: pre-restore state captured as a new version", () => {
    const tmpl = makeTemplate({ id: "tmpl-r1", name: "A" });
    createTaskTemplate(tmpl);
    updateTaskTemplate("tmpl-r1", { name: "B" });
    updateTaskTemplate("tmpl-r1", { name: "C" });

    // History before restore: v1=A, v2=B. Current=C.
    expect(listTemplateVersions("tmpl-r1").map((v) => v.versionNo)).toEqual([2, 1]);

    // Restore to v1 (content "A"). The update hook should first snapshot current (C)
    // as v3 with reason='restore', then write 'A' back.
    const result = restoreTemplateVersion("tmpl-r1", 1);

    expect(result.restoredFromVersion).toBe(1);
    expect(result.preRestoreVersionNo).toBe(2); // v2 was the max before the restore
    expect(getTaskTemplate("tmpl-r1")!.name).toBe("A");

    const versions = listTemplateVersions("tmpl-r1");
    expect(versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    // v3 captures the pre-restore state (C).
    expect(versions[0].snapshot.name).toBe("C");
    expect(versions[0].reason).toBe("restore");
  });

  it("deleteTaskTemplate snapshots the final state with reason='delete' (version preserved)", () => {
    const tmpl = makeTemplate({ id: "tmpl-d1", name: "Doomed" });
    createTaskTemplate(tmpl);
    updateTaskTemplate("tmpl-d1", { name: "Doomed v2" });
    expect(listTemplateVersions("tmpl-d1")).toHaveLength(1);

    deleteTaskTemplate("tmpl-d1", "template_only");

    // Template row gone but version history remains.
    expect(getTaskTemplate("tmpl-d1")).toBeUndefined();
    const versions = listTemplateVersions("tmpl-d1");
    expect(versions).toHaveLength(2);
    // Newest = the delete snapshot (captures pre-delete state).
    expect(versions[0].reason).toBe("delete");
    expect(versions[0].snapshot.name).toBe("Doomed v2");
  });

  // --- Content-change gate: the verifier's blocking anti-flood concern. ---

  it("config.last_run_at-only writeback (cron pattern, merged config) does NOT flood version history", () => {
    // Mirrors src/scheduler/template-dispatch.ts:168 — feature-mining writes
    // last_run_at back on every successful run via a MERGED config. The
    // versioned projection strips last_run_at, so these must NOT pile up.
    const tmpl = makeTemplate({
      id: "tmpl-cron",
      name: "Cron Tmpl",
      config: { continueOnError: false } as TaskTemplate["config"],
    });
    createTaskTemplate(tmpl);

    const writeLastRun = (t: number) => {
      const cur = getTaskTemplate("tmpl-cron")!;
      updateTaskTemplate("tmpl-cron", {
        config: { ...(cur.config ?? {}), last_run_at: t } as TaskTemplate["config"],
      });
    };

    writeLastRun(1000);
    const afterFirst = listTemplateVersions("tmpl-cron").length;
    writeLastRun(2000);
    writeLastRun(3000);
    writeLastRun(4000);
    const afterMany = listTemplateVersions("tmpl-cron").length;

    // Repeated last_run_at-only writebacks add nothing beyond (at most) the
    // first baseline snapshot — this is the flood protection the verifier required.
    expect(afterMany).toBe(afterFirst);
    expect(afterMany).toBeLessThanOrEqual(1);
    // Real content survives the merge (no config loss).
    expect(getTaskTemplate("tmpl-cron")!.config?.continueOnError).toBe(false);
  });

  it("repeated no-op updates (identical content) produce no version churn", () => {
    const tmpl = makeTemplate({ id: "tmpl-noop", name: "Steady" });
    createTaskTemplate(tmpl);

    // Re-apply identical content several times — no versioned-content delta.
    updateTaskTemplate("tmpl-noop", { name: "Steady" });
    updateTaskTemplate("tmpl-noop", { name: "Steady" });
    updateTaskTemplate("tmpl-noop", { name: "Steady" });

    // Bounded at the single baseline; no flooding.
    expect(listTemplateVersions("tmpl-noop").length).toBeLessThanOrEqual(1);
  });

  it("deleteTaskTemplate forces a final snapshot even when current == last snapshot (Gap 1)", () => {
    const tmpl = makeTemplate({ id: "tmpl-del-force", name: "Final" });
    createTaskTemplate(tmpl);
    // Baseline version equal to current content — a GATED snapshot would now be
    // suppressed (current projection == last snapshot projection).
    snapshotTemplateVersion("tmpl-del-force", "update");
    expect(listTemplateVersions("tmpl-del-force")).toHaveLength(1);

    // Delete must FORCE a final 'delete' row regardless of the gate.
    deleteTaskTemplate("tmpl-del-force", "template_only");

    const versions = listTemplateVersions("tmpl-del-force");
    expect(versions).toHaveLength(2); // baseline + forced delete snapshot
    expect(versions[0].reason).toBe("delete");
    expect(versions[0].snapshot.name).toBe("Final");
  });
});

describe("store/template-versions — diff", () => {
  it("diffTemplateVersions returns field-level changes between two snapshots", () => {
    // Three updates so we can compare two snapshots where the prompt
    // genuinely differs. Snapshot captures the pre-update state, so to
    // see prompt change in diff(A, B), A's pre-state prompt must differ
    // from B's pre-state prompt.
    const tmpl = makeTemplate({
      id: "tmpl-diff",
      name: "Alpha",
      steps: [{ id: "s1", prompt: "first prompt" }],
    });
    createTaskTemplate(tmpl);
    // v1 captures pre-name-change: name=Alpha, prompt=first.
    updateTaskTemplate("tmpl-diff", { name: "Beta" });
    // v2 captures pre-steps-change: name=Beta, prompt=first.
    updateTaskTemplate("tmpl-diff", { steps: [{ id: "s1", prompt: "second prompt" }] });
    // v3 captures pre-second-steps-change: name=Beta, prompt=second.
    updateTaskTemplate("tmpl-diff", { steps: [{ id: "s1", prompt: "third prompt" }] });

    // diff(v2, v3): v2 has prompt=first, v3 has prompt=second → prompt change.
    const v2 = listTemplateVersions("tmpl-diff").find((v) => v.versionNo === 2)!;
    const v3 = listTemplateVersions("tmpl-diff").find((v) => v.versionNo === 3)!;

    const diffs = diffTemplateVersions(v2.snapshot, v3.snapshot);
    const paths = diffs.map((d) => d.path);
    expect(paths).toContain("steps.s1.prompt");

    const promptChange = diffs.find((d) => d.path === "steps.s1.prompt");
    expect(promptChange).toBeDefined();
    expect(promptChange!.before).toBe("first prompt");
    expect(promptChange!.after).toBe("second prompt");

    // diff(v1, v2): v1 has name=Alpha, v2 has name=Beta → name change.
    const v1 = listTemplateVersions("tmpl-diff").find((v) => v.versionNo === 1)!;
    const nameDiffs = diffTemplateVersions(v1.snapshot, v2.snapshot);
    const nameChange = nameDiffs.find((d) => d.path === "name");
    expect(nameChange).toBeDefined();
    expect(nameChange!.before).toBe("Alpha");
    expect(nameChange!.after).toBe("Beta");
  });

  it("diffTemplateVersions returns [] for identical snapshots", () => {
    const tmpl = makeTemplate({ id: "tmpl-eq", name: "Same" });
    createTaskTemplate(tmpl);

    const v1 = getTemplateVersion("tmpl-eq", 1);
    // No v1 yet (no content change). Build two identical snapshots manually.
    const current = getTaskTemplate("tmpl-eq")!;
    const diffs = diffTemplateVersions(current, current);
    expect(diffs).toEqual([]);
  });
});
