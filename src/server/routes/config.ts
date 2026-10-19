import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getRuntimeConfig,
  updateMutableConfig,
  getNestedValue,
  MUTABLE_PATHS,
  RESTART_REQUIRED_PATHS,
} from "../../config/runtime.js";
import { setConfigValue, getAllConfig } from "../../store/config.js";
import { setLogLevel, type LogLevel } from "../../lib/logger.js";
import { getSandboxProvider, isSandboxAvailable } from "../../sandbox/provider.js";
import { serverBus } from "../events/server-bus.js";
import { responses } from "../response-schemas.js";
import { computeEnvDiff, syncDbToEnvFile, readEnvFile, readAllEnvVars, ENV_TO_CONFIG, isManagedEnvKey, coerceEnvValueForConfigPath } from "../../config/env-sync.js";
import { loadPersistedConfig } from "../../config/runtime.js";
import { z } from "zod/v4";
import { getResolvedOsCapabilityRegistry } from "../../shared/os-capabilities.js";
import {
  sendRoundtripProbe,
  testImapConnection,
  testSmtpConnection,
  type EmailGatewayTestResult,
} from "../../channels/adapters/email/email-gateway-tester.js";
import { getEmailGateway } from "../../channels/adapters/email/email-gateway.js";

interface ConfigPatchBody {
  [key: string]: unknown;
}

