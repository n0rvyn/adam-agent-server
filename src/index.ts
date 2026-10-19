import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { loadDefaultConfig, getChatConfig } from "./config/index.js";
import { loadDotEnv } from "./config/dotenv.js";
import { getDb, closeDb } from "./store/index.js";
// Scheduler removed in Phase 8 — replaced by Manager Agent
import { buildApp } from "./server/app.js";
import { taskRoutes } from "./server/routes/tasks.js";
import { listTasks, updateTask } from "./store/tasks.js";
// workerRoutes removed in Phase 2 (entity model migration)
import { healthRoutes } from "./server/routes/health.js";
import { streamRoutes } from "./server/ws/route.js";
import { registerGlobalEvents } from "./server/ws/global-events.js";
// Orchestrator removed in Phase 8 — decompose_goal now in Manager tools
import { getServerState, updateWorkspacePath } from "./store/server-state.js";
// writeSkillPersona removed from startup — now called per-task in manager.ts (DP-002)
import { roleRoutes } from "./server/routes/roles.js";
import { fsRoutes } from "./server/routes/fs.js";
import { memoryRoutes } from "./server/routes/memories.js";
import { BreeEngine, setBreeEngine } from "./scheduler/bree-engine.js";
import { ChatManager, ExecutionPool } from "./manager/index.js";
import { setChatManager } from "./chat/message-handler.js";
import { getRuntimeConfig } from "./config/runtime.js";
import { taskTemplateRoutes } from "./server/routes/task-templates.js";
import { pluginRoutes } from "./server/routes/plugins.js";
import { extensionRoutes } from "./server/routes/extensions.js";
import { roleExtensionRoutes } from "./server/routes/role-extensions.js";
import { webhookRoutes } from "./server/routes/webhooks.js";
import { webhookEventRoutes } from "./server/routes/webhooks-events.js";
import { eventDefRoutes } from "./server/routes/event-defs.js";
import { goalRoutes } from "./server/routes/goals.js";
import { strategyRoutes } from "./server/routes/strategies.js";
import { configRoutes } from "./server/routes/config.js";
import { auditRoutes } from "./server/routes/audit.js";
import { evolutionRoutes } from "./server/routes/evolution.js";
import { costRoutes } from "./server/routes/cost.js";
import { chatRoutes } from "./server/routes/chat.js";
import { featureRequestRoutes } from "./server/routes/feature-requests.js";
import { mistakePatternsRoutes } from "./server/routes/mistake-patterns.js";
import { presetsRoutes } from "./server/routes/presets.js";
import { channelRoutes, setChannelManager } from "./server/routes/channels.js";
import { registerChatStream } from "./server/ws/chat-stream.js";
import { initSessionManager, shutdownSessionManager } from "./chat/session-manager.js";
import { registerCompletionListener } from "./chat/message-handler.js";
import { startPromptExpirySweep } from "./chat/prompt-expiry.js";
import { ChannelManager } from "./channels/manager.js";
import { refreshEmailAdapterStatuses, registerEnabledBuiltInAdapters } from "./channels/built-in-adapters.js";
import { restartEmailGatewayFromConfig, stopEmailGateway } from "./channels/adapters/email/email-gateway.js";
import { initRuntimeConfig, loadPersistedConfig } from "./config/runtime.js";
import { initWatchdog, stopWatchdog } from "./platform/watchdog.js";
import { initDeliveryEngine, stopDeliveryEngine } from "./delivery/engine.js";
import { startAuditManager, stopAuditManager } from "./audit/audit-manager.js";
import { startEventDispatcher } from "./events/dispatcher.js";
import { stopAllEventDefSources, startEventDefSource } from "./events/sources/index.js";
import { listEventDefs } from "./store/event-defs.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import deliveryRulesRoutes from "./server/routes/delivery-rules.js";
import { templateExecutionRoutes } from "./server/routes/template-executions.js";
import { feedbackRoutes } from "./server/routes/feedback.js";
import { getLogger, setLogLevel, onLogEvent } from "./lib/logger.js";
import { serverBus } from "./server/events/server-bus.js";
import { RUNTIME_DIR } from "./shared/constants.js";
import { migrateRuntimeFiles, ensureRuntimeDir } from "./lib/migration.js";
import { seedConfig } from "./store/config.js";
import { collectSeedValues } from "./config/loader.js";
import { ensureApiKey } from "./config/bootstrap-api-key.js";
import { authRoutes } from "./server/routes/auth.js";
import { artifactRoutes } from "./server/routes/artifacts.js";
import multipart from "@fastify/multipart";
import { scanLegacyMcpServers } from "./extensions/legacy-mcp-servers-scanner.js";
import { redactSecrets } from "./security/redaction.js";

const log = getLogger("adam");

