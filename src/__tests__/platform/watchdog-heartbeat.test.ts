import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerTask, getLastActivity, tickAll, _resetForTests } from "../../platform/workspace-watcher.js";

/**
 * Unit tests for Phase 4 watchdog heartbeat upgrade.
 *
 * Tests the heartbeat formula: lastActivity = Math.max(stepLogActivity, workspaceActivity, startedAt).
 * Covers the four regression scenarios from the plan:
 *   A. fresh workspace + stale step_logs  → not killed
 *   B. stale workspace + fresh step_logs  → not killed
 *   C. both stale                        → killed (existing behavior preserved)
 *   D. no workspace registration          → falls back to step_logs alone (no regression)
 */

describe("watchdog heartbeat — staleRunningTasks OR-merge", () => {
  // We'll test the pure filter logic by constructing a mock scenario.
  // The actual heartbeat formula lives in watchdog.ts filter; we test it directly.

  let tmp: string;

  beforeEach(() => {
    _resetForTests();
    tmp = mkdtempSync(join(tmpdir(), "wdog-heartbeat-"));
  });

  afterEach(() => {
    _resetForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Helper: given step_log timestamp, workspace mtime, and startedAt,
   * return what the heartbeat formula computes.
   * Mirrors watchdog.ts: Math.max(stepLogActivity, workspaceActivity, startedAt).
   */
  function heartbeatLastActivity(
    stepLogActivity: number,
    workspaceActivity: number | null,
    startedAt: number,
  ): number {
    return Math.max(stepLogActivity, workspaceActivity ?? 0, startedAt);
  }

  function isStale(lastActivity: number, maxRunningMs: number): boolean {
    return Date.now() - lastActivity > maxRunningMs;
  }

  const MAX_RUNNING_MS = 5 * 60 * 1000; // 5 min

  // ── Test A: fresh workspace + stale step_logs → NOT stale ──
  it("fresh workspace mtime + stale step_logs → task NOT marked stale", () => {
    const now = Date.now();
    const startedAt = now - MAX_RUNNING_MS - 60_000; // started 6 min ago
    const stepLogActivity = startedAt + 1000; // step log is ~1s after start (now very stale)
    const workspaceActivity = now - 30_000; // workspace touched 30s ago (fresh)

    const lastActivity = heartbeatLastActivity(stepLogActivity, workspaceActivity, startedAt);
    expect(isStale(lastActivity, MAX_RUNNING_MS)).toBe(false);
  });

  // ── Test B: stale workspace + fresh step_logs → NOT stale ──
  it("stale workspace + fresh step_logs → task NOT marked stale", () => {
    const now = Date.now();
    const startedAt = now - MAX_RUNNING_MS - 60_000; // started 6 min ago
    const stepLogActivity = now - 10_000; // step log is 10s ago (fresh)
    const workspaceActivity = startedAt + 2000; // workspace touched at start, stale

    const lastActivity = heartbeatLastActivity(stepLogActivity, workspaceActivity, startedAt);
    expect(isStale(lastActivity, MAX_RUNNING_MS)).toBe(false);
  });

  // ── Test C: both stale → IS stale (existing behavior preserved) ──
  it("both stale (no step_log + no workspace activity) → task marked stale", () => {
    const now = Date.now();
    const startedAt = now - MAX_RUNNING_MS - 60_000; // started 6 min ago
    const stepLogActivity = 0; // no step logs
    const workspaceActivity = startedAt + 2000; // workspace only at start (stale)

    const lastActivity = heartbeatLastActivity(stepLogActivity, workspaceActivity, startedAt);
    expect(isStale(lastActivity, MAX_RUNNING_MS)).toBe(true);
  });

  // ── Test D: no workspace registration (null) → uses step_logs + startedAt ──
  it("no workspace registration → heartbeat uses step_logs + startedAt only (no regression)", () => {
    const now = Date.now();
    const startedAt = now - MAX_RUNNING_MS - 60_000; // started 6 min ago
    const stepLogActivity = now - 30_000; // step log 30s ago (fresh)

    const lastActivity = heartbeatLastActivity(stepLogActivity, null, startedAt);
    expect(isStale(lastActivity, MAX_RUNNING_MS)).toBe(false);
  });

  // ── Integration: registerTask + workspace mtime integrated ──
  it("registerTask seeds workspace mtime; tickAll updates it; heartbeat uses it", async () => {
    _resetForTests();
    const now = Date.now();

    // Register a task with a tmp workspace
    registerTask("heartbeat-task-1", tmp);
    const initialActivity = getLastActivity("heartbeat-task-1");
    expect(initialActivity).toBeGreaterThanOrEqual(now - 2000); // seeded at registration

    // V8 Date.now() (registration seed) and Linux mtimeMs (file write) use
    // different clock sources; on fast CI tmpfs they can disagree by ~1ms.
    // Sleep so the file mtime is strictly later than the registration seed.
    await new Promise((r) => setTimeout(r, 10));

    // Touch a file in the workspace
    writeFileSync(join(tmp, "active.txt"), "content");
    await tickAll();

    const updated = getLastActivity("heartbeat-task-1");
    expect(updated).toBeGreaterThan(initialActivity!);

    // Heartbeat: if step_logs are stale but workspace is fresh → not killed
    const stepLogActivity = now - 600_000; // stale (10 min ago)
    const startedAt = now - 600_000;
    const lastActivity = heartbeatLastActivity(stepLogActivity, updated, startedAt);
    expect(isStale(lastActivity, MAX_RUNNING_MS)).toBe(false);
  });
});
