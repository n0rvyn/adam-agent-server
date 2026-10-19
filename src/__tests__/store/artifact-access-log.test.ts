import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  listAccessLogByExecution,
  logArtifactAccess,
} from "../../store/artifact-access-log.js";

afterAll(() => cleanup());

describe("store/artifact-access-log", () => {
  beforeEach(() => {
    clearTestDb();
  });

  it("inserts and lists access log entries", () => {
    logArtifactAccess({
      timestamp: 1,
      taskId: "task-1",
      roleId: "role-1",
      executionId: "exec-1",
      stepId: "step-1",
      tool: "write_artifact",
      artifactKey: "summary",
      artifactId: "art-1",
      sizeBytes: 12,
      outcome: "success",
    });

    expect(listAccessLogByExecution("exec-1")).toMatchObject([
      {
        taskId: "task-1",
        roleId: "role-1",
        tool: "write_artifact",
        outcome: "success",
      },
    ]);
  });

  it("roundtrips all outcome variants in descending time order", () => {
    logArtifactAccess({
      timestamp: 1,
      executionId: "exec-2",
      tool: "write_artifact",
      outcome: "success",
    });
    logArtifactAccess({
      timestamp: 2,
      executionId: "exec-2",
      tool: "read_artifact",
      outcome: "denied",
      errorReason: "nope",
    });
    logArtifactAccess({
      timestamp: 3,
      executionId: "exec-2",
      tool: "fetch_artifact_file",
      outcome: "error",
      errorReason: "missing",
    });

    expect(listAccessLogByExecution("exec-2").map((entry) => entry.outcome)).toEqual([
      "error",
      "denied",
      "success",
    ]);
  });
});