async function main(): Promise<void> {
  // Ensure runtime directory exists and migrate any legacy project-local files.
  // Must run before loadDotEnv() or getDb() so paths exist.
  ensureRuntimeDir();
  const migrated = migrateRuntimeFiles();
  if (migrated.length > 0) {
    console.log(`[adam] Migrated to ~/.adam/: ${migrated.join(", ")}`);
  }

  // Load .env files into process.env before anything else.
  // Priority: .env < .env.local < ADAM_ENV_FILE (e.g., ADAM_ENV_FILE=.env.test)
  const envFiles = loadDotEnv();

  log.info("Starting Adam Agent Server");
  if (envFiles.length > 0) {
    log.info({ files: envFiles }, "Loaded env files");
  }

  // Legacy env var warning: ADAM_WEBHOOK_API_KEY was removed in favor of unified
  // server.apiKey. Warn users so they migrate their external webhook callers.
  if (process.env.ADAM_WEBHOOK_API_KEY) {
    log.warn(
      "ADAM_WEBHOOK_API_KEY is set but no longer used. " +
      "Webhooks now share the same key as the rest of the API (server.apiKey / ADAM_API_KEY / ~/.adam/adam.key). " +
      "Update your external webhook callers to use that key, then unset ADAM_WEBHOOK_API_KEY.",
    );
  }

  // Load defaults + env/CLI overrides only (no YAML). DB config loaded after DB init.
  const config = loadDefaultConfig();
  initRuntimeConfig(config);

  // Pre-flight: verify env propagation for Manager LLM queries
  const anthropicKey = getRuntimeConfig().anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    log.warn("ANTHROPIC_API_KEY not set — configure via Settings UI or ~/.adam/.env");
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    log.info({ url: process.env.ANTHROPIC_BASE_URL }, "Using custom API base URL");
  }

  // Pre-flight: detect Claude Code CLI
  let cliPath = config.defaults?.claudeCodePath;
  try {
    if (!cliPath) {
      const { createRequire } = await import("node:module");
      const { dirname, join } = await import("node:path");
      const require = createRequire(import.meta.url);
      const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
      cliPath = join(dirname(sdkEntry), "cli.js");
    }
    const { execSync } = await import("node:child_process");
    const { chmodSync, accessSync, constants: fsConstants } = await import("node:fs");
    try {
      accessSync(cliPath!, fsConstants.X_OK);
    } catch {
      log.info({ path: cliPath }, "CLI not executable, fixing permissions");
      chmodSync(cliPath!, 0o755);
    }
    const cliVersion = execSync(`"${cliPath}" --version`, { timeout: 5000, encoding: "utf-8" }).trim();
    log.info({ path: cliPath, version: cliVersion }, "Claude Code CLI detected");
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    if (e.code === "ENOENT") {
      log.warn({ path: cliPath }, "Claude Code CLI not found. Task execution will fail. Install: npm i -g @anthropic-ai/claude-code");
    } else {
      log.warn({ path: cliPath, error: (e.stderr?.trim() || String(err)).slice(0, 200) }, "Claude Code CLI check failed");
    }
  }

  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  log.info({ tables: tables.map((t) => t.name).join(", ") }, "Database initialized");

  // Non-blocking startup scan: cache legacy mcp_servers count for /readyz + /extensions/legacy
  scanLegacyMcpServers(db);

  // Seed config DB from .env — fills keys not already in DB (INSERT OR IGNORE)
  const seeds = collectSeedValues();
  const seeded = seedConfig(seeds);
  if (seeded > 0) {
    log.info({ count: seeded }, "Seeded config DB from .env");
  }
  const { getAllConfig } = await import("./store/config.js");
  loadPersistedConfig(getAllConfig);
  // Re-apply log level from DB (may have been updated since initial loadConfig)
  const runtimeCfg = getRuntimeConfig();
  if (runtimeCfg.logging?.level) {
    setLogLevel(runtimeCfg.logging.level);
  }

  // Bootstrap API key: generate if missing, persist to DB + ~/.adam/adam.key,
  // seed auth-key module. In dev mode, also append to .env.local for shell export.
  // Must run after loadPersistedConfig (DB applied) and before buildApp (hook registration).
  const bootstrapKey = ensureApiKey(runtimeCfg, { devMode: process.env.NODE_ENV === "development" });
  config.server.apiKey = bootstrapKey;
  runtimeCfg.server.apiKey = bootstrapKey;

  log.info({ config: redactSecrets(runtimeCfg as unknown as Record<string, unknown>) }, "Config loaded (DB + defaults)");

  const serverState = getServerState();

  if (serverState.userTaskSessionId) {
    log.info({ sessionId: serverState.userTaskSessionId.slice(0, 8) }, "Recovering user task session");
  }
  updateWorkspacePath(process.cwd());

  // Initialize default roles (Phase 1: Skills absorbed into Roles)
  const { initializeDefaultRoles } = await import("./store/role-presets.js");
  const defaultRoles = initializeDefaultRoles();
  log.info({ count: defaultRoles.length }, "Roles initialized");

  // Initialize ChatManager + ExecutionPool (Phase 8: ChatManager + ExecutionPool split)
  const runtimeConfig = getRuntimeConfig();
  const executionConfig = runtimeConfig.execution ?? { maxConcurrent: 3, pollIntervalMs: 30_000 };

  const chatManager = new ChatManager();
  const executionPool = new ExecutionPool(executionConfig.maxConcurrent);

  setChatManager(chatManager);
  await chatManager.start();
  await executionPool.start();

  // Recover orphaned running tasks: tasks left in "running" status from a previous
  // server crash. Mark as failed so they don't block the pool or show stale data.
  const orphanedRunning = listTasks("running");
  if (orphanedRunning.length > 0) {
    log.warn({ count: orphanedRunning.length }, "Found orphaned running tasks from previous session — marking as failed");
    for (const t of orphanedRunning) {
      updateTask(t.id, {
        status: "failed",
        error: "Server restarted while task was running",
        completedAt: Date.now(),
      });
    }
  }

  // Build and start Fastify server
  const app = buildApp(config, config.server.apiKey);

  await app.register((instance) => taskRoutes(instance));
  await app.register(artifactRoutes);
  await app.register((instance) => healthRoutes(instance, config));
  await app.register(streamRoutes);
  await app.register(authRoutes);
  await app.register(roleRoutes);
  await app.register(presetsRoutes);
  await app.register(featureRequestRoutes);
  await app.register(mistakePatternsRoutes);
  await app.register(memoryRoutes);
  await app.register(goalRoutes);
  await app.register(strategyRoutes);

  // Initialize Task Hub (Bree engine)
  const breeEngine = new BreeEngine();
  setBreeEngine(breeEngine);
  await breeEngine.start();

  // Phase 5: start prompt expiry sweeper
  const promptExpiryIntervalMs = getChatConfig().promptExpiry?.intervalMs ?? 60 * 60 * 1000;
  startPromptExpirySweep(promptExpiryIntervalMs);

  await app.register((instance) => taskTemplateRoutes(instance, breeEngine));
  await app.register(pluginRoutes);
  await app.register((instance) => webhookRoutes(instance, breeEngine));
  await app.register(webhookEventRoutes);
  await app.register(eventDefRoutes);
  await app.register(configRoutes);
  await app.register(auditRoutes);
  await app.register(evolutionRoutes);
  await app.register(costRoutes);
  await app.register(chatRoutes);
  const channelManager = new ChannelManager();
  setChannelManager(channelManager);
  await app.register(channelRoutes);
  await app.register(registerChatStream);
  await app.register((instance) => registerGlobalEvents(instance));
  await app.register(fsRoutes);
  await app.register(deliveryRulesRoutes);
  await app.register(templateExecutionRoutes);
  await app.register(feedbackRoutes);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register((instance) => extensionRoutes(instance));
  await app.register((instance) => roleExtensionRoutes(instance));

  // Initialize chat session manager (cache warming + timeout poller)
  initSessionManager();
  registerCompletionListener();
  initDeliveryEngine();
  startEventDispatcher();

  // Crash recovery: re-register active event source handlers (cron + directory_watch)
  for (const def of listEventDefs({ enabled: true })) {
    startEventDefSource(def);
  }

  await startAuditManager();
  channelManager.startHealthMonitor();

  try {
    await registerEnabledBuiltInAdapters(channelManager);
  } catch (err) {
    log.error({ error: err }, "Failed to register built-in adapters at startup");
  }

  serverBus.on("config_changed", (event) => {
    if (!event.changes.some((change) => change.path.startsWith("emailGateway."))) return;
    const emailConfig = getRuntimeConfig().emailGateway;
    void (async () => {
      if (!emailConfig?.enabled) {
        await stopEmailGateway("config_disabled");
        refreshEmailAdapterStatuses(channelManager);
        return;
      }
      try {
        await restartEmailGatewayFromConfig(emailConfig, "config_changed");
      } catch (error) {
        log.warn({ error }, "EmailGateway restart failed after config change");
      } finally {
        refreshEmailAdapterStatuses(channelManager);
      }
    })();
  });

  const { host, port } = config.server;
  await app.listen({ host, port });
  log.info({ host, port }, "Server listening");

  // Watchdog (D-006): independent health monitor
  const watchdogConfig = config.watchdog ?? DEFAULT_CONFIG.watchdog!;
  initWatchdog(watchdogConfig, chatManager, executionPool, (alertMsg) => {
    log.warn({ alert: alertMsg }, "Watchdog alert");
  });

  // Wire log streaming to WebSocket via serverBus
  onLogEvent((entry) => {
    serverBus.emit({
      type: "log_event",
      timestamp: entry.time ?? Date.now(),
      level: entry.level ?? "info",
      component: entry.component ?? "adam",
      msg: entry.msg ?? "",
    });
  });

  // Write port file and signal ready to parent process (CLI daemon).
  // adam.key is written by ensureApiKey() at bootstrap time — no duplicate write here.
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(join(RUNTIME_DIR, "logs"), { recursive: true });
  writeFileSync(join(RUNTIME_DIR, "adam.port"), String(port));
  process.send?.({ type: "ready", port });

  const shutdown = async () => {
    log.info("Shutting down");
    stopWatchdog();
    stopAuditManager();
    shutdownSessionManager();
    stopDeliveryEngine();
    await stopEmailGateway("server_shutdown");
    await channelManager.stopAll();
    chatManager.stop();
    executionPool.stop();
    await breeEngine.stop();
    await stopAllEventDefSources();
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.fatal(err, "Fatal error");
  process.exit(1);
});
