/**
 * Tests for the `read_config_doc` tool in adam-tools.
 *
 * These tests pin:
 * - handler returns schemaVersion + inventories + dependency manifest +
 *   placeholder manifest + ledger owners from the doc header
 * - the returned payload contains NONE of the verbatim anchor content
 *   (read is structure-only — bytes are pulled via `*Ref` params on
 *   create_role/create_template, not exposed here)
 * - out-of-export-dir path is rejected via `assertDocPathInExportDir`
 *
 * These tests MUST fail before Task 6-impl (tool not registered yet).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole } from "../../store/roles.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { renderConfigDoc } from "../../store/config-doc/renderer.js";
import { parsePortableConfig } from "../../store/config-doc/parser.js";
import type { Role, TaskTemplate, TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Hoisted SDK mocks so `tool()` registrations land in our capture object.
const { mockCreateSdkMcpServer, mockTool } = vi.hoisted(() => ({
  mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
  mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

afterAll(() => cleanup());

let exportDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSdkMcpServer.mockClear();
  mockTool.mockClear();
  clearTestDb();
  // Fresh export dir per test
  exportDir = mkdtempSync(join(tmpdir(), "adam-read-config-doc-test-"));
  process.env.ADAM_CONFIG_EXPORT_DIR = exportDir;
});

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Build a fixture config-doc with:
 *  - a yaml header (schemaVersion, exportedAt, inventories, dependency
 *    manifest, placeholder manifest, ledger owners)
 *  - two anchor blocks: one whose content contains ``` and a fake
 *    `<!-- /adam:field -->` string to prove the read tool does NOT leak
 *    anchor content into its payload
 */
function buildFixtureDoc(opts: {
  schemaVersion?: number;
  templates?: Array<{ id: string; name: string }>;
  roles?: Array<{ id: string; name: string }>;
  dependencies?: Array<{ pluginId: string; source: string; kind: "plugin" | "skill" | "mcpServer" }>;
  placeholders?: Array<{ name: string; kind: "channel" | "model" | "path" | "secret" | "env"; boundField: string }>;
  ledgerOwners?: string[];
  anchorContents?: Array<{ id: string; content: string }>;
}): { text: string; path: string; allAnchorContent: string } {
  const schemaVersion = opts.schemaVersion ?? 72;
  const exportedAt = "2026-06-07T12:00:00Z";
  const templates = opts.templates ?? [{ id: "tpl-x", name: "X" }];
  const roles = opts.roles ?? [{ id: "r1", name: "审慎者" }];
  const dependencies = opts.dependencies ?? [];
  const placeholders = opts.placeholders ?? [];
  const ledgerOwners = opts.ledgerOwners ?? [];
  const anchorContents = opts.anchorContents ?? [
    {
      id: "role.r1.cagPrompt",
      // Content with a fake close marker and code fence — must NOT leak.
      content: "You are 审慎者.\nFake close: `<!-- /adam:field -->`\n```js\nconst x = 1;\n```\nEnd.",
    },
  ];

  const headerLines: string[] = ["```yaml", `schema_version: ${schemaVersion}`, `exported_at: ${exportedAt}`];
  if (templates.length > 0) {
    headerLines.push("templates:");
    for (const t of templates) headerLines.push(`  - id: ${t.id}`, `    name: ${t.name}`);
  }
  if (roles.length > 0) {
    headerLines.push("roles:");
    for (const r of roles) headerLines.push(`  - id: ${r.id}`, `    name: ${r.name}`);
  }
  if (dependencies.length > 0) {
    headerLines.push("dependencies:");
    for (const d of dependencies) headerLines.push(`  - pluginId: ${d.pluginId}`, `    source: ${d.source}`, `    kind: ${d.kind}`);
  }
  if (placeholders.length > 0) {
    headerLines.push("placeholders:");
    for (const p of placeholders) headerLines.push(`  - name: ${p.name}`, `    kind: ${p.kind}`, `    boundField: ${p.boundField}`);
  }
  if (ledgerOwners.length > 0) {
    headerLines.push("ledger_owners:");
    for (const o of ledgerOwners) headerLines.push(`  - ${o}`);
  }
  headerLines.push("```", "");

  const bodyLines: string[] = [];
  for (const t of templates) {
    bodyLines.push(`## template ${t.id}`, "");
  }
  for (const a of anchorContents) {
    const bytes = byteLen(a.content);
    const sha = sha256Hex(a.content);
    bodyLines.push(
      `<!-- adam:field id="${a.id}" bytes="${bytes}" sha256="${sha}" -->`,
      a.content,
      `<!-- /adam:field id="${a.id}" -->`,
      "",
    );
  }

  const text = headerLines.concat(bodyLines).join("\n");
  const path = join(exportDir, "fixture.configdoc.yaml");
  writeFileSync(path, text, "utf8");
  return { text, path, allAnchorContent: anchorContents.map((a) => a.content).join("\n") };
}

