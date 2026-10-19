/**
 * Tests for src/store/config-doc/parser.ts
 *
 * These tests pin:
 * - byte-exact anchor extraction (length-prefixed, content-opaque)
 * - header parse (schemaVersion, inventories, manifests, ledger owners)
 * - fail-closed behavior (hash mismatch, length mismatch, missing close marker)
 * - assertDocPathInExportDir path validation (rejects traversal + out-of-dir)
 *
 * The fixture doc contains:
 * - a yaml header
 * - two anchor blocks (one whose content itself contains a ``` run and a fake
 *   `<!-- /adam:field -->` string, to prove length-prefixed extraction is
 *   content-opaque)
 * - one `${PLACEHOLDER}` token
 *
 * These tests MUST fail before Task 2-impl (parser not implemented yet).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseConfigDoc,
  assertDocPathInExportDir,
} from "../../store/config-doc/parser.js";

let exportDir: string;
let fixturePath: string;
let fixtureText: string;

const ANCHOR_R1_CONTENT =
  "You are 审慎者.\nA fake `<!-- /adam:field -->` and a code run:\n```js\nconst x = 1;\n```\nEnd.";
const ANCHOR_S1_PROMPT = "Write the morning brief.\nQuote: `<!-- /adam:field -->` still here.";

function sha256Hex(text: string): string {
  // Use the runtime crypto module — node:crypto available in vitest
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

beforeAll(() => {
  exportDir = mkdtempSync(join(tmpdir(), "adam-config-doc-test-"));
  process.env.ADAM_CONFIG_EXPORT_DIR = exportDir;

  const r1Bytes = byteLen(ANCHOR_R1_CONTENT);
  const r1Sha = sha256Hex(ANCHOR_R1_CONTENT);
  const s1Bytes = byteLen(ANCHOR_S1_PROMPT);
  const s1Sha = sha256Hex(ANCHOR_S1_PROMPT);

  fixtureText = [
    "```yaml",
    "schema_version: 72",
    "exported_at: 2026-06-07T12:00:00Z",
    "templates:",
    "  - id: tpl-morning",
    "    name: Morning",
    "roles:",
    "  - id: r1",
    "    name: 审慎者",
    "dependencies:",
    "  - pluginId: minimax-search@personal-os",
    "    source: personal-os",
    "    kind: plugin",
    "placeholders:",
    "  - name: MODEL_r1",
    "    kind: model",
    "    boundField: role.r1.model",
    "ledger_owners:",
    "  - podcast-show",
    "```",
    "",
    "## role r1",
    "",
    `<!-- adam:field id="role.r1.cagPrompt" bytes="${r1Bytes}" sha256="${r1Sha}" -->`,
    ANCHOR_R1_CONTENT,
    `<!-- /adam:field id="role.r1.cagPrompt" -->`,
    "",
    "## template tpl-morning",
    "",
    "name: Morning",
    "model: ${MODEL_r1}",
    "",
    "### step s1",
    "",
    "id: s1",
    `<!-- adam:field id="template.tpl-morning.step.s1.prompt" bytes="${s1Bytes}" sha256="${s1Sha}" -->`,
    ANCHOR_S1_PROMPT,
    `<!-- /adam:field id="template.tpl-morning.step.s1.prompt" -->`,
    "",
  ].join("\n");

  fixturePath = join(exportDir, "fixture.configdoc.yaml");
  writeFileSync(fixturePath, fixtureText, "utf8");
});

afterAll(() => {
  rmSync(exportDir, { recursive: true, force: true });
});

describe("parseConfigDoc — header", () => {
  it("parses schemaVersion, inventories, manifests, and ledger owners", () => {
    const doc = parseConfigDoc(fixtureText);
    expect(doc.header.schemaVersion).toBe(72);
    expect(doc.header.exportedAt).toBe("2026-06-07T12:00:00Z");
    expect(doc.header.templates).toEqual([{ id: "tpl-morning", name: "Morning" }]);
    expect(doc.header.roles).toEqual([{ id: "r1", name: "审慎者" }]);
    expect(doc.header.dependencies).toEqual([
      { pluginId: "minimax-search@personal-os", source: "personal-os", kind: "plugin" },
    ]);
    expect(doc.header.placeholders).toEqual([
      { name: "MODEL_r1", kind: "model", boundField: "role.r1.model" },
    ]);
    expect(doc.header.ledgerOwners).toEqual(["podcast-show"]);
  });

  it("exposes the inventory of anchor ids", () => {
    const doc = parseConfigDoc(fixtureText);
    expect(doc.anchorIds).toEqual(
      expect.arrayContaining([
        "role.r1.cagPrompt",
        "template.tpl-morning.step.s1.prompt",
      ]),
    );
  });
});

describe("parseConfigDoc — getAnchorBytes (byte-exact, content-opaque)", () => {
  it("returns bytes byte-identical to the fixture content for role.r1.cagPrompt", () => {
    const doc = parseConfigDoc(fixtureText);
    const got = doc.getAnchorBytes("role.r1.cagPrompt");
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got.equals(Buffer.from(ANCHOR_R1_CONTENT, "utf8"))).toBe(true);
  });

  it("returns bytes byte-identical to the fixture content for a step prompt", () => {
    const doc = parseConfigDoc(fixtureText);
    const got = doc.getAnchorBytes("template.tpl-morning.step.s1.prompt");
    expect(got.equals(Buffer.from(ANCHOR_S1_PROMPT, "utf8"))).toBe(true);
  });

  it("is content-opaque: content containing ``` and a fake close marker is extracted intact", () => {
    // The fixture's role.r1.cagPrompt content contains both ``` and `<!-- /adam:field -->`.
    // If the parser used string scanning (not length-prefixed extraction), it would
    // truncate at the fake close marker. Length-prefixed extraction ignores the content
    // and returns the exact bytes the open marker declared.
    const doc = parseConfigDoc(fixtureText);
    const got = doc.getAnchorBytes("role.r1.cagPrompt").toString("utf8");
    expect(got).toContain("```js");
    expect(got).toContain("const x = 1;");
    expect(got).toContain("`<!-- /adam:field -->`");
  });
});

describe("parseConfigDoc — fail-closed on integrity violations", () => {
  it("throws when the sha256 is tampered (does not match content)", () => {
    const badSha = "0".repeat(64);
    const text = fixtureText.replace(/sha256="[0-9a-f]{64}"/, `sha256="${badSha}"`);
    expect(() => parseConfigDoc(text)).toThrow(/sha256|hash/i);
  });

  it("throws when the bytes length is wrong", () => {
    const text = fixtureText.replace(/bytes="(\d+)"/, (_match, n: string) => {
      const wrong = String(Number(n) + 10);
      return `bytes="${wrong}"`;
    });
    expect(() => parseConfigDoc(text)).toThrow(/bytes|length/i);
  });

  it("throws when the close marker is missing", () => {
    // Replace the close marker with a non-matching sentinel. The fake close marker
    // inside the anchor's content (`<!-- /adam:field -->` without an id) is NOT
    // a valid close marker per the parser's grammar (which requires id="<scope>"),
    // so removing only the genuine close marker is sufficient.
    const text = fixtureText.replace(
      /<!-- \/adam:field id="role\.r1\.cagPrompt" -->/,
      "<!-- REMOVED_CLOSE_MARKER -->",
    );
    expect(() => parseConfigDoc(text)).toThrow(/close marker|marker|anchor/i);
  });

  it("throws when an unknown anchor id is requested", () => {
    const doc = parseConfigDoc(fixtureText);
    expect(() => doc.getAnchorBytes("role.r1.nonexistent")).toThrow(/anchor|not found/i);
  });
});

describe("assertDocPathInExportDir — path validation", () => {
  it("rejects a `..` traversal path", () => {
    // Create a real file in the parent dir of `exportDir`. realpathSync on the
    // traversal target resolves to that parent-dir file (which exists), so the
    // prefix check must reject it as outside the export dir.
    const parentDir = join(exportDir, "..");
    const parentFile = join(parentDir, "evil-sibling.configdoc.yaml");
    writeFileSync(parentFile, "x", "utf8");
    try {
      const traversalPath = join(exportDir, "..", "evil-sibling.configdoc.yaml");
      expect(() => assertDocPathInExportDir(traversalPath)).toThrow(
        /export dir|outside|traversal|escape/i,
      );
    } finally {
      try { unlinkSync(parentFile); } catch { /* best effort */ }
    }
  });

  it("rejects a path that is outside the export dir (e.g. /etc/passwd)", () => {
    // /etc/passwd exists on darwin, so realpathSync succeeds and the prefix
    // check must reject it.
    expect(() => assertDocPathInExportDir("/etc/passwd")).toThrow(
      /export dir|outside|traversal|escape/i,
    );
  });

  it("accepts an in-dir path", () => {
    const inDir = join(exportDir, "good.configdoc.yaml");
    writeFileSync(inDir, "x", "utf8");
    expect(() => assertDocPathInExportDir(inDir)).not.toThrow();
  });
});
