import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockGetLogger,
  mockListTasks,
  mockGetDb,
  mockListExpiredExecutions,
  mockListArtifactsByExecution,
  mockDeleteArtifactsByExecution,
  mockGcOrphanBlobs,
  mockUnlinkBlob,
  mockRemoveTemplateExecutionArtifactsDir,
  mockListStaleRunningExecutions,
  mockUpdateTemplateExecution,
} = vi.hoisted(() => ({
  mockGetLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  })),
  mockListTasks: vi.fn(),
  mockGetDb: vi.fn(),
  mockListExpiredExecutions: vi.fn(),
  mockListArtifactsByExecution: vi.fn(),
  mockDeleteArtifactsByExecution: vi.fn(),
  mockGcOrphanBlobs: vi.fn(),
  mockUnlinkBlob: vi.fn(),
  mockRemoveTemplateExecutionArtifactsDir: vi.fn(),
  mockListStaleRunningExecutions: vi.fn(),
  mockUpdateTemplateExecution: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: mockGetLogger,
}));

vi.mock("../../store/tasks.js", () => ({
  listTasks: mockListTasks,
  updateTask: vi.fn(),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn() },
}));

vi.mock("../../store/db.js", () => ({
  getDb: mockGetDb,
}));

vi.mock("../../store/artifacts.js", () => ({
  listExpiredExecutions: mockListExpiredExecutions,
  listArtifactsByExecution: mockListArtifactsByExecution,
  deleteArtifactsByExecution: mockDeleteArtifactsByExecution,
}));

vi.mock("../../store/template-executions.js", () => ({
  listStaleRunningExecutions: mockListStaleRunningExecutions,
  updateTemplateExecution: mockUpdateTemplateExecution,
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  gcOrphanBlobs: mockGcOrphanBlobs,
  unlinkBlob: mockUnlinkBlob,
  removeTemplateExecutionArtifactsDir: mockRemoveTemplateExecutionArtifactsDir,
}));

// Suppress console during tests
vi.spyOn(console, "log").mockImplementation(() => {});

import { initWatchdog, stopWatchdog } from "../../platform/watchdog.js";
import type { WatchdogConfig } from "../../shared/types.js";

type TestWatchdogConfig = Partial<Omit<WatchdogConfig, "rules">> & {
  rules?: Partial<WatchdogConfig["rules"]>;
};

function makeConfig(overrides: TestWatchdogConfig = {}): WatchdogConfig {
  const defaultRules: WatchdogConfig["rules"] = {
    managerHealthCheck: { enabled: true, action: "notify", staleDurationMinutes: 1 },
    staleTasks: { enabled: true, action: "notify", maxPendingMinutes: 1 },
    staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
    dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
    artifactCleanup: { enabled: false, action: "ignore", ttlDays: 7, orphanGcMinAgeHours: 1 },
    sandboxViolation: { enabled: false, action: "alert" as const },
  };

  const {
    enabled = true,
    intervalMinutes = 1,
    rules: ruleOverrides,
  } = overrides;

  return {
    enabled,
    intervalMinutes,
    rules: {
      ...defaultRules,
      ...ruleOverrides,
    },
  };
}

function makeChatManager(
  lastActivityMsAgo = 0,
  staleCount = 0,
  opts: { queueDepth?: number; isProcessing?: boolean } = {},
) {
  // Default queueDepth=1 so existing "stale fires" tests still trigger after the #218
  // idle-filter is in place. Tests that want to verify idle suppression pass queueDepth=0
  // and isProcessing=false explicitly.
  const queueDepth = opts.queueDepth ?? 1;
  const isProcessing = opts.isProcessing ?? false;
  return {
    getLastActivityAt: vi.fn(() => Date.now() - lastActivityMsAgo),
    getConsecutiveStaleCount: vi.fn(() => staleCount),
    getQueueDepth: vi.fn(() => queueDepth),
    isProcessing: vi.fn(() => isProcessing),
    isHealthy: vi.fn(() => true),
    restartSession: vi.fn().mockResolvedValue(undefined),
  };
}

function makeExecutionPool(isHealthy = true) {
  return {
    isHealthy: vi.fn(() => isHealthy),
    getStatus: vi.fn(() => ({ active: 0, max: 3, queued: 0 })),
    releaseSlot: vi.fn(),
  };
}

