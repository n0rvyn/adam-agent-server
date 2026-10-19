import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { normalizeRoleOsCapabilities } from "../../shared/os-capabilities.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));
vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({ anthropic: { apiKey: "", baseUrl: "", model: "" }, defaults: {} })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));
vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600, maxTurns: 100, maxBudgetUsd: 5.0, effort: "high", model: "",
    settingSources: ["user", "project"], allowedTools: [], disallowedTools: [],
    approvalRequired: [], approvalTimeout: 300, env: {}, plugins: [], deniedReadPaths: [],
  }),
}));
vi.mock("../../manager/execution-pool.js", () => ({
  registerTaskPid: vi.fn(),
  unregisterTaskPid: vi.fn(),
  lookupTaskByPid: vi.fn(),
}));
vi.mock("../../audit/violation-watcher.js", () => ({
  reportViolation: vi.fn(),
}));

let capturedSpawnFn: Function | undefined;
async function* mockIter() { yield { type: "result", result: "ok" }; }

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((opts: any) => { capturedSpawnFn = opts.options?.spawnClaudeCodeProcess; return mockIter(); }),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "m" })),
  tool: vi.fn((_n: string, _d: string, _s: unknown, h: unknown) => ({ name: _n, handler: h })),
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
}));
vi.mock("../../manager/hooks.js", () => ({
  buildSessionHooks: vi.fn(() => ({})),
  buildCanUseTool: vi.fn(() => () => ({ behavior: "allow" })),
}));
// vi.hoisted runs before vi.mock factories, so these are available at mock time
const { _busListeners, _busMock } = vi.hoisted(() => {
  const _busListeners = new Map<string, Set<Function>>();
  const _busMock = {
    emit: vi.fn((event: any) => {
      const listeners = _busListeners.get(event?.type ?? "");
      if (listeners) for (const fn of listeners) fn(event);
    }),
    on: vi.fn((event: string, fn: Function) => {
      if (!_busListeners.has(event)) _busListeners.set(event, new Set());
      _busListeners.get(event)!.add(fn);
    }),
    off: vi.fn((event: string, fn: Function) => {
      _busListeners.get(event)?.delete(fn);
    }),
  };
  return { _busListeners, _busMock };
});
vi.mock("../../server/events/server-bus.js", () => ({ serverBus: _busMock }));
vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => "/tmp/mock-ws"),
  getRoleWorkspacePath: vi.fn(() => "/tmp/mock-ws"),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

function makeMockProc() {
  const { EventEmitter } = require("events");
  const { Readable, Writable } = require("stream");
  const p = new EventEmitter();
  p.stdin = new Writable({ write: (_: unknown, __: unknown, cb: Function) => cb() });
  p.stdout = new Readable({ read() { this.push(null); } });
  p.stderr = null; // Prevent readable stream blocking
  p.killed = false; p.exitCode = null; p.kill = () => true;
  p.pid = 12345;
  setTimeout(() => p.emit("exit", 0, null), 50);
  return p;
}

function makeMockProcWithStderr() {
  const { EventEmitter } = require("events");
  const { Readable, Writable } = require("stream");
  const p = new EventEmitter();
  p.stdin = new Writable({ write: (_: unknown, __: unknown, cb: Function) => cb() });
  p.stdout = new Readable({ read() { this.push(null); } });
  p.stderr = new Readable({ read() { this.push(Buffer.from("sandbox-exec: profile parse error\n")); this.push(null); } });
  p.killed = false; p.exitCode = null; p.kill = () => true;
  p.pid = 99999;
  // Emit non-zero exit after a short delay
  setTimeout(() => p.emit("exit", 1, null), 20);
  return p;
}

const { sharedSpawnMock, sharedProvider } = vi.hoisted(() => {
  const sharedSpawnMock = vi.fn((_opts: any) => makeMockProc());
  const sharedProvider = {
    platform: "sandbox-exec" as const,
    spawn: sharedSpawnMock,
    isAvailable: () => Promise.resolve(true),
  };
  return { sharedSpawnMock, sharedProvider };
});
vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn(() => sharedProvider),
}));

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRole } from "../../store/roles.js";
import { createTask, getTask } from "../../store/tasks.js";
import { ExecutionManager } from "../../manager/execution-manager.js";
import { getSandboxProvider } from "../../sandbox/provider.js";
import { serverBus } from "../../server/events/server-bus.js";
import type { Task, Role } from "../../shared/types.js";

let tempBase: string;

afterAll(() => { cleanup(); rmSync(tempBase, { recursive: true, force: true }); });
beforeEach(() => {
  clearTestDb();
  capturedSpawnFn = undefined;
  _busListeners.clear();
  _busMock.emit.mockClear();
  _busMock.on.mockClear();
  _busMock.off.mockClear();
  // Reset provider to sandbox-exec (tests that change it must restore)
  sharedProvider.platform = "sandbox-exec" as any;
  sharedProvider.isAvailable = () => Promise.resolve(true);
  sharedSpawnMock.mockImplementation(() => makeMockProc());
  tempBase = mkdtempSync(join(tmpdir(), "adam-em-sandbox-"));
});

