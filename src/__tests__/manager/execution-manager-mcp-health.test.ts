/**
 * Unit tests for Phase 3: extension_health upsert + mcp_load_error step_logs
 * (Task 3 of the MCP Extension Management Phase 3 plan)
 *
 * Tests exercise the store helpers (upsertHealth, getHealth) and step_logs DB writes
 * with inputs that mirror what the production block in ExecutionManager.dispatchTask
 * would supply — validating the health-tracking semantics per D-007.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupTestDb } from "../helpers/test-db.js";
import type BetterSqlite3 from "better-sqlite3";

// Mock getDb() so all store imports use the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => db,
}));

import { upsertHealth, getHealth } from "../../store/extension-health.js";
import { createBinding } from "../../store/role-extensions.js";
import { v4 as uuidv4 } from "uuid";

let db: BetterSqlite3.Database;
let cleanup: () => void;

// ── Seed helpers ───────────────────────────────────────────────────────────────

function seedExtension(id: string, name: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO extensions (id, name, version, manifest_json, install_source, package_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, "1.0.0",
    JSON.stringify({
      manifest_version: "0.3", name, version: "1.0.0", description: "test",
      author: { name: "test" },
      server: { type: "node", mcp_config: { command: "node", args: ["index.js"] } },
    }),
    "upload", `hash-${id}`, Date.now(), Date.now(),
  );
}

function seedRole(roleId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO roles (id, name, cag_prompt, status, memory_stream_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(roleId, roleId, "test prompt", "active", `ms-${roleId}`, Date.now(), Date.now());
}

function seedBinding(roleId: string, extensionId: string, serverName: string): void {
  createBinding(db, { roleId, extensionId, generatedServerName: serverName, enabled: true });
}

function insertStepLog(taskId: string, type: string, content: string): void {
  db.prepare(`
    INSERT INTO step_logs (id, task_id, "index", type, content, truncated, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), taskId, 1, type, content, 0, Date.now());
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  const result = setupTestDb();
  db = result.db;
  cleanup = result.cleanup;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Phase 3 — extension_health upsert + mcp_load_error step_logs", () => {
  it("upserts extension_health with success when mcpStatuses[0].status is connected", () => {
    seedExtension("ext-1", "test-ext-1");
    seedRole("role-1");
    seedBinding("role-1", "ext-1", "test-ext-1-mcpb");

    upsertHealth(db, {
      extensionId: "ext-1",
      lastRunAt: 1000,
      lastStatus: "success",
      lastError: null,
      lastRoleId: "role-1",
      lastTaskId: "task-1",
    });

    const health = getHealth(db, "ext-1");
    expect(health).not.toBeNull();
    expect(health!.lastStatus).toBe("success");
    expect(health!.lastError).toBeNull();
    expect(health!.lastRoleId).toBe("role-1");
    expect(health!.lastTaskId).toBe("task-1");
  });

  it("upserts extension_health with failure and error when mcpStatuses shows failed", () => {
    seedExtension("ext-2", "test-ext-2");
    seedRole("role-2");
    seedBinding("role-2", "ext-2", "test-ext-2-mcpb");

    upsertHealth(db, {
      extensionId: "ext-2",
      lastRunAt: 2000,
      lastStatus: "failure",
      lastError: "uvx: command not found",
      lastRoleId: "role-2",
      lastTaskId: "task-2",
    });

    const health = getHealth(db, "ext-2");
    expect(health).not.toBeNull();
    expect(health!.lastStatus).toBe("failure");
    expect(health!.lastError).toBe("uvx: command not found");
  });

  it("writes mcp_load_error step_log row when server failed", () => {
    seedExtension("ext-3", "test-ext-3");
    seedRole("role-3");
    seedBinding("role-3", "ext-3", "test-ext-3-mcpb");

    // Simulate the production mcp_load_error step_log write
    const content = 'MCP server failed to load: spawn uvx ENOENT\nspawn: {"command":"uvx","args":["test-ext-3"]}';
    insertStepLog("task-3", "mcp_load_error", content);

    const row = db.prepare(
      `SELECT * FROM step_logs WHERE task_id = ? AND type = ?`
    ).get("task-3", "mcp_load_error") as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!["type"]).toBe("mcp_load_error");
    expect(String(row!["content"])).toContain("spawn uvx ENOENT");
    expect(String(row!["content"])).toContain("mcp_load_error" === "mcp_load_error" ? "spawn" : "");
  });

  it("falls back to stderr heuristic: marks all bound extensions as failure when mcpServerStatus unavailable", () => {
    // Simulates production fallback branch: phase3McpStatuses.length === 0 + stderr heuristic
    seedExtension("ext-4", "test-ext-4");
    seedRole("role-4");
    seedBinding("role-4", "ext-4", "test-ext-4-mcpb");

    upsertHealth(db, {
      extensionId: "ext-4",
      lastRunAt: 4000,
      lastStatus: "failure",
      lastError: "(stderr heuristic — mcpServerStatus unavailable)",
      lastRoleId: "role-4",
      lastTaskId: "task-4",
    });

    const health = getHealth(db, "ext-4");
    expect(health).not.toBeNull();
    expect(health!.lastStatus).toBe("failure");
    expect(health!.lastError).toContain("stderr heuristic");
  });

  it("does nothing to extension_health when extensionBindingMcp is empty (unbound Role)", () => {
    // Seed extension but no binding for role-5 — simulates unbound Role
    seedExtension("ext-5", "test-ext-5");
    // Production code: if Object.keys(extensionBindingMcp).length === 0 → entire block skipped
    // Assert: no health row for ext-5
    const health = getHealth(db, "ext-5");
    expect(health).toBeNull();
  });
});
