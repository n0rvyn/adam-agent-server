import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Hoisted mock state (available before vi.mock factories) ---

const {
  mockCloseDb,
  mockLoadConfig,
  mockAppRegister,
  mockAppListen,
  mockAppClose,
  mockBreeStart,
  mockBreeStop,
  mockGetServerState,
  mockUpdateWorkspacePath,
  mockUpdateServerState,
  mockInitializePresets,
  mockWriteAgentPersona,
  mockWriteFileSync,
  mockMkdirSync,
  mockLogger,
  mockSetChatManager,
  mockInitializeDefaultRoles,
} = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  };
  return {
    mockCloseDb: vi.fn(),
    mockLoadConfig: vi.fn(),
    mockAppRegister: vi.fn(),
    mockAppListen: vi.fn(),
    mockAppClose: vi.fn(),
    mockBreeStart: vi.fn().mockResolvedValue(undefined),
    mockBreeStop: vi.fn().mockResolvedValue(undefined),
    mockGetServerState: vi.fn(),
    mockUpdateWorkspacePath: vi.fn(),
    mockUpdateServerState: vi.fn(),
    mockInitializePresets: vi.fn((): unknown[] => []),
  mockInitializeDefaultRoles: vi.fn((): unknown[] => []),
    mockWriteAgentPersona: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockLogger: logger,
    mockSetChatManager: vi.fn(),
  };
});

// --- vi.mock factories ---

vi.mock("fs", () => ({
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock("os", () => ({ homedir: () => "/tmp/test-home" }));

vi.mock("child_process", () => ({
  execSync: vi.fn(() => "2.1.81 (Claude Code)\n"),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  getLogger: () => mockLogger,
  setLogLevel: vi.fn(),
  onLogEvent: vi.fn(),
  logger: mockLogger,
}));

vi.mock("../store/index.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => [{ name: "tasks" }, { name: "agents" }]),
      run: vi.fn(),
      get: vi.fn(),
    })),
  })),
  closeDb: mockCloseDb,
}));

vi.mock("../config/index.js", () => ({
  loadConfig: mockLoadConfig,
  loadDefaultConfig: mockLoadConfig,
  getChatConfig: vi.fn(() => ({ promptExpiry: { intervalMs: 60 * 60 * 1000 } })),
}));

vi.mock("../config/loader.js", () => ({
  loadConfig: mockLoadConfig,
  loadDefaultConfig: mockLoadConfig,
  collectSeedValues: vi.fn(() => ({})),
}));

vi.mock("../config/dotenv.js", () => ({
  loadDotEnv: vi.fn(() => []),
}));

vi.mock("../config/runtime.js", () => {
  const runtimeConfig = {
    execution: { maxConcurrent: 3, pollIntervalMs: 30_000 },
  };
  return {
    initRuntimeConfig: (cfg: unknown) => { Object.assign(runtimeConfig, cfg); },
    getRuntimeConfig: () => runtimeConfig,
    loadPersistedConfig: vi.fn(),
    buildSdkAuthEnv: vi.fn(() => ({})),
    buildSdkEnv: vi.fn(() => ({})),
  };
});

vi.mock("../manager/index.js", () => ({
  ChatManager: vi.fn(function () {
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  }),
  ExecutionPool: vi.fn(function () {
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  }),
}));

vi.mock("../chat/message-handler.js", () => ({
  setChatManager: mockSetChatManager,
  registerCompletionListener: vi.fn(),
}));

vi.mock("../server/app.js", () => ({
  buildApp: vi.fn(() => ({
    register: mockAppRegister,
    listen: mockAppListen,
    close: mockAppClose,
  })),
}));

