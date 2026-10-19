import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  recordTaskPlugins,
  getTaskPlugins,
  getPluginUsageStats,
  getPluginUsageByRole,
} from "../../store/task-plugins.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

function seedTask(id: string): void {
  const db = getTestDb();
  db.prepare("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id, "completed", "test", "{}", Date.now(),
  );
}

function seedRole(id: string): void {
  const db = getTestDb();
  db.prepare(
    "INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, `Role ${id}`, "", `stream-${id}`, "active", Date.now());
}

describe("store/task-plugins", () => {
  describe("recordTaskPlugins", () => {
    it("records plugins for a task", () => {
      seedTask("task-1");
      recordTaskPlugins("task-1", ["/path/to/plugin-a", "/path/to/plugin-b"]);

      const plugins = getTaskPlugins("task-1");
      expect(plugins).toHaveLength(2);
      expect(plugins[0].pluginPath).toBe("/path/to/plugin-a");
      expect(plugins[0].pluginName).toBe("plugin-a");
      expect(plugins[1].pluginPath).toBe("/path/to/plugin-b");
      expect(plugins[1].pluginName).toBe("plugin-b");
    });

    it("records with roleId", () => {
      seedRole("agent-1");
      seedTask("task-2");
      recordTaskPlugins("task-2", ["/path/to/plugin"], "agent-1");

      const plugins = getTaskPlugins("task-2");
      expect(plugins).toHaveLength(1);
      expect(plugins[0].roleId).toBe("agent-1");
    });

    it("records without roleId", () => {
      seedTask("task-3");
      recordTaskPlugins("task-3", ["/path/to/plugin"]);

      const plugins = getTaskPlugins("task-3");
      expect(plugins[0].roleId).toBeUndefined();
    });

    it("handles empty plugin list", () => {
      seedTask("task-4");
      recordTaskPlugins("task-4", []);
      expect(getTaskPlugins("task-4")).toEqual([]);
    });
  });

  describe("getTaskPlugins", () => {
    it("returns empty for non-existent task", () => {
      expect(getTaskPlugins("nope")).toEqual([]);
    });
  });

  describe("getPluginUsageStats", () => {
    it("aggregates usage across tasks", () => {
      seedTask("t1");
      seedTask("t2");
      recordTaskPlugins("t1", ["/a/plugin", "/b/plugin"]);
      recordTaskPlugins("t2", ["/a/plugin"]);

      const stats = getPluginUsageStats();
      expect(stats).toHaveLength(2);
      expect(stats[0].pluginName).toBe("plugin");
      expect(stats[0].usageCount).toBe(2); // /a/plugin used twice
      expect(stats[1].usageCount).toBe(1); // /b/plugin used once
    });

    it("respects limit", () => {
      seedTask("t1");
      recordTaskPlugins("t1", ["/a", "/b", "/c"]);

      const stats = getPluginUsageStats(2);
      expect(stats).toHaveLength(2);
    });

    it("returns empty when no data", () => {
      expect(getPluginUsageStats()).toEqual([]);
    });
  });

  describe("getPluginUsageByRole", () => {
    it("returns usage for specific agent", () => {
      seedRole("agent-x");
      seedRole("agent-y");
      seedTask("t1");
      seedTask("t2");
      recordTaskPlugins("t1", ["/plugin-a"], "agent-x");
      recordTaskPlugins("t2", ["/plugin-a", "/plugin-b"], "agent-y");

      const xStats = getPluginUsageByRole("agent-x");
      expect(xStats).toHaveLength(1);
      expect(xStats[0].usageCount).toBe(1);

      const yStats = getPluginUsageByRole("agent-y");
      expect(yStats).toHaveLength(2);
    });

    it("returns empty for agent with no usage", () => {
      seedRole("agent-z");
      expect(getPluginUsageByRole("agent-z")).toEqual([]);
    });
  });
});
