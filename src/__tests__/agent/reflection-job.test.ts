import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// ---------------------------------------------------------------------------
// Mock — reflection.js must be mocked before the module under test imports it
// ---------------------------------------------------------------------------

const runMock = vi.hoisted(() => vi.fn().mockResolvedValue({ written: 1 }));
vi.mock("../../agent/reflection.js", () => ({
  runReflectionForRole: runMock,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks are registered
// ---------------------------------------------------------------------------

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  runMock.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedRole(id: string, lastReflectionAt: number | null): void {
  const db = getTestDb();
  db.prepare(
    "INSERT INTO roles (id, name, cag_prompt, learned_rules, memory_stream_id, status, preferences, created_at, importance_trigger_curr, last_reflection_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    id,               // name
    "",               // cag_prompt
    "{}",             // learned_rules
    "stream-" + id,   // memory_stream_id
    "active",         // status
    "{}",             // preferences
    Date.now(),       // created_at
    0,                // importance_trigger_curr
    lastReflectionAt, // last_reflection_at
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reflectionTick", () => {
  it("dispatches for Role whose last_reflection_at is NULL", async () => {
    seedRole("r-null", null);
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const dispatched = await reflectionTick(30);
    expect(dispatched).toContain("r-null");
    expect(runMock).toHaveBeenCalledWith("r-null");
  });

  it("dispatches for Role whose last_reflection_at is past interval (31 min ago)", async () => {
    const past = Date.now() - 31 * 60 * 1000;
    seedRole("r-past", past);
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const dispatched = await reflectionTick(30);
    expect(dispatched).toContain("r-past");
    expect(runMock).toHaveBeenCalledWith("r-past");
  });

  it("skips Role whose last_reflection_at is within interval (10 min ago)", async () => {
    const recent = Date.now() - 10 * 60 * 1000;
    seedRole("r-recent", recent);
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const dispatched = await reflectionTick(30);
    expect(dispatched).not.toContain("r-recent");
    expect(runMock).not.toHaveBeenCalled();
  });

  it("continues iterating Roles after one fails", async () => {
    const past = Date.now() - 31 * 60 * 1000;
    seedRole("r-fail", past);
    seedRole("r-ok", past);
    runMock.mockRejectedValueOnce(new Error("haiku failure")).mockResolvedValueOnce({ written: 1 });
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const dispatched = await reflectionTick(30);
    expect(dispatched).toContain("r-ok");
    expect(dispatched).not.toContain("r-fail");
    // Slot stays claimed even on failure
    const db = getTestDb();
    const row = db.prepare("SELECT last_reflection_at FROM roles WHERE id = ?").get("r-fail") as { last_reflection_at: number };
    expect(row.last_reflection_at).toBeGreaterThan(0);
  });

  it("slot-claim happens BEFORE runReflectionForRole resolves", async () => {
    seedRole("r-slot", null);
    let slotClaimedBeforeResolve = false;
    const checkPromise = new Promise<void>((resolve) => {
      runMock.mockImplementationOnce(async () => {
        // Check: the slot should already be claimed before this resolves
        const db = getTestDb();
        const row = db.prepare("SELECT last_reflection_at FROM roles WHERE id = ?").get("r-slot") as { last_reflection_at: number };
        slotClaimedBeforeResolve = row.last_reflection_at > 0;
        resolve();
        return { written: 1 };
      });
    });
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const tickPromise = reflectionTick(30);
    await Promise.all([tickPromise, checkPromise]);
    expect(slotClaimedBeforeResolve).toBe(true);
  });

  it("concurrent-tick prevention: second tick observes claimed slot and skips", async () => {
    seedRole("r-concurrent", null);
    const { reflectionTick } = await import("../../agent/reflection-job.js");
    const p1 = reflectionTick(30);
    const p2 = reflectionTick(30);
    await Promise.all([p1, p2]);
    // First tick claimed the slot; second tick should have observed it and skipped dispatch
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