function seedRole(extra: Partial<Role> = {}): Role {
  const id = `role-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const role: Role = {
    id, name: `tester-${id.slice(-4)}`, cagPrompt: "Test", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `m-${id}`, status: "active", preferences: {}, createdAt: Date.now(), ...extra,
  };
  createRole(role);
  return role;
}

function seedTask(roleId: string): Task {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  createTask({
    id, status: "pending", prompt: "test", createdAt: Date.now(), roleId,
    config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
  });
  return getTask(id)!;
}

describe("ExecutionManager sandbox integration", () => {
  it("passes spawnClaudeCodeProcess to SDK query()", async () => {
    const role = seedRole();
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);
    expect(capturedSpawnFn).toBeDefined();
    expect(typeof capturedSpawnFn).toBe("function");
  });

  it("spawnClaudeCodeProcess includes additionalDirectories in visiblePaths with correct modes", { timeout: 5000 }, async () => {
    const appDir = join(tempBase, "myapp");
    const libDir = join(tempBase, "lib");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(libDir, { recursive: true });

    const role = seedRole({
      additionalDirectories: [
        { path: appDir, mode: "rw" },
        { path: libDir, mode: "ro" },
      ],
    });
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);

    expect(capturedSpawnFn).toBeDefined();

    // Invoke spawnClaudeCodeProcess to trigger sandbox.spawn
    sharedSpawnMock.mockClear();
    capturedSpawnFn!({ command: "claude", args: [], cwd: "/tmp", env: {} });

    expect(sharedSpawnMock).toHaveBeenCalled();
    const opts = sharedSpawnMock.mock.calls[0][0];
    expect(opts.visiblePaths).toBeDefined();

    const paths = opts.visiblePaths.map((vp: any) => vp.path);
    expect(paths).toContain(appDir);
    expect(paths).toContain(libDir);
    expect(opts.visiblePaths.find((v: any) => v.path === appDir)!.mode).toBe("rw");
    expect(opts.visiblePaths.find((v: any) => v.path === libDir)!.mode).toBe("ro");
  });

  it("passes role osCapabilities through to sandbox spawn options", async () => {
    const role = seedRole({
      osCapabilities: [
        { id: "automation", targets: ["com.apple.mail", "com.apple.systemevents"] },
        { id: "accessibility" },
      ],
    });
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);

    expect(capturedSpawnFn).toBeDefined();

    sharedSpawnMock.mockClear();
    capturedSpawnFn!({ command: "claude", args: [], cwd: "/tmp", env: {} });

    expect(sharedSpawnMock).toHaveBeenCalledWith(expect.objectContaining({
      osCapabilities: normalizeRoleOsCapabilities(role.osCapabilities),
    }));
  });

  it("sandbox platform 'none' emits plan_approval_request", async () => {
    sharedProvider.platform = "none" as any;
    sharedProvider.isAvailable = () => Promise.resolve(false);

    // Auto-approve: when plan_approval_request fires, respond with allow
    _busMock.on("plan_approval_request", (event: any) => {
      setImmediate(() => {
        _busMock.emit({ type: "plan_approval_decision", planId: event.planId, decision: "allow" });
      });
    });

    const role = seedRole();
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);

    // Verify approval was requested
    const approvalCalls = _busMock.emit.mock.calls.filter(
      (c: any[]) => c[0]?.type === "plan_approval_request",
    );
    expect(approvalCalls.length).toBeGreaterThan(0);
  });

  it("logs sandbox spawn failure when process exits non-zero with sandbox stderr", async () => {
    // Use the stderr mock that emits sandbox-exec error and exit code 1
    sharedSpawnMock.mockImplementation(() => makeMockProcWithStderr());

    const role = seedRole();
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);

    expect(capturedSpawnFn).toBeDefined();

    // Invoke spawnClaudeCodeProcess to trigger sandbox.spawn with the stderr mock
    sharedSpawnMock.mockClear();
    sharedSpawnMock.mockImplementation(() => makeMockProcWithStderr());
    capturedSpawnFn!({ command: "claude", args: [], cwd: "/tmp", env: {} });

    // Wait for stderr data + exit event to fire
    await new Promise((r) => setTimeout(r, 100));

    // reportViolation should be called with sandbox_init_failure
    const { reportViolation } = await import("../../audit/violation-watcher.js");
    expect(vi.mocked(reportViolation)).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: expect.any(String),
        taskId: expect.any(String),
        operation: expect.stringContaining("sandbox_init_failure"),
      }),
    );
  });

  it("registers and unregisters PID for task correlation", async () => {
    const role = seedRole();
    const task = seedTask(role.id);
    await new ExecutionManager().execute(task);

    expect(capturedSpawnFn).toBeDefined();

    sharedSpawnMock.mockClear();
    const proc = makeMockProc();
    sharedSpawnMock.mockImplementation(() => proc);
    capturedSpawnFn!({ command: "claude", args: [], cwd: "/tmp", env: {} });

    const { registerTaskPid } = await import("../../manager/execution-pool.js");
    expect(vi.mocked(registerTaskPid)).toHaveBeenCalledWith(12345, role.id, task.id);

    // Simulate exit to trigger unregisterTaskPid
    await new Promise((r) => setTimeout(r, 100));
    const { unregisterTaskPid } = await import("../../manager/execution-pool.js");
    expect(vi.mocked(unregisterTaskPid)).toHaveBeenCalledWith(12345);
  });

  it("sandbox bypass denial fails the task", async () => {
    sharedProvider.platform = "none" as any;
    sharedProvider.isAvailable = () => Promise.resolve(false);

    // Auto-deny: when plan_approval_request fires, respond with deny
    _busMock.on("plan_approval_request", (event: any) => {
      setImmediate(() => {
        _busMock.emit({ type: "plan_approval_decision", planId: event.planId, decision: "deny" });
      });
    });

    const role = seedRole();
    const task = seedTask(role.id);
    const result = await new ExecutionManager().execute(task);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("denied");
  });

});
