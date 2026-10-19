/**
 * Unit tests for Watchdog ChatManager recovery state machine (Task 3).
 *
 * Covers the AR-1 (per-tick re-evaluation, no latch) and AR-2 (watchdog-owned
 * restart-attempt counter, decoupled from ChatManager.consecutiveStaleCount) fixes:
 *   - seq1: stale first appears under action=restart → restartSession called, no onAlert.
 *   - seq2: persistent stale → restartSession called on EVERY tick (not latched), and after
 *           MAX_RESTART_ATTEMPTS reached, process.exit(1) hands off to supervisor.
 *   - seq3: recovery (work drained) → state resets, "resumed activity", no further restart.
 *   - seq4: stale again after recovery → re-arms from attempt 1 (counter was reset).
 *
 * Driver mirrors watchdog.test.ts: initWatchdog + fake timers, one tick per interval.
 */
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
  updateContextMeta: vi.fn(),
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
    managerHealthCheck: { enabled: true, action: "restart", staleDurationMinutes: 1 },
    staleTasks: { enabled: false, action: "notify", maxPendingMinutes: 1 },
    staleRunningTasks: { enabled: false, action: "notify", maxRunningMinutes: 15 },
    dbMaintenance: { enabled: false, action: "ignore", walCheckpointThresholdMB: 100 },
    artifactCleanup: { enabled: false, action: "ignore", ttlDays: 7, orphanGcMinAgeHours: 1 },
    sandboxViolation: { enabled: false, action: "alert" as const },
  };
  const { enabled = true, intervalMinutes = 1, rules: ruleOverrides } = overrides;
  return { enabled, intervalMinutes, rules: { ...defaultRules, ...ruleOverrides } };
}

/** ChatManager stub whose stale/work signals can be mutated between ticks. */
function makeControllableChatManager() {
  const state = { lastActivityMsAgo: 120_000, queueDepth: 1, isProcessing: false };
  return {
    state,
    getLastActivityAt: vi.fn(() => Date.now() - state.lastActivityMsAgo),
    getConsecutiveStaleCount: vi.fn(() => 0),
    getQueueDepth: vi.fn(() => state.queueDepth),
    isProcessing: vi.fn(() => state.isProcessing),
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

const TICK = 60_000; // intervalMinutes=1

describe("Watchdog ChatManager recovery state machine", () => {
  let exitMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockListTasks.mockReturnValue([]);
    mockListExpiredExecutions.mockReturnValue([]);
    mockListArtifactsByExecution.mockReturnValue([]);
    mockDeleteArtifactsByExecution.mockReturnValue([]);
    mockGcOrphanBlobs.mockReturnValue(0);
    mockListStaleRunningExecutions.mockReturnValue([]);
    exitMock = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  });

  afterEach(() => {
    stopWatchdog();
    exitMock.mockRestore();
    vi.useRealTimers();
  });

  // seq1
  it("seq1: triggers restartSession on first stale tick under action=restart (no onAlert)", () => {
    const cm = makeControllableChatManager();
    const onAlert = vi.fn();
    initWatchdog(makeConfig(), cm as never, makeExecutionPool() as never, onAlert);

    vi.advanceTimersByTime(TICK);

    expect(cm.restartSession).toHaveBeenCalledTimes(1);
    expect(onAlert).not.toHaveBeenCalled(); // restart action never alerts
    expect(exitMock).not.toHaveBeenCalled();
  });

  // seq2 — AR-1: per-tick re-evaluation (not latched) + escalate via onAlert after MAX, NEVER exit
  it("seq2: re-attempts restartSession every tick and escalates via onAlert (no process.exit) after MAX", () => {
    const cm = makeControllableChatManager();
    const onAlert = vi.fn();
    initWatchdog(makeConfig(), cm as never, makeExecutionPool() as never, onAlert);

    // tick 1 → attempt 1 (restart)
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(1);
    expect(onAlert).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();

    // tick 2 → attempt 2 (restart) — proves the old rising-edge latch is gone (AR-1)
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(2);
    expect(onAlert).not.toHaveBeenCalled();

    // tick 3 → attempt MAX+1: still restarts (keeps trying), escalates to human ONCE, never exits
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(3);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(exitMock).not.toHaveBeenCalled();

    // tick 4 → keeps retrying in-process; no second escalation alert
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(4);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(exitMock).not.toHaveBeenCalled();
  });

  // seq3 — recovery resets the state machine
  it("seq3: resets stale state and stops restarting once work drains", () => {
    const cm = makeControllableChatManager();
    const onAlert = vi.fn();
    initWatchdog(makeConfig(), cm as never, makeExecutionPool() as never, onAlert);

    // one stale tick → one restart
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(1);

    // work drains → no longer stale
    cm.state.queueDepth = 0;
    cm.state.isProcessing = false;
    vi.advanceTimersByTime(TICK);

    // recovery tick must NOT restart again, must NOT exit
    expect(cm.restartSession).toHaveBeenCalledTimes(1);
    expect(exitMock).not.toHaveBeenCalled();
  });

  // seq4 — re-arm: stale again after recovery starts a fresh attempt budget
  it("seq4: re-arms after recovery — fresh stale episode restarts from attempt 1 without re-escalating", () => {
    const cm = makeControllableChatManager();
    const onAlert = vi.fn();
    initWatchdog(makeConfig(), cm as never, makeExecutionPool() as never, onAlert);

    // first stale episode: 3 ticks → 3 restarts, escalation alert fires once at MAX+1, never exits
    vi.advanceTimersByTime(TICK); // attempt 1
    vi.advanceTimersByTime(TICK); // attempt 2
    vi.advanceTimersByTime(TICK); // attempt 3 = MAX+1 → escalate
    expect(cm.restartSession).toHaveBeenCalledTimes(3);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(exitMock).not.toHaveBeenCalled();

    // recover (work drains) → state machine resets and re-arms
    cm.state.queueDepth = 0;
    vi.advanceTimersByTime(TICK);

    // stale again → fresh budget: restarts from attempt 1, NO new escalation (counter was reset)
    cm.state.queueDepth = 1;
    vi.advanceTimersByTime(TICK);
    expect(cm.restartSession).toHaveBeenCalledTimes(4); // one fresh restart
    expect(onAlert).toHaveBeenCalledTimes(1); // counter reset → no second escalation yet
    expect(exitMock).not.toHaveBeenCalled();
  });
});
