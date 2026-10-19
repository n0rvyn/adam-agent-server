import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod/v4";
import { RUNTIME_DIR } from "../../shared/constants.js";
import { parseMcpb, McpbParseError, type McpbManifest } from "../../extensions/mcpb-parser.js";
import {
  createOrUpgradeExtension,
  getExtensionByName,
  getExtensionById,
  listExtensions,
  deleteExtension,
  updateDefaultConfig,
  writeEnvMirror,
} from "../../store/extensions.js";
import { getDb } from "../../store/db.js";
import {
  getLegacyMcpServersSnapshot,
  refreshLegacyMcpServersScan,
} from "../../extensions/legacy-mcp-servers-scanner.js";
import { getHealth, listHealth } from "../../store/extension-health.js";

function getExtensionsRoot(): string {
  return join(process.env.ADAM_TEST_DIR ?? RUNTIME_DIR, "extensions");
}

const patchBodySchema = z.object({
  defaultConfigJson: z.record(z.string(), z.unknown()),
});

export async function extensionRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /extensions — upload a .mcpb package
  fastify.post(
    "/extensions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Expect multipart/form-data; reject non-multipart
      if (!request.headers["content-type"]?.includes("multipart/form-data")) {
        return reply.status(400).send({ code: "NO_FILE", message: "Expected multipart/form-data request" });
      }

      let fileData: { filename: string; buffer: Buffer } | undefined;
      try {
        const part = await (request as unknown as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
        if (!part) {
          return reply.status(400).send({ code: "NO_FILE", message: "No file part found in request" });
        }
        const buffer = await part.toBuffer();
        fileData = { filename: part.filename, buffer };
      } catch (err: unknown) {
        // @fastify/multipart throws RequestFileTooLargeError when limit hit
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("File too large") || errMsg.includes("RequestFileTooLarge") || (err as { code?: string }).code === "FST_FILES_LIMIT_REACHED" || (err as { statusCode?: number }).statusCode === 413) {
          return reply.status(413).send({ code: "FILE_TOO_LARGE", message: "File exceeds 10 MB limit" });
        }
        return reply.status(400).send({ code: "MULTIPART_ERROR", message: errMsg });
      }

      if (!fileData) {
        return reply.status(400).send({ code: "NO_FILE", message: "No file part found in request" });
      }

      // Parse the .mcpb package
      let parsed: Awaited<ReturnType<typeof parseMcpb>>;
      try {
        parsed = parseMcpb(fileData.buffer);
      } catch (err) {
        if (err instanceof McpbParseError) {
          return reply.status(400).send({ code: err.code, message: err.message });
        }
        return reply.status(400).send({ code: "PARSE_ERROR", message: String(err) });
      }

      const { manifest, files, packageHash } = parsed;
      const extensionsRoot = getExtensionsRoot();
      const targetDir = join(extensionsRoot, manifest.name);
      const tempDir = join(extensionsRoot, `.tmp-${randomUUID()}`);
      let bakDir: string | undefined;

      try {
        // Write to temp dir
        for (const [filePath, fileBuffer] of files.entries()) {
          const dest = join(tempDir, filePath);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, fileBuffer);
        }

        // D-009: if target already exists, back it up first
        if (existsSync(targetDir)) {
          bakDir = `${targetDir}.bak-${Date.now()}`;
          renameSync(targetDir, bakDir);
        }

        // Atomic rename temp → target
        mkdirSync(extensionsRoot, { recursive: true });
        renameSync(tempDir, targetDir);

        // Remove backup on success
        if (bakDir && existsSync(bakDir)) {
          rmSync(bakDir, { recursive: true, force: true });
        }
      } catch (diskErr) {
        // Rollback disk changes
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
        if (bakDir && existsSync(bakDir) && !existsSync(targetDir)) {
          // Restore from backup
          try {
            renameSync(bakDir, targetDir);
          } catch {
            // best-effort
          }
        }
        return reply.status(500).send({ code: "DISK_ERROR", message: String(diskErr) });
      }

      // Build defaultConfigJson from manifest user_config defaults
      const userConfig = manifest.user_config;
      let defaultConfigJson: string | null = null;
      if (userConfig && Object.keys(userConfig).length > 0) {
        const defaults: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(userConfig)) {
          if (field.default !== undefined) {
            defaults[key] = field.default;
          }
        }
        if (Object.keys(defaults).length > 0) {
          defaultConfigJson = JSON.stringify(defaults);
        }
      }

      const db = getDb();
      const extension = createOrUpgradeExtension(db, {
        name: manifest.name,
        version: manifest.version,
        manifestJson: JSON.stringify(manifest),
        installSource: "upload",
        packageHash,
        defaultConfigJson,
      });

      // Write .env mirror for sensitive user_config fields (non-blocking)
      void writeEnvMirror({
        name: manifest.name,
        defaultConfigJson: extension.defaultConfigJson,
        manifest,
      });

      return reply.status(201).send({ extension });
    },
  );

  // GET /extensions — list all extensions
  fastify.get("/extensions", async (_request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();
    const extensions = listExtensions(db);
    const healthRows = listHealth(db);
    const healthMap = new Map(healthRows.map((h) => [h.extensionId, h]));
    const extensionsWithHealth = extensions.map((ext) => ({
      ...ext,
      health: healthMap.get(ext.id) ?? null,
    }));
    return reply.status(200).send({ extensions: extensionsWithHealth });
  });

  // GET /extensions/legacy — list roles with non-empty mcp_servers (cached)
  fastify.get("/extensions/legacy", async (_request: FastifyRequest, reply: FastifyReply) => {
    const snapshot = getLegacyMcpServersSnapshot();
    return reply.status(200).send({ count: snapshot.count, rows: snapshot.rows });
  });

  // POST /extensions/legacy/clear/:roleId — zero out mcp_servers for a specific role
  fastify.post(
    "/extensions/legacy/clear/:roleId",
    async (
      request: FastifyRequest<{ Params: { roleId: string } }>,
      reply: FastifyReply,
    ) => {
      const { roleId } = request.params;
      const db = getDb();

      // Check role exists and has non-empty mcp_servers
      const snapshot = getLegacyMcpServersSnapshot();
      const roleInSnapshot = snapshot.rows.find((r) => r.roleId === roleId);
      if (!roleInSnapshot) {
        // Also check DB directly in case snapshot is stale
        const row = db
          .prepare("SELECT id FROM roles WHERE id = ?")
          .get(roleId) as { id: string } | undefined;
        if (!row) {
          return reply.status(404).send({ code: "NOT_FOUND", message: `Role '${roleId}' not found` });
        }
      }

      db.prepare("UPDATE roles SET mcp_servers = '{}' WHERE id = ?").run(roleId);
      refreshLegacyMcpServersScan(db);

      return reply.status(204).send();
    },
  );

  // GET /extensions/:name — get single extension
  fastify.get(
    "/extensions/:name",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const db = getDb();
      const extension = getExtensionByName(db, name);
      if (!extension) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `Extension '${name}' not found` });
      }
      const health = getHealth(db, extension.id);
      return reply.status(200).send({ extension: { ...extension, health } });
    },
  );

  // PATCH /extensions/:name — update default_config_json only
  fastify.patch(
    "/extensions/:name",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const db = getDb();
      const existing = getExtensionByName(db, name);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `Extension '${name}' not found` });
      }

      const parseResult = patchBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: "INVALID_BODY",
          message: z.prettifyError(parseResult.error),
        });
      }

      const { defaultConfigJson } = parseResult.data;
      const updated = updateDefaultConfig(db, existing.id, JSON.stringify(defaultConfigJson));

      // Rewrite .env mirror after config update (non-blocking)
      if (updated) {
        let parsedManifest: McpbManifest | undefined;
        try {
          parsedManifest = JSON.parse(updated.manifestJson) as McpbManifest;
        } catch {
          // best-effort
        }
        if (parsedManifest) {
          void writeEnvMirror({
            name: updated.name,
            defaultConfigJson: updated.defaultConfigJson,
            manifest: parsedManifest,
          });
        }
      }

      return reply.status(200).send({ extension: updated });
    },
  );

  // POST /extensions/:name/sync-to-env — idempotent re-sync of .env mirror
  fastify.post(
    "/extensions/:name/sync-to-env",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const db = getDb();
      const extension = getExtensionByName(db, name);
      if (!extension) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `Extension '${name}' not found` });
      }

      let parsedManifest: McpbManifest | undefined;
      try {
        parsedManifest = JSON.parse(extension.manifestJson) as McpbManifest;
      } catch {
        return reply.status(500).send({ code: "MANIFEST_PARSE_ERROR", message: "Failed to parse stored manifest" });
      }

      const envPath = join(getExtensionsRoot(), name, ".env");
      await writeEnvMirror({
        name: extension.name,
        defaultConfigJson: extension.defaultConfigJson,
        manifest: parsedManifest,
      });

      return reply.status(200).send({ envPath });
    },
  );

  // DELETE /extensions/:name — remove extension row + disk files
  fastify.delete(
    "/extensions/:name",
    async (
      request: FastifyRequest<{ Params: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params;
      const db = getDb();
      const existing = getExtensionByName(db, name);
      if (!existing) {
        return reply.status(404).send({ code: "NOT_FOUND", message: `Extension '${name}' not found` });
      }

      // Delete DB row first (FK cascade handles role_extensions / extension_health)
      deleteExtension(db, existing.id);

      // Remove disk files
      const targetDir = join(getExtensionsRoot(), name);
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true });
      }

      return reply.status(204).send();
    },
  );
}
