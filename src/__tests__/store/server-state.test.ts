import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  getServerState,
  updateWorkspacePath,
  updateServerState,
  updateUserTaskSessionId,
} from "../../store/server-state.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

describe("store/server-state", () => {
  describe("getServerState", () => {
    it("should create default state if none exists", () => {
      const state = getServerState();
      expect(state.id).toBe(1);
      expect(state.createdAt).toBeGreaterThan(0);
      expect(state.workspacePath).toBeUndefined();
    });

    it("should return existing state on subsequent calls", () => {
      const state1 = getServerState();
      const state2 = getServerState();
      expect(state1.createdAt).toBe(state2.createdAt);
    });
  });

  // updateSdkSessionId / clearSdkSessionId tests removed (issue #221 cleanup):
  // both functions deleted from production along with their consumers in ChatManager.

  describe("updateWorkspacePath", () => {
    it("should set workspace path", () => {
      getServerState();
      updateWorkspacePath("/home/user/project");

      const state = getServerState();
      expect(state.workspacePath).toBe("/home/user/project");
    });

    it("should overwrite existing workspace path", () => {
      getServerState();
      updateWorkspacePath("/path/a");
      updateWorkspacePath("/path/b");

      const state = getServerState();
      expect(state.workspacePath).toBe("/path/b");
    });
  });

  describe("updateUserTaskSessionId", () => {
    it("updates and reads userTaskSessionId", () => {
      getServerState();
      updateUserTaskSessionId("sess-xyz");

      const state = getServerState();
      expect(state.userTaskSessionId).toBe("sess-xyz");
    });

    it("clears userTaskSessionId", () => {
      getServerState();
      updateUserTaskSessionId("sess-to-clear");
      expect(getServerState().userTaskSessionId).toBe("sess-to-clear");

      updateUserTaskSessionId(undefined);
      const state = getServerState();
      expect(state.userTaskSessionId).toBeUndefined();
    });
  });

  describe("updateServerState", () => {
    it("should do nothing with empty updates", () => {
      const state1 = getServerState();
      updateServerState({});
      const state2 = getServerState();
      expect(state1.createdAt).toBe(state2.createdAt);
    });

    it("should update multiple fields at once", () => {
      getServerState();
      updateServerState({
        userTaskSessionId: "multi-task-sess",
        workspacePath: "/multi/path",
        lastActiveAt: 12345,
      });

      const state = getServerState();
      expect(state.userTaskSessionId).toBe("multi-task-sess");
      expect(state.workspacePath).toBe("/multi/path");
      expect(state.lastActiveAt).toBe(12345);
    });
  });
});
