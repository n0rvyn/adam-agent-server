import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// Mock ADAM_TEST_DIR so writeEnvMirror writes to a temp directory
let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "adam-env-mirror-test-"));
  process.env.ADAM_TEST_DIR = testDir;
});

afterEach(() => {
  delete process.env.ADAM_TEST_DIR;
  rmSync(testDir, { recursive: true, force: true });
});

// Lazy import after env is set
async function getWriteEnvMirror() {
  const mod = await import("../../store/extensions.js");
  return mod.writeEnvMirror;
}

const MANIFEST_WITH_SENSITIVE = {
  manifest_version: "0.3" as const,
  name: "test-ext",
  version: "1.0.0",
  description: "Test",
  author: { name: "Test" },
  server: { type: "node" as const, mcp_config: { command: "node" } },
  user_config: {
    api_key: {
      type: "string" as const,
      title: "API Key",
      sensitive: true,
      default: "default-key",
    },
    non_sensitive: {
      type: "string" as const,
      title: "Non Sensitive",
      sensitive: false,
    },
    numeric: {
      type: "number" as const,
      title: "Count",
      sensitive: false,
    },
  },
};

const MANIFEST_NO_SENSITIVE = {
  ...MANIFEST_WITH_SENSITIVE,
  user_config: {
    public_field: {
      type: "string" as const,
      title: "Public",
      sensitive: false,
    },
  },
};

describe("writeEnvMirror", () => {
  it("writes one line per sensitive user_config field", async () => {
    const writeEnvMirror = await getWriteEnvMirror();
    // Create ext dir
    const extDir = join(testDir, "extensions", "test-ext");
    await import("node:fs").then((fs) => fs.mkdirSync(extDir, { recursive: true }));

    await writeEnvMirror({
      name: "test-ext",
      defaultConfigJson: null,
      manifest: MANIFEST_WITH_SENSITIVE,
    });

    const envPath = join(extDir, ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("API_KEY=default-key");
    // non_sensitive should NOT appear
    expect(content).not.toContain("NON_SENSITIVE");
    expect(content).not.toContain("NUMERIC");
  });

  it("skips non-sensitive fields", async () => {
    const writeEnvMirror = await getWriteEnvMirror();
    const extDir = join(testDir, "extensions", "test-ext");
    await import("node:fs").then((fs) => fs.mkdirSync(extDir, { recursive: true }));

    await writeEnvMirror({
      name: "test-ext",
      defaultConfigJson: null,
      manifest: MANIFEST_NO_SENSITIVE,
    });

    const envPath = join(extDir, ".env");
    // File may or may not exist; if it does, it must be empty or have no sensitive keys
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      expect(content.trim()).toBe("");
    }
  });

  it("uses defaultConfigJson value over manifest default", async () => {
    const writeEnvMirror = await getWriteEnvMirror();
    const extDir = join(testDir, "extensions", "test-ext");
    await import("node:fs").then((fs) => fs.mkdirSync(extDir, { recursive: true }));

    await writeEnvMirror({
      name: "test-ext",
      defaultConfigJson: JSON.stringify({ api_key: "overridden-key" }),
      manifest: MANIFEST_WITH_SENSITIVE,
    });

    const envPath = join(extDir, ".env");
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("API_KEY=overridden-key");
    expect(content).not.toContain("default-key");
  });

  it("sets file mode to 0600", async () => {
    const writeEnvMirror = await getWriteEnvMirror();
    const extDir = join(testDir, "extensions", "test-ext");
    await import("node:fs").then((fs) => fs.mkdirSync(extDir, { recursive: true }));

    await writeEnvMirror({
      name: "test-ext",
      defaultConfigJson: null,
      manifest: MANIFEST_WITH_SENSITIVE,
    });

    const envPath = join(extDir, ".env");
    if (existsSync(envPath)) {
      const stat = statSync(envPath);
      // mode & 0o777 gives permission bits; 0600 = owner read+write only
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("fails silently (log only) if disk write fails", async () => {
    const writeEnvMirror = await getWriteEnvMirror();
    // Don't create the ext dir — write will fail
    // Should not throw
    await expect(
      writeEnvMirror({
        name: "nonexistent-ext",
        defaultConfigJson: null,
        manifest: MANIFEST_WITH_SENSITIVE,
      }),
    ).resolves.toBeUndefined();
  });
});
