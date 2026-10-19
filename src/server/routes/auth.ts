import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR } from "../../shared/constants.js";
import { setConfigValue } from "../../store/config.js";
import { getRuntimeConfig } from "../../config/runtime.js";
import { setAuthKey } from "../auth-key.js";
import { responses } from "../response-schemas.js";

const KEY_FILE = join(RUNTIME_DIR, "adam.key");

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /auth/verify — if request reaches here, the global hook accepted the key
  fastify.get(
    "/auth/verify",
    {
      schema: {
        tags: ["Auth"],
        summary: "Verify the provided API key is valid",
        security: [{ apiKey: [] }],
        response: responses.authVerify,
      },
    },
    async () => {
      return { ok: true };
    },
  );

  // POST /auth/rotate — generate a new key, persist, hot-reload, invalidate old
  fastify.post(
    "/auth/rotate",
    {
      schema: {
        tags: ["Auth"],
        summary: "Rotate the API key",
        description:
          "Generates a new API key, persists it to DB and ~/.adam/adam.key, " +
          "and makes it effective immediately without restart. " +
          "Returns 409 if ADAM_API_KEY env var is set (env overrides DB).",
        security: [{ apiKey: [] }],
        response: responses.authRotate,
      },
    },
    async (_request, reply: FastifyReply) => {
      if (process.env.ADAM_API_KEY) {
        return reply.status(409).send({
          code: "ROTATE_BLOCKED_BY_ENV",
          message:
            "ADAM_API_KEY env var is set and overrides DB config. " +
            "Unset the env var (or remove it from .env.local) before rotating.",
        });
      }

      const newKey = randomBytes(32).toString("hex");

      setConfigValue("server.apiKey", newKey);
      writeFileSync(KEY_FILE, newKey, { mode: 0o600 });
      setAuthKey(newKey);
      getRuntimeConfig().server.apiKey = newKey;

      return { apiKey: newKey };
    },
  );
}
