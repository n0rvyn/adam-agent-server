/**
 * Task 1-tests: Schema v73 + Artifact.priority field
 *
 * Tests FAIL before Task 1-impl:
 *   - Case B: createArtifact({...minimal, priority: undefined}) — priority not in Artifact interface yet
 *   - Case C: createArtifact({...minimal, priority: 10}) — same; priority not persisted
 *
 * Tests PASS after Task 1-impl (priority column + interface + INSERT wired).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createArtifact, type Artifact } from "../../store/artifacts.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
});

// Seed a role so createArtifact's roleId check passes
function seedRole(id = "role-test") {
  getTestDb().prepare(
    `INSERT OR IGNORE INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, '', '', 'active', ?)`,
  ).run(id, id, Date.now());
  return id;
}

// Seed a task so task_published FK check passes
function seedTask(id = "task-1") {
  getTestDb().prepare(
    `INSERT OR IGNORE INTO tasks (id, prompt, config, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, "test", "{}", Date.now());
  return id;
}

// Case A: PRAGMA table_info(artifacts) includes priority column
describe("Task 1-tests: Case A — priority column exists in schema", () => {
  it("PRAGMA table_info(artifacts) returns a row with name='priority', type='INTEGER', notnull=0", () => {
    const db = getTestDb();
    const cols = db.prepare("PRAGMA table_info(artifacts)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const priorityCol = cols.find((c) => c.name === "priority");
    expect(priorityCol).toBeDefined();
    expect(priorityCol!.type).toBe("INTEGER");
    expect(priorityCol!.notnull).toBe(0);
  });
});

// Case B: createArtifact without priority → row has priority=NULL
describe("Task 1-tests: Case B — createArtifact without priority stores NULL", () => {
  it("artifact row has priority=NULL when priority omitted", () => {
    const roleId = seedRole();
    const taskId = seedTask();

    const artifact: Artifact = {
      id: "art-b1",
      sourceKind: "task_published",
      taskId,
      roleId,
      kind: "file",
      sizeBytes: 10,
      createdAt: Date.now(),
    };

    createArtifact(artifact);

    const row = getTestDb().prepare("SELECT priority FROM artifacts WHERE id = ?").get("art-b1") as {
      priority: number | null;
    };
    expect(row).toBeDefined();
    expect(row.priority).toBeNull();
  });
});

// Case C: createArtifact with priority: 10 → row has priority=10
describe("Task 1-tests: Case C — createArtifact with priority=10 persists value", () => {
  it("artifact row has priority=10 when priority is set", () => {
    const roleId = seedRole();
    const taskId = seedTask("task-2");

    const artifact: Artifact = {
      id: "art-c1",
      sourceKind: "task_published",
      taskId,
      roleId,
      kind: "file",
      sizeBytes: 20,
      createdAt: Date.now(),
      priority: 10,
    };

    createArtifact(artifact);

    const row = getTestDb().prepare("SELECT priority FROM artifacts WHERE id = ?").get("art-c1") as {
      priority: number | null;
    };
    expect(row).toBeDefined();
    expect(row.priority).toBe(10);
  });
});