describe("Watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockListTasks.mockReturnValue([]);
    mockListExpiredExecutions.mockReturnValue([]);
    mockListArtifactsByExecution.mockReturnValue([]);
    mockDeleteArtifactsByExecution.mockReturnValue([]);
    mockGcOrphanBlobs.mockReturnValue(0);
    mockListStaleRunningExecutions.mockReturnValue([]);
    mockUpdateTemplateExecution.mockReset();
  });

  afterEach(() => {
    stopWatchdog();
    vi.useRealTimers();
  });

  it("does not start interval when enabled is false", () => {
    const config = makeConfig({ enabled: false });
    const chatManager = makeChatManager();
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);
    // Advance time significantly — alert should not fire
    vi.advanceTimersByTime(120_000);
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("runs ChatManager health check and calls onAlert when session is stale", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    // last activity was 2 minutes ago (> 1 minute stale duration)
    const chatManager = makeChatManager(120_000);
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    // Advance past the interval
    vi.advanceTimersByTime(60_000);
    expect(onAlert).toHaveBeenCalledWith(
      expect.stringContaining("ChatManager session stale"),
    );
  });

  it("calls chatManager.restartSession() when ChatManager health action is restart", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "restart", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(120_000);
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(chatManager.restartSession).toHaveBeenCalled();
    expect(onAlert).not.toHaveBeenCalled(); // restart action does not call onAlert
  });

  it("escalates via onAlert after MAX_RESTART_ATTEMPTS stale ticks and never calls process.exit", () => {
    // No process supervisor on this deployment, so the watchdog must NOT kill the server.
    // It keeps restarting in-process every tick and escalates to the human ONCE after
    // MAX_RESTART_ATTEMPTS=2 (i.e. on the 3rd stale tick); process.exit is never called.
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "restart", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(120_000);
    const executionPool = makeExecutionPool();
    const exitMock = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000); // attempt 1 — restart, no alert
    vi.advanceTimersByTime(60_000); // attempt 2 — restart, no alert
    expect(onAlert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000); // attempt 3 = MAX+1 → escalate to human once
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(chatManager.restartSession).toHaveBeenCalledTimes(3); // keeps retrying in-process
    expect(exitMock).not.toHaveBeenCalled();
  });

  // Regression coverage for #218: lastActivity is updated by chat traffic, so a server that
  // has been idle but is otherwise healthy must NOT be reported as stale.
  it("does NOT fire ChatManager stale when queue is empty and not processing (#218)", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    // last activity was 2 min ago BUT no pending work, no in-flight turn → idle, not stale
    const chatManager = makeChatManager(120_000, 0, { queueDepth: 0, isProcessing: false });
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("fires ChatManager stale when in-flight turn has stalled (queueDepth=0, isProcessing=true)", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    // Turn has been in-flight for 2 minutes with no SDK event progress → real stuck
    const chatManager = makeChatManager(120_000, 0, { queueDepth: 0, isProcessing: true });
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).toHaveBeenCalledWith(
      expect.stringContaining("inflight=true"),
    );
  });

  it("includes queueDepth in alert when queue is non-empty but stalled (#208 diagnostic)", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: true, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(120_000, 0, { queueDepth: 3, isProcessing: false });
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).toHaveBeenCalledWith(
      expect.stringContaining("queueDepth=3"),
    );
  });

  it("detects stale pending tasks and calls onAlert", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: true, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();
    const now = Date.now();
    mockListTasks.mockReturnValue([
      { id: "1", createdAt: now - 120_000 }, // 2 min old
      { id: "2", createdAt: now - 120_000 }, // 2 min old
    ]);
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).toHaveBeenCalledWith(
      expect.stringContaining("2 stale task(s)"),
    );
  });

  // #215: stale template_executions reconciliation
  it("reconciles orphaned TemplateExecutions whose child tasks are all terminal", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
        staleTemplateExecutions: { enabled: true, action: "notify", maxOrphanMinutes: 60 },
      },
    });
    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();

    mockListStaleRunningExecutions.mockReturnValue([
      {
        id: "exec-orphan-1",
        templateId: "tmpl-A",
        status: "running",
        stepStatuses: {
          step1: { taskId: "task-1", status: "completed" },
          step2: { taskId: "task-2", status: "failed" },
        },
        startedAt: Date.now() - 2 * 60 * 60_000,
      },
    ]);
    // All child tasks terminal
    mockGetDb.mockReturnValue({
      prepare: () => ({
        all: () => [
          { id: "task-1", status: "completed" },
          { id: "task-2", status: "failed" },
        ],
        run: () => ({}),
        get: () => undefined,
      }),
      pragma: () => 0,
    });

    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(mockUpdateTemplateExecution).toHaveBeenCalledWith(
      "exec-orphan-1",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("orphaned"),
      }),
    );
    expect(onAlert).toHaveBeenCalledWith(expect.stringContaining("TemplateExecution"));
  });

  it("does NOT reconcile TemplateExecutions that still have active child tasks", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
        staleTemplateExecutions: { enabled: true, action: "notify", maxOrphanMinutes: 60 },
      },
    });
    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();

    mockListStaleRunningExecutions.mockReturnValue([
      {
        id: "exec-live-1",
        templateId: "tmpl-A",
        status: "running",
        stepStatuses: {
          step1: { taskId: "task-1", status: "completed" },
          step2: { taskId: "task-2", status: "running" }, // still alive
        },
        startedAt: Date.now() - 2 * 60 * 60_000,
      },
    ]);
    mockGetDb.mockReturnValue({
      prepare: () => ({
        all: () => [
          { id: "task-1", status: "completed" },
          { id: "task-2", status: "running" },
        ],
        run: () => ({}),
        get: () => undefined,
      }),
      pragma: () => 0,
    });

    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(mockUpdateTemplateExecution).not.toHaveBeenCalled();
  });

  it("respects maxPendingMinutes threshold", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: true, action: "notify", maxPendingMinutes: 5 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();
    // Task is only 2 min old — below 5 min threshold
    const now = Date.now();
    mockListTasks.mockReturnValue([
      { id: "1", createdAt: now - 120_000 },
    ]);
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("does not alert when no stale tasks exist", () => {
    const config = makeConfig({
      intervalMinutes: 1,
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: true, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
      },
    });
    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();
    mockListTasks.mockReturnValue([]);
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("cleans expired TemplateExecution artifacts and orphan blobs", () => {
    const config = makeConfig({
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
        artifactCleanup: { enabled: true, action: "ignore", ttlDays: 7, orphanGcMinAgeHours: 2 },
      },
    });
    mockListExpiredExecutions.mockReturnValue(["exec-old"]);
    mockListArtifactsByExecution.mockReturnValue([
      { id: "art-keep", blobPath: "/tmp/keep.bin" },
    ]);
    mockDeleteArtifactsByExecution.mockReturnValue([
      { id: "art-keep", blobPath: "/tmp/keep.bin" },
      { id: "art-json" },
    ]);
    mockGcOrphanBlobs.mockReturnValue(2);

    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);

    expect(mockListExpiredExecutions).toHaveBeenCalledTimes(1);
    expect(mockGcOrphanBlobs).toHaveBeenCalledWith("exec-old", new Set(["art-keep"]), 2 * 60 * 60 * 1000);
    expect(mockDeleteArtifactsByExecution).toHaveBeenCalledWith("exec-old");
    expect(mockUnlinkBlob).toHaveBeenCalledWith("/tmp/keep.bin");
    expect(mockRemoveTemplateExecutionArtifactsDir).toHaveBeenCalledWith("exec-old");
    expect(onAlert).not.toHaveBeenCalled();
  });

  // Plan Task 9 "execution D": empty expired execution must still be cleaned.
  // Proves listExpiredExecutions queries template_executions (not artifacts),
  // so template-executions that called ensureArtifactsDir but never wrote rows are still swept.
  it("cleans expired template execution dir even when execution has no artifact rows", () => {
    const config = makeConfig({
      rules: {
        managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
        staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
        staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
        artifactCleanup: { enabled: true, action: "ignore", ttlDays: 7, orphanGcMinAgeHours: 1 },
      },
    });
    // Expired execution surfaced from template_executions, but NO artifact rows exist.
    mockListExpiredExecutions.mockReturnValue(["exec-empty"]);
    mockListArtifactsByExecution.mockReturnValue([]);
    mockDeleteArtifactsByExecution.mockReturnValue([]);
    mockGcOrphanBlobs.mockReturnValue(0);
    mockUnlinkBlob.mockClear();
    mockRemoveTemplateExecutionArtifactsDir.mockClear();

    const chatManager = makeChatManager(0);
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);

    vi.advanceTimersByTime(60_000);

    // orphan GC still invoked (swept with empty valid set)
    expect(mockGcOrphanBlobs).toHaveBeenCalledWith("exec-empty", new Set(), 60 * 60 * 1000);
    // delete still called (returns empty, safe no-op)
    expect(mockDeleteArtifactsByExecution).toHaveBeenCalledWith("exec-empty");
    // unlinkBlob must NOT be called (no artifacts to unlink)
    expect(mockUnlinkBlob).not.toHaveBeenCalled();
    // CRITICAL: empty {execId}/ tree must still be removed
    expect(mockRemoveTemplateExecutionArtifactsDir).toHaveBeenCalledWith("exec-empty");
  });

  describe("staleRunningTasks rule", () => {
    it("does nothing when rule is disabled", () => {
      const config = makeConfig({
        intervalMinutes: 1,
        rules: {
          managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
          staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
          staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
          dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
          sandboxViolation: { enabled: false, action: "alert" as const },
        },
      });
      const chatManager = makeChatManager(0);
      const executionPool = makeExecutionPool();
      const onAlert = vi.fn();
      initWatchdog(config, chatManager as never, executionPool as never, onAlert);

      vi.advanceTimersByTime(60_000);
      expect(onAlert).not.toHaveBeenCalled();
    });

    it("marks running tasks as failed when they have no step log activity exceeding maxRunningMinutes", async () => {
      const config = makeConfig({
        intervalMinutes: 1,
        rules: {
          managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
          staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
          staleRunningTasks: { enabled: true, action: "notify", maxRunningMinutes: 15 },
          dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
          sandboxViolation: { enabled: false, action: "alert" as const },
        },
      });
      const chatManager = makeChatManager(0);
      const executionPool = makeExecutionPool();
      const now = Date.now();

      // Running task started 20 min ago
      mockListTasks.mockImplementation((status: string) => {
        if (status === "running") {
          return [{ id: "stale-1", startedAt: now - 20 * 60_000 }];
        }
        return [];
      });

      // No recent step logs — getDb returns a db where latest is null
      const mockPrepare = vi.fn(() => ({
        get: vi.fn(() => ({ latest: null })),
      }));
      mockGetDb.mockReturnValue({ prepare: mockPrepare });

      const onAlert = vi.fn();
      initWatchdog(config, chatManager as never, executionPool as never, onAlert);

      vi.advanceTimersByTime(60_000);

      const { updateTask } = await import("../../store/tasks.js");
      expect(updateTask).toHaveBeenCalledWith("stale-1", expect.objectContaining({
        status: "failed",
        error: "Watchdog killed: no activity for 15 min",
      }));
      expect(onAlert).toHaveBeenCalledWith(expect.stringContaining("running with no activity"));
    });

    it("calls executionPool.releaseSlot() for each stale task", () => {
      const config = makeConfig({
        intervalMinutes: 1,
        rules: {
          managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
          staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
          staleRunningTasks: { enabled: true, action: "notify", maxRunningMinutes: 10 },
          dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
          sandboxViolation: { enabled: false, action: "alert" as const },
        },
      });
      const chatManager = makeChatManager(0);
      const executionPool = {
        ...makeExecutionPool(),
        releaseSlot: vi.fn(),
      };
      const now = Date.now();

      mockListTasks.mockImplementation((status: string) => {
        if (status === "running") {
          return [
            { id: "r-1", startedAt: now - 15 * 60_000 },
            { id: "r-2", startedAt: now - 12 * 60_000 },
          ];
        }
        return [];
      });

      const mockPrepare = vi.fn(() => ({
        get: vi.fn(() => ({ latest: null })),
      }));
      mockGetDb.mockReturnValue({ prepare: mockPrepare });

      const onAlert = vi.fn();
      initWatchdog(config, chatManager as never, executionPool as never, onAlert);

      vi.advanceTimersByTime(60_000);

      expect(executionPool.releaseSlot).toHaveBeenCalledWith("r-1");
      expect(executionPool.releaseSlot).toHaveBeenCalledWith("r-2");
    });

    it("does NOT mark running tasks that have recent step log activity", () => {
      const config = makeConfig({
        intervalMinutes: 1,
        rules: {
          managerHealthCheck: { enabled: false, action: "notify", staleDurationMinutes: 1 },
          staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
          staleRunningTasks: { enabled: true, action: "notify", maxRunningMinutes: 15 },
          dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
          sandboxViolation: { enabled: false, action: "alert" as const },
        },
      });
      const chatManager = makeChatManager(0);
      const executionPool = makeExecutionPool();
      const now = Date.now();

      // Task started 20 min ago BUT has recent step log activity (2 min ago)
      mockListTasks.mockImplementation((status: string) => {
        if (status === "running") {
          return [{ id: "active-1", startedAt: now - 20 * 60_000 }];
        }
        return [];
      });

      const mockPrepare = vi.fn(() => ({
        get: vi.fn(() => ({ latest: now - 2 * 60_000 })),
      }));
      mockGetDb.mockReturnValue({ prepare: mockPrepare });

      const onAlert = vi.fn();
      initWatchdog(config, chatManager as never, executionPool as never, onAlert);

      vi.advanceTimersByTime(60_000);

      expect(onAlert).not.toHaveBeenCalled();
    });
  });

  it("stopWatchdog clears the interval", () => {
    const config = makeConfig({ intervalMinutes: 1 });
    const chatManager = makeChatManager();
    const executionPool = makeExecutionPool();
    const onAlert = vi.fn();
    initWatchdog(config, chatManager as never, executionPool as never, onAlert);
    stopWatchdog();

    vi.advanceTimersByTime(120_000);
    expect(onAlert).not.toHaveBeenCalled();
  });
});