async function callReadConfigDoc(args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> {
  const { createAdamTools } = await import("../../manager/adam-tools.js");
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0];
  const tools = (config as { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }).tools;
  const tool = tools.find((t) => t.name === "read_config_doc");
  expect(tool).toBeDefined();
  return tool!.handler(args) as Promise<{ content: Array<{ text: string }> }>;
}

describe("read_config_doc — header summary", () => {
  it("returns schemaVersion + inventories + dependency/placeholder/ledger owners", async () => {
    const { path } = buildFixtureDoc({
      templates: [{ id: "tpl-morning", name: "Morning" }],
      roles: [{ id: "r1", name: "审慎者" }],
      dependencies: [
        { pluginId: "minimax-search@personal-os", source: "personal-os", kind: "plugin" },
      ],
      placeholders: [
        { name: "MODEL_r1", kind: "model", boundField: "role.r1.model" },
      ],
      ledgerOwners: ["podcast-show"],
    });

    const result = await callReadConfigDoc({ docPath: path });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.schemaVersion).toBe(72);
    expect(payload.exportedAt).toBe("2026-06-07T12:00:00Z");
    expect(payload.templates).toEqual([{ id: "tpl-morning", name: "Morning" }]);
    expect(payload.roles).toEqual([{ id: "r1", name: "审慎者" }]);
    expect(payload.dependencies).toEqual([
      { pluginId: "minimax-search@personal-os", source: "personal-os", kind: "plugin" },
    ]);
    expect(payload.placeholders).toEqual([
      { name: "MODEL_r1", kind: "model", boundField: "role.r1.model" },
    ]);
    expect(payload.ledgerOwners).toEqual(["podcast-show"]);
  });

  it("returns anchor inventory (ids only) but no anchor content", async () => {
    const { path, allAnchorContent } = buildFixtureDoc({
      anchorContents: [
        { id: "role.r1.cagPrompt", content: "A very distinctive VERBATIM_CAG_SENTINEL_STRING_xyz_42\nAnd a code block:\n```\nsecret = true\n```\nEnd." },
        { id: "template.tpl-x.step.s1.prompt", content: "Step prompt VERBATIM_STEP_SENTINEL_qwerty_99 with `<!-- /adam:field -->`." },
      ],
    });

    const result = await callReadConfigDoc({ docPath: path });
    const payload = JSON.parse(result.content[0].text);

    // The anchor id inventory is allowed (structure), but the content is NOT.
    expect(Array.isArray(payload.anchorIds)).toBe(true);
    expect(payload.anchorIds).toEqual(
      expect.arrayContaining(["role.r1.cagPrompt", "template.tpl-x.step.s1.prompt"]),
    );
    // No verbatim content leaks.
    const textBlob = JSON.stringify(payload);
    expect(textBlob).not.toContain("VERBATIM_CAG_SENTINEL_STRING_xyz_42");
    expect(textBlob).not.toContain("VERBATIM_STEP_SENTINEL_qwerty_99");
    expect(textBlob).not.toContain("secret = true");
    expect(textBlob).not.toContain("`<!-- /adam:field -->`");
    // Sanity: ensure we aren't accidentally checking the fixture's own content.
    expect(allAnchorContent).toContain("VERBATIM_CAG_SENTINEL_STRING_xyz_42");
  });
});

