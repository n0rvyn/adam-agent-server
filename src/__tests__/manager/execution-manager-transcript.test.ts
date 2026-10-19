/**
 * Task 4-tests: SDK transcript persistence — failing tests.
 *
 * Problem 4: "silent failure 不可调试" (SDK transcript observability)
 *
 * When env var ADAM_PERSIST_SDK_TRANSCRIPTS=1 is set, each SDK event should be
 * appended as one JSON line to ~/.adam/transcripts/{taskId}.jsonl. The directory
 * must be mode 0o700 and the file must be mode 0o600. When the env var is unset,
 * no file should be created. When the transcript exceeds 5MB, a truncation marker
 * must be appended and further events dropped. Pre-existing files with loose mode
 * must be upgraded to 0o600.
 *
 * Expected: FAILS before Task 4-impl (appendTranscript helper does not exist).
 */

// IMPORTANT: ADAM_TEST_DIR must be set BEFORE any imports that reference RUNTIME_DIR.
const _testRuntimeRoot = mkdtempSync(tmpdir() + sep + "adam-transcript-test-");
process.env.ADAM_TEST_DIR = _testRuntimeRoot;

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, chmodSync, statSync, readFileSync as nodeReadFileSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Mocks — defined before the ExecutionManager import
// ---------------------------------------------------------------------------

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/runtime.js", () => ({
  buildSdkAuthEnv: vi.fn(() => ({})),
  buildSdkEnv: vi.fn(() => ({})),
  getRuntimeConfig: vi.fn(() => ({
    anthropic: { apiKey: "", baseUrl: "", model: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", smallFastModel: "" },
    defaults: {},
  })),
  initRuntimeConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  // Default: empty generator — per-test setup overrides this via vi.mocked(query)
  query: vi.fn(() => (function* () {})()),
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "mock-mcp" })),
  tool: vi.fn((_name: string, _desc: string, _schema: unknown, _handler: unknown) => ({ name: _name, handler: _handler })),
}));

vi.mock("../../manager/hooks.js", () => ({
  buildCanUseTool: vi.fn().mockReturnValue({ canUseTool: vi.fn().mockResolvedValue({ ok: true }) }),
  buildSessionHooks: vi.fn().mockReturnValue({ onToolUse: vi.fn(), onSubagentStop: vi.fn() }),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("../../store/tasks.js", () => ({
  updateTask: vi.fn(),
  getTask: vi.fn().mockReturnValue({ id: "task-1", status: "pending", prompt: "", config: {}, createdAt: Date.now() }),
  updateTaskConfig: vi.fn(),
  updateContextMeta: vi.fn(),
}));

vi.mock("../../store/logs.js", () => ({
  createStepLog: vi.fn(),
}));

vi.mock("../../store/roles.js", () => ({
  getRole: vi.fn().mockReturnValue({
    id: "role-test", name: "Test Role", cagPrompt: "", learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "", status: "active" as const, preferences: {}, createdAt: Date.now(),
  }),
  getRoleByName: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/role-workspace.js", () => ({
  ensureRoleWorkspace: vi.fn(() => `${_testRuntimeRoot}/roles/test`),
  getRoleWorkspacePath: vi.fn(() => `${_testRuntimeRoot}/roles/test`),
  writeRoleCLAUDEmd: vi.fn(),
  syncRoleSettings: vi.fn(),
}));

vi.mock("../../store/task-plugins.js", () => ({
  recordTaskPlugins: vi.fn(),
}));

vi.mock("../../store/task-plans.js", () => ({
  createTaskPlan: vi.fn().mockReturnValue({ id: "plan-1" }),
  updateTaskPlanStatus: vi.fn(),
}));

vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: vi.fn().mockReturnValue({ platform: "sandbox-exec" }),
}));

vi.mock("../../audit/violation-watcher.js", () => ({
  reportViolation: vi.fn(),
}));

vi.mock("../../manager/execution-tools.js", () => ({
  createExecutionTools: vi.fn().mockReturnValue({ tools: [], stop: vi.fn() }),
  EXECUTION_TOOLS_MCP_NAME: "execution-tools",
}));

