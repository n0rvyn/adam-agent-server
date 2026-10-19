import { createHash } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { z } from "zod/v4";

// ── McpbParseError ───────────────────────────────────────────────────────────

export class McpbParseError extends Error {
  constructor(
    public readonly code: "ZIP_SLIP" | "NO_MANIFEST" | "INVALID_MANIFEST",
    message: string,
  ) {
    super(message);
    this.name = "McpbParseError";
  }
}

// ── Manifest Zod Schema ──────────────────────────────────────────────────────

const userConfigFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean", "directory", "file"]),
    title: z.string(),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    multiple: z.boolean().optional(),
  })
  .strict(); // reject unknown keys like "label"

const manifestSchema = z
  .object({
    manifest_version: z.literal("0.3"),
    name: z.string().min(1).regex(/^[a-z0-9-]+$/),
    version: z.string().min(1),
    description: z.string(),
    display_name: z.string().optional(),
    author: z.object({
      name: z.string(),
      email: z.string().optional(),
      url: z.string().optional(),
    }),
    server: z.object({
      type: z.enum(["node", "python", "binary"]),
      entry_point: z.string().optional(),
      mcp_config: z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    }),
    user_config: z.record(z.string(), userConfigFieldSchema).optional(),
    tools: z
      .array(z.object({ name: z.string(), description: z.string().optional() }))
      .optional(),
    prompts: z.array(z.unknown()).optional(),
    compatibility: z.unknown().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown()) // D-S03 / top-level passthrough for unknown fields
  .refine(
    (m) => m.server.type !== "binary" || !!m.server.entry_point,
    { message: "binary type requires entry_point" },
  )
  .refine(
    (m) =>
      !m.user_config ||
      Object.values(m.user_config).every(
        (f) => !f.sensitive || f.type === "string",
      ),
    { message: "sensitive=true only valid on string type" },
  );

export type McpbManifest = z.infer<typeof manifestSchema>;

// ── parseMcpb ────────────────────────────────────────────────────────────────

export interface McpbParseResult {
  manifest: McpbManifest;
  files: Map<string, Buffer>;
  packageHash: string;
}

export function parseMcpb(buffer: Buffer): McpbParseResult {
  // 1. Compute hash over the raw buffer (deterministic)
  const packageHash = createHash("sha256").update(buffer).digest("hex");

  // 2. Open zip
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new McpbParseError("NO_MANIFEST", `Failed to open zip: ${err}`);
  }

  const entries = zip.getEntries();

  // 3. Zip-slip guard — check every entry before any extraction
  for (const entry of entries) {
    const normalized = path.normalize(entry.entryName);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw new McpbParseError(
        "ZIP_SLIP",
        `ZIP_SLIP: path traversal detected in entry "${entry.entryName}"`,
      );
    }
  }

  // 4. Find manifest.json
  const manifestEntry = entries.find(
    (e) => e.entryName === "manifest.json" && !e.isDirectory,
  );
  if (!manifestEntry) {
    throw new McpbParseError("NO_MANIFEST", "manifest.json not found in .mcpb package");
  }

  // 5. Parse + validate manifest
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  } catch (err) {
    throw new McpbParseError("INVALID_MANIFEST", `manifest.json is not valid JSON: ${err}`);
  }

  const parsed = manifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    throw new McpbParseError(
      "INVALID_MANIFEST",
      z.prettifyError(parsed.error),
    );
  }

  // 6. Build files map (non-directory entries only)
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isDirectory) {
      files.set(entry.entryName, entry.getData());
    }
  }

  return { manifest: parsed.data, files, packageHash };
}
