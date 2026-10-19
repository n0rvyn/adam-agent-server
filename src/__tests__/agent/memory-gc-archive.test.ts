/**
 * Task 9 TDD: memory-gc archive sweep (v3 mechanics).
 *
 * Verifies:
 * 1. sub-threshold active beliefs are archived (status='archived'), NOT deleted
 * 2. is_anti=1 beliefs are never archived even if effective_ema < threshold
 * 3. row count is unchanged (archive ≠ delete)
 * 4. memories observation TTL cleanup path is unaffected
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";

vi.mock("../../store/db.js");

vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: () => ({
    memory: {
      scope: {
        decayBase: 0.995,
        archiveThreshold: 0.2,
        emaAlpha: 0.3,
      },
    },
  }),
}));

vi.mock("../../store/roles.js", () => ({
  getRoleTaskSeq: vi.fn(),
  getRole: vi.fn(),
  listRoles: vi.fn().mockReturnValue([]),
  updateRole: vi.fn(),
  incrementRoleTaskSeq: vi.fn(),
}));

let db: BetterSqlite3.Database;
let cleanup: () => void;

beforeAll(async () => {
  const { setupTestDb } = await import("../helpers/test-db.js");
  ({ db, cleanup } = setupTestDb());
});

afterAll(() => cleanup());

beforeEach(() => {
  vi.doMock("../../store/db.js", () => ({ getDb: () => db }));
  db.prepare("DELETE FROM beliefs").run();
  db.prepare("DELETE FROM memories").run();
  db.prepare("DELETE FROM roles").run();
  db.prepare("DELETE FROM server_state").run();
  db.prepare(
    "INSERT INTO server_state (id, created_at, last_memory_gc_at) VALUES (1, ?, 0)"
  ).run(Date.now());
  db.prepare(
    "INSERT INTO roles (id, name, status, cag_prompt, memory_stream_id, created_at) VALUES ('role-a', 'RoleA', 'active', '', 'mem-a', ?)"
  ).run(Date.now());
});

function seedActiveBelief(opts: {
  id: string;
  roleId?: string;
  successEma: number;
  lastUsedAt?: number;  // represents task_seq in v81 (last_used_at column stores seq number)
  isAnti?: number;
}): void {
  const { id, roleId = "role-a", successEma, lastUsedAt = 0, isAnti = 0 } = opts;
  db.prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
      created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
    VALUES (?, ?, 'test belief', ?, '[]', ?, ?, ?, 'active', ?, 1)
  `).run(id, roleId, isAnti, Date.now(), lastUsedAt, Date.now(), successEma);
}

function seedMemoryObservation(id: string, createdAt: number): void {
  db.prepare(`
    INSERT INTO memories (id, role_id, content, type, importance, source_type,
      created_at, last_accessed, kind)
    VALUES (?, 'role-a', 'obs content', 'event', 3, 'task',
      ?, ?, 'observation')
  `).run(id, createdAt, createdAt);
}

describe("memory-gc archive sweep (Task 9)", () => {
  it("sub-threshold active belief gets archived (status=archived, not deleted)", async () => {
    // successEma=0.5, lastUsedAt=0 (seq=0), currentSeq=200
    // effective_ema = 0.5 × 0.995^200 ≈ 0.183 < 0.2 → should archive
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(200);

    seedActiveBelief({ id: "b-below", successEma: 0.5, lastUsedAt: 0 });

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(1);

    const row = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-below") as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("archived");
  });

  it("above-threshold active belief remains active", async () => {
    // successEma=0.5, lastUsedAt=0 (seq=0), currentSeq=100
    // effective_ema = 0.5 × 0.995^100 ≈ 0.303 > 0.2 → stays active
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(100);

    seedActiveBelief({ id: "b-above", successEma: 0.5, lastUsedAt: 0 });

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(0);

    const row = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-above") as { status: string } | undefined;
    expect(row!.status).toBe("active");
  });

  it("is_anti=1 belief is never archived even if effective_ema < threshold", async () => {
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(200);

    seedActiveBelief({ id: "b-anti", successEma: 0.1, lastUsedAt: 0, isAnti: 1 });

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(0);

    const row = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-anti") as { status: string } | undefined;
    expect(row!.status).toBe("active");
  });

  it("total belief row count unchanged after GC (archive ≠ delete)", async () => {
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(200);

    // 2 below threshold, 1 above, 1 is_anti
    seedActiveBelief({ id: "b-d1", successEma: 0.5, lastUsedAt: 0 });  // archive
    seedActiveBelief({ id: "b-d2", successEma: 0.5, lastUsedAt: 0 });  // archive
    seedActiveBelief({ id: "b-keep", successEma: 0.9, lastUsedAt: 199 }); // effective_ema=0.9×0.995≈0.895 → stays
    seedActiveBelief({ id: "b-anti2", successEma: 0.1, lastUsedAt: 0, isAnti: 1 }); // is_anti protected

    const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM beliefs").get() as { c: number }).c;

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    memoryGcTick({ observationTtlDays: 30 });

    const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM beliefs").get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
  });

  it("memoryGcTick respects per-role task_seq for threshold comparison", async () => {
    // role A: task_seq=5, belief last_used_at=0 → delta=5 → eff=0.5×0.995^5≈0.488 > 0.2 → stays active
    // role B: task_seq=300, belief last_used_at=0 → delta=300 → eff=0.5×0.995^300≈0.222 > 0.2... let's use 400
    // role B: task_seq=400, delta=400 → eff=0.5×0.995^400≈0.135 < 0.2 → archived
    const { getRoleTaskSeq } = await import("../../store/roles.js");

    // Add role B
    db.prepare(
      "INSERT INTO roles (id, name, status, cag_prompt, memory_stream_id, created_at) VALUES ('role-b', 'RoleB', 'active', '', 'mem-b', ?)"
    ).run(Date.now());

    // role A has low task_seq → no archive
    // role B has high task_seq → archive
    vi.mocked(getRoleTaskSeq).mockImplementation((roleId: string) => {
      if (roleId === "role-a") return 5;
      if (roleId === "role-b") return 400;
      return 0;
    });

    seedActiveBelief({ id: "b-role-a", roleId: "role-a", successEma: 0.5, lastUsedAt: 0 });
    seedActiveBelief({ id: "b-role-b", roleId: "role-b", successEma: 0.5, lastUsedAt: 0 });

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(1);
    const rowA = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-role-a") as { status: string };
    const rowB = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-role-b") as { status: string };
    expect(rowA.status).toBe("active");   // low task_seq → not archived
    expect(rowB.status).toBe("archived"); // high task_seq → archived
  });

  it("memoryGcTick skips beliefs with null success_ema", async () => {
    // Beliefs with success_ema=NULL are never-seeded; GC must skip them (not archive)
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(999);

    db.prepare(`
      INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
        created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
      VALUES ('b-null-ema', 'role-a', 'null ema belief', 0, '[]', ?, 0, ?, 'active', NULL, 0)
    `).run(Date.now(), Date.now());

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(0);
    const row = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-null-ema") as { status: string };
    expect(row.status).toBe("active"); // null EMA never archived
  });

  it("memoryGcTick handles a role with zero active beliefs (only archived rows present)", async () => {
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(500); // high seq — would archive low-EMA actives

    // All beliefs for this role are already archived → inner loop sees empty actives list
    db.prepare(`
      INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
        created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
      VALUES (?, 'role-empty', 'archived', 0, '[]', ?, 0, ?, 'archived', ?, 1)
    `).run("b-arch-1", Date.now(), Date.now(), 0.01);
    db.prepare(`
      INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
        created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
      VALUES (?, 'role-empty', 'archived', 0, '[]', ?, 0, ?, 'archived', ?, 1)
    `).run("b-arch-2", Date.now(), Date.now(), 0.05);

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.beliefsArchived).toBe(0); // nothing to archive
    // Archived rows must remain archived (not silently flipped)
    const row1 = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-arch-1") as { status: string };
    const row2 = db.prepare("SELECT status FROM beliefs WHERE id = ?").get("b-arch-2") as { status: string };
    expect(row1.status).toBe("archived");
    expect(row2.status).toBe("archived");
  });

  it("memories observation TTL cleanup still removes old observations", async () => {
    const { getRoleTaskSeq } = await import("../../store/roles.js");
    vi.mocked(getRoleTaskSeq).mockReturnValue(10);  // low seq → no beliefs archived

    const oldTs = Date.now() - 31 * 86_400_000; // 31 days ago
    const newTs = Date.now() - 1_000;            // 1 second ago

    seedMemoryObservation("obs-old", oldTs);
    seedMemoryObservation("obs-new", newTs);

    const { memoryGcTick } = await import("../../agent/memory-gc.js");
    const report = memoryGcTick({ observationTtlDays: 30 });

    expect(report.observationsDeleted).toBe(1);
    const remaining = db.prepare("SELECT id FROM memories").all() as Array<{ id: string }>;
    expect(remaining.map(r => r.id)).toEqual(["obs-new"]);
  });
});