vi.mock("../../lib/role-capabilities.js", () => ({
  resolveRolePluginPaths: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../store/config.js", () => ({
  getConfigValue: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../store/approval-rules.js", () => ({
  findMatchingRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../manager/execution-pool.js", () => ({
  registerTaskPid: vi.fn(),
  unregisterTaskPid: vi.fn(),
}));

vi.mock("../../platform/workspace-watcher.js", () => ({
  registerTask: vi.fn(),
  unregisterTask: vi.fn(),
}));

vi.mock("../../platform/workspace-snapshot.js", () => ({
  snapshot: vi.fn().mockResolvedValue([]),
  diff: vi.fn().mockResolvedValue([]),
  serializeTuples: vi.fn().mockReturnValue([]),
}));

vi.mock("../../store/task-files.js", () => ({
  insertTaskFilesDiff: vi.fn(),
}));

vi.mock("../../store/extension-health.js", () => ({
  upsertHealth: vi.fn(),
}));

vi.mock("../../store/role-extensions.js", () => ({
  listBindingsByRole: vi.fn().mockReturnValue([]),
}));

vi.mock("../../lib/path-permissions.js", () => ({
  resolveTilde: vi.fn().mockReturnValue(""),
}));

vi.mock("../../store/role-presets.js", () => ({
  CHAT_MANAGER_ROLE_ID: "chat-manager",
}));

vi.mock("../../extensions/runtime-resolver.js", () => ({
  resolveExtensionsForTask: vi.fn().mockResolvedValue({ extensions: [], mcpServers: {} }),
}));