vi.mock("../server/routes/tasks.js", () => ({ taskRoutes: vi.fn() }));
vi.mock("../server/routes/health.js", () => ({ healthRoutes: vi.fn() }));
vi.mock("../server/ws/route.js", () => ({ streamRoutes: vi.fn() }));
vi.mock("../server/ws/global-events.js", () => ({ registerGlobalEvents: vi.fn() }));
vi.mock("../server/routes/memories.js", () => ({ memoryRoutes: vi.fn() }));
vi.mock("../server/routes/goals.js", () => ({ goalRoutes: vi.fn() }));
vi.mock("../server/routes/strategies.js", () => ({ strategyRoutes: vi.fn() }));
vi.mock("../server/routes/task-templates.js", () => ({ taskTemplateRoutes: vi.fn() }));
vi.mock("../server/routes/webhooks.js", () => ({ webhookRoutes: vi.fn() }));
vi.mock("../server/routes/webhooks-events.js", () => ({ webhookEventRoutes: vi.fn() }));
vi.mock("../server/routes/event-defs.js", () => ({ eventDefRoutes: vi.fn() }));
vi.mock("../server/routes/webhooks-events.js", () => ({ webhookEventRoutes: vi.fn() }));
vi.mock("../events/dispatcher.js", () => ({ startEventDispatcher: vi.fn() }));
vi.mock("../events/sources/index.js", () => ({
  startEventDefSource: vi.fn(),
  stopAllEventDefSources: vi.fn().mockResolvedValue(undefined),
  stopEventDefSource: vi.fn(),
}));
vi.mock("../store/event-defs.js", () => ({
  listEventDefs: vi.fn(() => []),
}));
vi.mock("../server/routes/plugins.js", () => ({ pluginRoutes: vi.fn() }));
vi.mock("../store/plugin-sync.js", () => ({ syncPlugins: vi.fn() }));
vi.mock("../lib/migration.js", () => ({
  migrateRuntimeFiles: vi.fn(() => []),
  ensureRuntimeDir: vi.fn(),
}));
vi.mock("../server/routes/chat.js", () => ({ chatRoutes: vi.fn() }));
vi.mock("../chat/session-manager.js", () => ({ initSessionManager: vi.fn(), shutdownSessionManager: vi.fn() }));
vi.mock("../server/routes/channels.js", () => ({ channelRoutes: vi.fn(), setChannelManager: vi.fn() }));
vi.mock("../channels/manager.js", () => ({
  ChannelManager: vi.fn(function () {
    return { startHealthMonitor: vi.fn(), stopAll: vi.fn().mockResolvedValue(undefined), startAll: vi.fn() };
  }),
}));
vi.mock("../channels/built-in-adapters.js", () => ({
  registerEnabledBuiltInAdapters: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../channels/adapters/email/email-gateway.js", () => ({
  restartEmailGatewayFromConfig: vi.fn().mockResolvedValue(undefined),
  stopEmailGateway: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../server/ws/chat-stream.js", () => ({ registerChatStream: vi.fn() }));

vi.mock("../scheduler/bree-engine.js", () => ({
  BreeEngine: vi.fn(function () {
    return { start: mockBreeStart, stop: mockBreeStop };
  }),
  setBreeEngine: vi.fn(),
  getBreeEngine: vi.fn(() => null),
}));

vi.mock("../store/server-state.js", () => ({
  getServerState: mockGetServerState,
  updateWorkspacePath: mockUpdateWorkspacePath,
  updateServerState: mockUpdateServerState,
}));

vi.mock("../manager/adam-tools.js", () => ({
  createAdamTools: vi.fn(() => ({})),
}));

vi.mock("../store/role-presets.js", () => ({
  initializeDefaultRoles: mockInitializeDefaultRoles,
}));

vi.mock("../agent/persona.js", () => ({
  writeRolePersona: mockWriteAgentPersona,
}));

vi.mock("../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock("../delivery/engine.js", () => ({
  initDeliveryEngine: vi.fn(),
  stopDeliveryEngine: vi.fn(),
}));
vi.mock("../server/routes/delivery-rules.js", () => ({ default: vi.fn() }));
vi.mock("../server/routes/config.js", () => ({ configRoutes: vi.fn() }));
vi.mock("../server/routes/evolution.js", () => ({ evolutionRoutes: vi.fn() }));
vi.mock("../store/config.js", () => ({
  isConfigEmpty: vi.fn(() => true),
  seedConfig: vi.fn(() => 0),
  getAllConfig: vi.fn(() => ({})),
  setConfigValue: vi.fn(),
  getConfigValue: vi.fn(),
  deleteConfigValue: vi.fn(),
}));

vi.mock("../store/tasks.js", () => ({
  listTasks: vi.fn(() => []),
  updateTask: vi.fn(),
}));

// --- Default config ---

function defaultConfig(overrides?: Record<string, unknown>) {
  return {
    server: { host: "127.0.0.1", port: 3000 },
    defaults: {
      model: "claude-sonnet-4-20250514",
      env: { ANTHROPIC_API_KEY: "sk-ant-1234abcd" },
    },
    skills: { presets: [{ name: "test-agent", roleId: "engineer" }] },
    ...overrides,
  };
}

// --- Test Suite ---

describe("src/index.ts", () => {
  let originalProcessSend: typeof process.send;
  let originalProcessExit: typeof process.exit;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let signalHandlers: Record<string, (() => void)>;

  beforeEach(() => {
    vi.clearAllMocks();
    signalHandlers = {};

    originalProcessSend = process.send as typeof process.send;
    originalProcessExit = process.exit;
    process.send = vi.fn();
    process.exit = vi.fn() as never;

    processOnSpy = vi.spyOn(process, "on").mockImplementation(
      (event: string | symbol, handler: (...args: any[]) => void) => {
        signalHandlers[String(event)] = handler as () => void;
        return process;
      },
    );

    // Default happy-path mocks
    mockLoadConfig.mockReturnValue(defaultConfig());
    mockGetServerState.mockReturnValue({ id: 1, createdAt: Date.now() });
    mockInitializePresets.mockReturnValue([]);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    process.send = originalProcessSend;
    process.exit = originalProcessExit;
  });

  async function importIndex() {
    vi.resetModules();
    await import("../index.js");
    await vi.waitFor(
      () => { expect(mockAppListen).toHaveBeenCalled(); },
      { timeout: 5000 },
    );
  }

  it("starts server and logs config with masked env values", async () => {
    await importIndex();

    const configLogCall = mockLogger.info.mock.calls.find(
      (args: unknown[]) => args[1] === "Config loaded (DB + defaults)",
    );
    expect(configLogCall).toBeDefined();
    const configObj = configLogCall![0] as { config: Record<string, unknown> };
    const masked = configObj.config as Record<string, unknown>;
    const defaults = masked["defaults"] as Record<string, unknown>;
    const env = defaults["env"] as Record<string, string>;
    expect(env["ANTHROPIC_API_KEY"]).toBe("[REDACTED]");
    expect(env["ANTHROPIC_API_KEY"]).not.toContain("sk-a");
    expect(env["ANTHROPIC_API_KEY"]).not.toBe("sk-ant-1234abcd");
  });

  it("handles config without defaults.env", async () => {
    mockLoadConfig.mockReturnValue(
      defaultConfig({ defaults: { model: "claude-sonnet-4-20250514" } }),
    );
    await importIndex();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.any(Object) }),
      "Config loaded (DB + defaults)",
    );
  });

  it("handles config without defaults at all", async () => {
    mockLoadConfig.mockReturnValue(defaultConfig({ defaults: undefined }));
    await importIndex();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.any(Object) }),
      "Config loaded (DB + defaults)",
    );
  });

  it("handles empty env value in defaults", async () => {
    mockLoadConfig.mockReturnValue(
      defaultConfig({
        defaults: { model: "claude-sonnet-4-20250514", env: { KEY: "" } },
      }),
    );
    await importIndex();
  });

  // Removed 3 tests asserting on SDK session recovery / workspace mismatch / fresh-start logs —
  // those entire log statements were deleted in 2026-05-14-chatmanager-persist-session plan Task 3
  // (issue #221: ChatManager no longer persists or resumes SDK session).
  // Tests asserting on removed behavior are deleted, not stubbed.

  it("does NOT write agent personas at startup (DP-002: removed startup loop)", async () => {
    const mockRoles = [
      { id: "r1", name: "role1" },
    ];
    mockInitializeDefaultRoles.mockReturnValue(mockRoles);

    let callCount = 0;
    mockGetServerState.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 1, createdAt: Date.now() };
      return { id: 1, workspacePath: "/test/workspace", createdAt: Date.now() };
    });

    await importIndex();

    // Persona write moved to per-task dispatch in manager.ts (Phase 1 identity fix)
    expect(mockWriteAgentPersona).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
      "Roles initialized",
    );
  });

  it("skips writing personas when no system agents", async () => {
    mockInitializeDefaultRoles.mockReturnValue([]);

    let callCount = 0;
    mockGetServerState.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return { id: 1, createdAt: Date.now() };
      return { id: 1, workspacePath: "/test/workspace", createdAt: Date.now() };
    });

    await importIndex();

    expect(mockWriteAgentPersona).not.toHaveBeenCalled();
  });

  it("registers all routes (32 total)", async () => {
    await importIndex();
    expect(mockAppRegister).toHaveBeenCalledTimes(32);
  });

  it("starts BreeEngine, ChatManager, and ExecutionPool", async () => {
    await importIndex();
    expect(mockBreeStart).toHaveBeenCalled();
    // ChatManager and ExecutionPool are constructed and start() is called
    const { ChatManager, ExecutionPool } = await import("../manager/index.js");
    expect(ChatManager).toHaveBeenCalled();
    expect(ExecutionPool).toHaveBeenCalled();
  });

  it("writes port file and sends ready signal", async () => {
    await importIndex();

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".adam"),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("adam.port"),
      "3000",
    );
    expect(process.send).toHaveBeenCalledWith({ type: "ready", port: 3000 });
  });

  it("registers SIGINT and SIGTERM handlers", async () => {
    await importIndex();
    expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });

  it("shutdown handler stops all services", async () => {
    await importIndex();

    expect(signalHandlers["SIGINT"]).toBeDefined();
    await signalHandlers["SIGINT"]();

    await vi.waitFor(() => {
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    // ChatManager.stop() and ExecutionPool.stop() called during shutdown
    expect(mockBreeStop).toHaveBeenCalled();
    expect(mockAppClose).toHaveBeenCalled();
    expect(mockCloseDb).toHaveBeenCalled();
  });

  it("marks orphaned running tasks as failed on startup", async () => {
    const { listTasks, updateTask } = await import("../store/tasks.js");
    const mockListTasksFn = listTasks as ReturnType<typeof vi.fn>;
    const mockUpdateTaskFn = updateTask as ReturnType<typeof vi.fn>;

    // Return running tasks when listTasks("running") is called
    mockListTasksFn.mockImplementation((status: string) => {
      if (status === "running") {
        return [
          { id: "orphan-1", status: "running" },
          { id: "orphan-2", status: "running" },
        ];
      }
      return [];
    });

    await importIndex();

    expect(mockUpdateTaskFn).toHaveBeenCalledWith("orphan-1", expect.objectContaining({
      status: "failed",
      error: "Server restarted while task was running",
    }));
    expect(mockUpdateTaskFn).toHaveBeenCalledWith("orphan-2", expect.objectContaining({
      status: "failed",
      error: "Server restarted while task was running",
    }));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining("orphaned running tasks"),
    );

    // Reset for other tests
    mockListTasksFn.mockReturnValue([]);
  });

  it("calls process.exit(1) on fatal error", async () => {
    const { ChatManager } = await import("../manager/index.js");
    (ChatManager as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
      return { start: vi.fn().mockRejectedValue(new Error("manager failed")), stop: vi.fn() };
    });

    vi.resetModules();
    await import("../index.js");

    await vi.waitFor(
      () => { expect(process.exit).toHaveBeenCalledWith(1); },
      { timeout: 5000 },
    );

    expect(mockLogger.fatal).toHaveBeenCalledWith(
      expect.any(Error),
      "Fatal error",
    );
  });
});