describe("read_config_doc — path validation", () => {
  it("rejects a path outside the export dir", async () => {
    // /etc/hosts exists on darwin; realpathSync will resolve to a real
    // file outside the export dir. The handler must reject.
    const result = await callReadConfigDoc({ docPath: "/etc/hosts" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.error).toMatch(/export dir|outside|traversal|escape/i);
  });

  it("rejects a `..` traversal path that lands outside the export dir", async () => {
    const sibling = join(exportDir, "..", "evil-sibling.configdoc.yaml");
    writeFileSync(sibling, "x", "utf8");
    try {
      const result = await callReadConfigDoc({ docPath: sibling });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toBeDefined();
      expect(payload.error).toMatch(/export dir|outside|traversal|escape/i);
    } finally {
      try { rmSync(sibling, { force: true }); } catch { /* best effort */ }
    }
  });

  it("rejects a non-existent in-dir path (cannot read)", async () => {
    const ghost = join(exportDir, "does-not-exist.configdoc.yaml");
    const result = await callReadConfigDoc({ docPath: ghost });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Structured config return (Phase 2 Task 5-tests)
// ---------------------------------------------------------------------------

function makeStructuredRole(): Role {
  return {
    id: "role-r1",
    name: "审慎者",
    cagPrompt: "CAG prompt with `<!-- /adam:field -->` and a code block:\n```\nsecret = true\n```",
    learnedRules: { stylePreferences: ["代码质量优先"], avoidedActions: ["skip tests"], pinnedParameters: [] },
    memoryStreamId: "mem-r1",
    status: "active",
    preferences: { maxTurns: 30 },
    createdAt: 1700000000000,
    skills: ["getnote"],
    effortTier: "high",
  };
}

function makeStructuredTemplate(): TaskTemplate {
  const step: TaskStep = {
    id: "s-1",
    prompt: "do thing with sk-cp-LEAK somewhere in the prompt as a planted literal",
    roleId: "role-r1",
    dependsOn: ["s-0"],
    outputAs: "out-1",
  };
  const s0: TaskStep = { id: "s-0", prompt: "setup", roleId: "role-r1" };
  return {
    id: "tpl-x",
    name: "TestPipeline",
    trigger: { type: "manual" },
    steps: [s0, step],
    enabled: true,
    createdAt: 1700000000000,
  };
}

describe("read_config_doc — structured config (config: PortableConfig)", () => {
  it("returns config.templates[0].sourceId and config.roles[0].sourceId", async () => {
    const role = makeStructuredRole();
    const tpl = makeStructuredTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const docPath = join(exportDir, "structured.configdoc.yaml");
    writeFileSync(docPath, docText, "utf8");

    const result = await callReadConfigDoc({ docPath });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.config).toBeDefined();
    expect(Array.isArray(payload.config.templates)).toBe(true);
    expect(Array.isArray(payload.config.roles)).toBe(true);
    expect(payload.config.templates[0].sourceId).toBe(tpl.id);
    expect(payload.config.roles[0].sourceId).toBe(role.id);
  });

  it("config.roles[0].cagPrompt is {__anchor} and a known cagPrompt substring is ABSENT from the serialized result", async () => {
    const role = makeStructuredRole();
    const tpl = makeStructuredTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const docPath = join(exportDir, "no-anchor-leak.configdoc.yaml");
    writeFileSync(docPath, docText, "utf8");

    const result = await callReadConfigDoc({ docPath });
    const payload = JSON.parse(result.content[0].text);

    // cagPrompt is a {__anchor} ref, not a verbatim string
    expect(payload.config.roles[0].cagPrompt).toEqual({
      __anchor: `role.${role.id}.cagPrompt`,
    });

    // A distinctive substring of the verbatim cagPrompt must NOT leak through
    // the serialized result
    const textBlob = JSON.stringify(payload);
    expect(textBlob).not.toContain("CAG prompt with `<!-- /adam:field -->`");
    expect(textBlob).not.toContain("secret = true");
  });

  it("env fields are ${...} strings and a planted secret literal is absent", async () => {
    // Add envVars so a ${TOKEN} gets emitted
    const role: Role = {
      ...makeStructuredRole(),
      envVars: { MY_API_KEY: "sk-cp-LEAK" },
    };
    const tpl = makeStructuredTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const docPath = join(exportDir, "env-token.configdoc.yaml");
    writeFileSync(docPath, docText, "utf8");

    const result = await callReadConfigDoc({ docPath });
    const payload = JSON.parse(result.content[0].text);

    // envVars.MY_API_KEY is a ${TOKEN} string
    expect(payload.config.roles[0].envVars.MY_API_KEY).toMatch(/^\$\{[^}]+\}$/);

    // Planted secret literal is absent from the serialized result
    const textBlob = JSON.stringify(payload);
    expect(textBlob).not.toContain("sk-cp-LEAK");
  });

  it("returns the same config that parsePortableConfig returns on the same text", async () => {
    const role = makeStructuredRole();
    const tpl = makeStructuredTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const docText = renderConfigDoc([tpl.id]);
    const docPath = join(exportDir, "consistency.configdoc.yaml");
    writeFileSync(docPath, docText, "utf8");

    const result = await callReadConfigDoc({ docPath });
    const payload = JSON.parse(result.content[0].text);
    const directParsed = parsePortableConfig(docText);

    expect(payload.config).toEqual(directParsed);
  });
});