export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/config/email-gateway/status", async () => {
    const config = getRuntimeConfig().emailGateway;
    const gatewayStatus = getEmailGateway().getStatus();
    return {
      enabled: config?.enabled ?? false,
      configured: Boolean(config?.address && config.imap.host && config.smtp.host),
      lastStatus: gatewayStatus.status,
      lastCheckedAt: gatewayStatus.lastCheckedAt ?? null,
      lastError: gatewayStatus.lastError ?? null,
    };
  });

  fastify.post("/config/email-gateway/test-imap", async () => {
    return runEmailGatewayTest((config) => testImapConnection(config));
  });

  fastify.post("/config/email-gateway/test-smtp", async () => {
    return runEmailGatewayTest((config) => testSmtpConnection(config));
  });

  fastify.post("/config/email-gateway/test-roundtrip", async () => {
    return runEmailGatewayTest((config) => sendRoundtripProbe(config));
  });

  // GET /config — returns current config with mutability indication
  fastify.get(
    "/config",
    {
      schema: {
        tags: ["Config"],
        summary: "Get current configuration",
        description:
          "Returns the current server configuration with runtime-mutable vs restart-required indication for each setting.",
        response: responses.configGet,
      },
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      const config = getRuntimeConfig();
      const sandbox = getSandboxProvider();
      const sandboxAvailable = await isSandboxAvailable();

      const allPaths = [
        ...MUTABLE_PATHS,
        ...RESTART_REQUIRED_PATHS,
      ] as readonly string[];
      const configWithMeta: Record<
        string,
        { value: unknown; mutable: boolean }
      > = {};

      // Paths containing secrets that must be masked in GET responses
      const MASKED_PATHS = new Set([
        "anthropic.apiKey",
        "server.apiKey",
        "emailGateway.imap.auth.pass",
        "emailGateway.smtp.auth.pass",
      ]);

      for (const path of allPaths) {
        let value = getNestedValue(config, path);
        const mutable = (MUTABLE_PATHS as readonly string[]).includes(path);

        // Mask sensitive values
        if (MASKED_PATHS.has(path) && typeof value === "string" && value.length > 0) {
          value = value.slice(0, 5) + "****";
        }

        configWithMeta[path] = { value: value ?? null, mutable };
      }

      return {
        config: configWithMeta,
        mutable: [...MUTABLE_PATHS],
        restartRequired: [...RESTART_REQUIRED_PATHS],
        sandbox: {
          platform: sandbox.platform,
          available: sandboxAvailable,
        },
        osCapabilities: {
          registry: getResolvedOsCapabilityRegistry(sandbox.platform, sandboxAvailable),
        },
      };
    },
  );

  // PATCH /config — update mutable values (DP-001: partial success)
  fastify.patch<{ Body: ConfigPatchBody }>(
    "/config",
    {
      schema: {
        tags: ["Config"],
        summary: "Update runtime-mutable configuration",
        description:
          "Updates configuration values that can be changed at runtime. Restart-required settings are rejected but valid mutable changes are still applied (partial success).",
        response: responses.configPatch,
      },
    },
    async (
      request: FastifyRequest<{ Body: ConfigPatchBody }>,
      reply: FastifyReply,
    ) => {
      const updates = request.body;

      if (!updates || typeof updates !== "object") {
        return reply.status(400).send({
          success: false,
          updated: [],
          errors: ["Request body must be a JSON object with config key-value pairs"],
          message: "Validation error",
        });
      }

      const result = updateMutableConfig(updates, setConfigValue);

      // Apply logging.level change immediately if updated
      if (result.updated.includes("logging.level")) {
        const newLevel = updates["logging.level"];
        if (typeof newLevel === "string") {
          setLogLevel(newLevel as LogLevel);
        }
      }

      // Emit config_changed event for WebSocket broadcast
      if (result.updated.length > 0) {
        const config = getRuntimeConfig();
        const changes = result.updated.map((path) => ({
          path,
          value: getNestedValue(config, path),
        }));

        serverBus.emit({
          type: "config_changed",
          changes,
        });
      }

      return {
        success: result.errors.length === 0,
        updated: result.updated,
        errors: result.errors,
        message:
          result.errors.length === 0
            ? `Updated ${result.updated.length} configuration value(s)`
            : `Updated ${result.updated.length} value(s); ${result.errors.length} rejected`,
      };
    },
  );

  // GET /config/env-diff — returns diffs between DB and .env
  fastify.get("/config/env-diff", async () => {
    const dbConfig = getAllConfig();
    const diffs = computeEnvDiff(dbConfig);
    return { diffs, envFileExists: readEnvFile() !== null };
  });

  // POST /config/sync-to-env — write DB values to .env
  fastify.post("/config/sync-to-env", async () => {
    const dbConfig = getAllConfig();
    const changed = syncDbToEnvFile(dbConfig);
    return { success: true, changed };
  });

  // POST /config/load-from-env — read .env values into DB (managed + custom keys)
  fastify.post("/config/load-from-env", async () => {
    const allValues = readAllEnvVars();
    if (!allValues) return { success: false, error: ".env file not found" };
    let updated = 0;

    // Load managed keys (ANTHROPIC_* etc.)
    for (const [envKey, value] of Object.entries(allValues)) {
      const configPath = ENV_TO_CONFIG[envKey];
      if (configPath) { setConfigValue(configPath, coerceEnvValueForConfigPath(configPath, value)); updated++; }
    }

    // Load custom keys into defaults.env
    const customEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(allValues)) {
      if (isManagedEnvKey(key)) continue; // managed key, already handled
      if (key.startsWith("ANTHROPIC_") || key.startsWith("ADAM_")) continue;
      customEnv[key] = value;
    }
    if (Object.keys(customEnv).length > 0) {
      setConfigValue("defaults.env", customEnv);
      getRuntimeConfig().defaults.env = customEnv;
      updated += Object.keys(customEnv).length;
    }

    // Reload persisted config into runtime
    loadPersistedConfig(getAllConfig);
    return { success: true, updated };
  });

  // ===== Custom environment variables (defaults.env) =====

  const envVarKeySchema = z.string().max(256).regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "Env var key must match POSIX format: [A-Za-z_][A-Za-z0-9_]*"
  ).check(
    z.refine((k) => !k.startsWith("ANTHROPIC_"), "ANTHROPIC_* keys are managed in the Anthropic config section")
  );

  // GET /config/env — returns custom env vars with sensitive values masked
  fastify.get("/config/env", {
    schema: {
      tags: ["Config"],
      summary: "Get custom environment variables",
      description: "Returns global custom env vars (defaults.env). Sensitive values are masked.",
    },
  }, async () => {
    const config = getRuntimeConfig();
    const env = config.defaults?.env ?? {};
    return { env };
  });

  // PUT /config/env — full replace of custom env vars
  fastify.put<{ Body: Record<string, string> }>("/config/env", {
    schema: {
      tags: ["Config"],
      summary: "Replace all custom environment variables",
      description: "Full replacement of defaults.env. ANTHROPIC_* keys are rejected.",
    },
  }, async (request, reply) => {
    const schema = z.record(envVarKeySchema, z.string().max(4096)).check(
      z.refine((v) => Object.keys(v).length <= 100, "Maximum 100 environment variables")
    );
    const parseResult = schema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }

    const env = parseResult.data;
    setConfigValue("defaults.env", env);
    getRuntimeConfig().defaults.env = env;

    serverBus.emit({ type: "config_changed", changes: [{ path: "defaults.env", value: env }] });
    return { success: true, count: Object.keys(env).length };
  });

  // PATCH /config/env — partial update (read-modify-write; null value deletes key)
  fastify.patch<{ Body: Record<string, string | null> }>("/config/env", {
    schema: {
      tags: ["Config"],
      summary: "Partially update custom environment variables",
      description: "Add/update keys (string value) or delete keys (null value). ANTHROPIC_* keys are rejected.",
    },
  }, async (request, reply) => {
    const patchSchema = z.record(envVarKeySchema, z.string().max(4096).nullable());
    const parseResult = patchSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: z.prettifyError(parseResult.error) });
    }

    const current = { ...(getRuntimeConfig().defaults?.env ?? {}) };
    for (const [key, value] of Object.entries(parseResult.data)) {
      if (value === null) {
        delete current[key];
      } else {
        current[key] = value;
      }
    }

    if (Object.keys(current).length > 100) {
      return reply.status(400).send({ code: "VALIDATION_ERROR", message: "Maximum 100 environment variables" });
    }

    setConfigValue("defaults.env", current);
    getRuntimeConfig().defaults.env = current;

    serverBus.emit({ type: "config_changed", changes: [{ path: "defaults.env", value: current }] });
    return { success: true, count: Object.keys(current).length };
  });
}

async function runEmailGatewayTest(
  tester: (config: NonNullable<ReturnType<typeof getRuntimeConfig>["emailGateway"]>) => Promise<EmailGatewayTestResult>,
): Promise<EmailGatewayTestResult> {
  const config = getRuntimeConfig().emailGateway;
  if (!config) {
    return {
      ok: false,
      stage: "roundtrip",
      code: "unknown_error",
      message: "Email Gateway config is missing",
    };
  }
  return tester(config);
}
