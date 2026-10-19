import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseMcpb } from "../../extensions/mcpb-parser.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

/** Build an in-memory .mcpb buffer with the given manifest and optional extra files. */
function makeMcpbBuffer(manifest: object, extraFiles?: Record<string, Buffer>): Buffer {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      zip.addFile(name, content);
    }
  }
  return zip.toBuffer();
}

/** Build an .mcpb buffer with a path-traversal entry name (adm-zip normalizes addFile,
 *  so we must set entryName directly after adding). */
function makeMcpbBufferWithTraversalEntry(manifest: object): Buffer {
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest), "utf8"));
  // Add a benign entry then override its name to a traversal path
  zip.addFile("safe.txt", Buffer.from("harmless"));
  const entries = zip.getEntries();
  const safeEntry = entries.find((e) => e.entryName === "safe.txt");
  if (safeEntry) {
    // Direct property write bypasses adm-zip normalization
    (safeEntry as unknown as { entryName: string }).entryName = "../../etc/passwd";
  }
  return zip.toBuffer();
}

const VALID_MANIFEST = {
  manifest_version: "0.3",
  name: "test-ext",
  version: "1.0.0",
  description: "Test extension",
  author: { name: "Test Author" },
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: { command: "node", args: ["dist/index.js"] },
  },
};

describe("mcpb-parser", () => {
  it("parses a valid .mcpb buffer and returns {manifest, files, packageHash}", () => {
    const buffer = makeMcpbBuffer(VALID_MANIFEST, {
      "dist/index.js": Buffer.from("module.exports = {}"),
    });
    const result = parseMcpb(buffer);

    expect(result).toHaveProperty("manifest");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("packageHash");
    expect(result.manifest.name).toBeTruthy();
    expect(result.files).toBeInstanceOf(Map);
    expect(result.files.size).toBeGreaterThan(0);
    expect(result.packageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computes deterministic sha256 packageHash (same buffer = same hash)", () => {
    const buffer = makeMcpbBuffer(VALID_MANIFEST);
    const r1 = parseMcpb(buffer);
    const r2 = parseMcpb(buffer);
    expect(r1.packageHash).toBe(r2.packageHash);
  });

  it("rejects manifest with server.type='process'", () => {
    const buf = makeMcpbBuffer({
      ...VALID_MANIFEST,
      server: { ...VALID_MANIFEST.server, type: "process" },
    });
    expect(() => parseMcpb(buf)).toThrow();
  });

  it("rejects manifest with user_config.field.type='secret'", () => {
    const buf = makeMcpbBuffer({
      ...VALID_MANIFEST,
      user_config: {
        api_key: {
          type: "secret",
          title: "API Key",
        },
      },
    });
    expect(() => parseMcpb(buf)).toThrow();
  });

  it("rejects manifest with user_config.field.label set (label is wrong key, title is correct)", () => {
    const buf = makeMcpbBuffer({
      ...VALID_MANIFEST,
      user_config: {
        api_key: {
          type: "string",
          title: "API Key",
          label: "wrong key name",
        },
      },
    });
    expect(() => parseMcpb(buf)).toThrow();
  });

  it("accepts _meta with com.norvyn.adam namespace without errors (D-S03 passthrough)", () => {
    const buf = makeMcpbBuffer({
      ...VALID_MANIFEST,
      _meta: {
        "com.norvyn.adam": {
          some_internal_field: "value",
          nested: { deep: true },
        },
      },
    });
    const result = parseMcpb(buf);
    expect(result.manifest._meta).toBeDefined();
    expect((result.manifest._meta as Record<string, unknown>)["com.norvyn.adam"]).toBeDefined();
  });

  it("extracts files preserving directory structure", () => {
    const buf = makeMcpbBuffer(VALID_MANIFEST, {
      "dist/server/dev-entry.js": Buffer.from("console.log('hi')"),
      "dist/server/index.js": Buffer.from("module.exports = {}"),
    });
    const result = parseMcpb(buf);
    expect(result.files.has("dist/server/dev-entry.js")).toBe(true);
    expect(result.files.has("dist/server/index.js")).toBe(true);
  });

  it("rejects zip with path-traversal entry name (../../etc/passwd)", () => {
    const buf = makeMcpbBufferWithTraversalEntry(VALID_MANIFEST);
    expect(() => parseMcpb(buf)).toThrow(/ZIP_SLIP|path.traversal|traversal/i);
  });

  it("rejects manifest missing required field (no version)", () => {
    const { version: _v, ...noVersion } = VALID_MANIFEST;
    const buf = makeMcpbBuffer(noVersion);
    expect(() => parseMcpb(buf)).toThrow();
  });

  it("rejects manifest with server.type='binary' but no entry_point", () => {
    const buf = makeMcpbBuffer({
      ...VALID_MANIFEST,
      server: {
        type: "binary",
        mcp_config: { command: "mybinary" },
        // entry_point deliberately omitted
      },
    });
    expect(() => parseMcpb(buf)).toThrow(/entry_point/i);
  });

  it("parses the MiniMaxSearch manifest from disk without errors (Task 4 spec compliance)", () => {
    // Load the fixed manifest.json from disk and wrap it in an in-memory .mcpb buffer.
    // This verifies the manifest passes the mcpb-parser Zod schema after Task 4 fixes:
    //   - type: "python" (was "process")
    //   - user_config: object form with type: "string" + sensitive: true (was array with type: "secret")
    //   - title key (was label)
    //   - UV_CACHE_DIR / UV_TOOL_DIR / UV_PYTHON_INSTALL_DIR env vars added
    const manifestPath = path.join(__dirname, "../../../extensions/MiniMaxSearch/manifest.json");
    const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
    const buf = makeMcpbBuffer(manifestJson);
    const result = parseMcpb(buf);
    expect(result.manifest.name).toBe("minimax-search");
    expect(result.manifest.server.type).toBe("python");
    expect(result.manifest.user_config).toBeDefined();
    const apiKeyField = (result.manifest.user_config as Record<string, unknown>)["api_key"] as Record<string, unknown>;
    expect(apiKeyField["type"]).toBe("string");
    expect(apiKeyField["sensitive"]).toBe(true);
    expect(apiKeyField["title"]).toBeDefined();
    expect((apiKeyField as Record<string, unknown>)["label"]).toBeUndefined();
    expect(result.manifest.server.mcp_config.env?.["UV_CACHE_DIR"]).toBeDefined();
  });
});