vi.mock("../../manager/execution-system-prompt.js", () => ({
  buildExecutionSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  buildExecutionSystemPromptParts: vi.fn().mockReturnValue({ systemParts: [], resampled: false }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIterator(events: Array<Record<string, unknown>>): Query {
  // async generator → exposes Symbol.asyncIterator, which runQuery (`for await`) requires.
  // runQuery also calls q.mcpServerStatus() on the result event (Phase 3) — stub it.
  const gen = (async function* () { for (const e of events) yield e; })();
  return Object.assign(gen, { mcpServerStatus: async () => [] }) as unknown as Query;
}

function transcriptPath(taskId: string): string {
  return `${_testRuntimeRoot}/transcripts/${taskId}.jsonl`;
}

function transcriptDir(): string {
  return `${_testRuntimeRoot}/transcripts`;
}

function readTranscriptLines(taskId: string): string[] {
  try {
    const content = nodeReadFileSync(transcriptPath(taskId), "utf8");
    return content.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

afterAll(() => {
  cleanup();
  try { rmSync(_testRuntimeRoot, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests: SDK transcript persistence
// ---------------------------------------------------------------------------

describe("SDK transcript persistence", () => {
  beforeEach(() => {
    clearTestDb();
    vi.clearAllMocks();
    // Reset query mock to empty generator — per-test setup overrides via vi.mocked
    vi.mocked(query).mockReturnValue(makeIterator([]));
    // Clear env var — each test sets it independently
    delete process.env.ADAM_PERSIST_SDK_TRANSCRIPTS;
    // Ensure transcript dir does not exist before each test
    try { rmSync(transcriptDir(), { recursive: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Case 1: env var ON → transcript file written with 2 events
  // Before impl: appendTranscript doesn't exist → no file created → FAIL
  // -------------------------------------------------------------------------
  it("transcript file created with one JSON line per SDK event when ADAM_PERSIST_SDK_TRANSCRIPTS=1", async () => {
    process.env.ADAM_PERSIST_SDK_TRANSCRIPTS = "1";
    vi.mocked(query).mockReturnValue(makeIterator([
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "result", result: "Done" },
    ]));

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const manager = new ExecutionManager();
    const task = {
      id: "task-transcript-on",
      status: "pending" as const,
      prompt: "say hello",
      config: { timeout: 60, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    };
    await manager.execute(task);

    const lines = readTranscriptLines("task-transcript-on");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Case 2: env var OFF → no transcript file created
  // Before impl: no file created (appendTranscript is no-op) → PASS
  // -------------------------------------------------------------------------
  it("no transcript file created when ADAM_PERSIST_SDK_TRANSCRIPTS is unset", async () => {
    // ADAM_PERSIST_SDK_TRANSCRIPTS already deleted in beforeEach
    vi.mocked(query).mockReturnValue(makeIterator([{ type: "result", result: "Done" }]));

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const manager = new ExecutionManager();
    const task = {
      id: "task-transcript-off",
      status: "pending" as const,
      prompt: "say hello",
      config: { timeout: 60, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    };
    await manager.execute(task);

    try {
      const stat = statSync(transcriptPath("task-transcript-off"));
      expect(stat.isFile()).toBe(false);
    } catch {
      // ENOENT is expected — no transcript file when env var is unset
      expect(true).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Case 3: file mode 0o600, dir mode 0o700
  // Before impl: no file created → ENOENT → FAIL
  // -------------------------------------------------------------------------
  it("transcript file has mode 0o600 and directory has mode 0o700", async () => {
    process.env.ADAM_PERSIST_SDK_TRANSCRIPTS = "1";
    vi.mocked(query).mockReturnValue(makeIterator([{ type: "result", result: "Done" }]));

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const manager = new ExecutionManager();
    const task = {
      id: "task-transcript-mode",
      status: "pending" as const,
      prompt: "say hello",
      config: { timeout: 60, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    };
    await manager.execute(task);

    const dirMode = statSync(transcriptDir()).mode & 0o777;
    expect(dirMode).toBe(0o700);

    const fileMode = statSync(transcriptPath("task-transcript-mode")).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  // -------------------------------------------------------------------------
  // Case 4: 5MB size cap appends truncation marker
  // Before impl: no file created → ENOENT → FAIL
  // -------------------------------------------------------------------------
  it("transcript caps at 5MB and appends truncation marker", async () => {
    process.env.ADAM_PERSIST_SDK_TRANSCRIPTS = "1";
    // 120 events × ~50KB = ~6MB → exceeds 5MB cap
    const LARGE_PAYLOAD = "x".repeat(50_000);
    const events = Array.from({ length: 120 }, (_, i) => ({ type: "assistant", index: i, payload: LARGE_PAYLOAD }));
    vi.mocked(query).mockReturnValue(makeIterator(events));

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const manager = new ExecutionManager();
    const task = {
      id: "task-transcript-cap",
      status: "pending" as const,
      prompt: "produce large output",
      config: { timeout: 60, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    };
    await manager.execute(task);

    const filePath = transcriptPath("task-transcript-cap");
    const stat = statSync(filePath);
    // File should be ≤ 5MB + one truncation marker line
    expect(stat.size).toBeLessThanOrEqual(5 * 1024 * 1024 + 200);

    const lines = readTranscriptLines("task-transcript-cap");
    // Last line must be the truncation marker
    const lastLine = JSON.parse(lines[lines.length - 1]);
    expect(lastLine).toMatchObject({ type: "truncated", reason: "size_cap" });

    // Not all 120 events made it (120 × 50KB = 6MB > 5MB)
    expect(lines.length).toBeLessThan(120);
  });

  // -------------------------------------------------------------------------
  // Case 5: pre-existing file with loose mode gets upgraded to 0o600
  // Before impl: pre-existing file stays at 0o644 → mode is 420 → FAIL
  // -------------------------------------------------------------------------
  it("pre-existing file with mode 0o644 is upgraded to 0o600 on first write", async () => {
    process.env.ADAM_PERSIST_SDK_TRANSCRIPTS = "1";

    // Pre-create the transcript file with world-readable mode (prior run before security fix)
    const preExistingPath = transcriptPath("task-transcript-upgrade");
    mkdirSync(transcriptDir(), { recursive: true, mode: 0o700 });
    writeFileSync(preExistingPath, "", { mode: 0o644 }); // world-readable — the bug

    // Verify pre-existing state
    expect(statSync(preExistingPath).mode & 0o777).toBe(0o644);

    vi.mocked(query).mockReturnValue(makeIterator([{ type: "result", result: "Done" }]));

    const { ExecutionManager } = await import("../../manager/execution-manager.js");
    const manager = new ExecutionManager();
    const task = {
      id: "task-transcript-upgrade",
      status: "pending" as const,
      prompt: "say hello",
      config: { timeout: 60, approvalRequired: [], approvalTimeout: 300 },
      createdAt: Date.now(),
    };
    await manager.execute(task);

    // After the helper's first invocation, the file's mode must be 0o600
    const finalMode = statSync(preExistingPath).mode & 0o777;
    expect(finalMode).toBe(0o600);
  });
});

