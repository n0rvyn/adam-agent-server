/**
 * Tests for anchor-ref params on `create_role` / `create_template`.
 *
 * These tests pin:
 *  - `create_role({ name, cagPromptRef: { docPath, anchorId } })` → stored
 *    `cagPrompt` is byte-identical to the anchor's bytes
 *  - `create_template` step `promptRef` → stored step prompt byte-identical
 *  - `create_template` step `personaSpeakAsRef` → stored persona.speakAs byte-identical
 *  - `create_template` step `customAssertionRefs[i]` → stored customAssertions[i] byte-identical
 *  - Calls WITHOUT anchor refs (backward compat) behave exactly as before
 *  - Out-of-export-dir docPath is rejected
 *
 * These tests MUST fail before Task 7-impl (params do not exist yet).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole as createRoleFn } from "../../store/roles.js";

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
let fixturePath: string;

// Anchor contents — backticks and a fake close marker in the CAG prompt
// prove the parser's length-prefixed extraction is content-opaque.
const CAG_PROMPT_CONTENT =
  "You are 审慎者.\nA fake `<!-- /adam:field -->` and a code run:\n```js\nconst x = 1;\n```\nEnd.";
const STEP_PROMPT_CONTENT =
  "Write the morning brief. Quote: `<!-- /adam:field -->` still here.";
const PERSONA_SPEAK_AS_CONTENT = "Speak as 钱钟书 (a Chinese essayist).";
const CUSTOM_ASSERTION_0_CONTENT = "Contains a `<!-- /adam:field -->` string verbatim.";
const CUSTOM_ASSERTION_1_CONTENT = "Mentions the keyword 实盘.";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function emitAnchor(id: string, content: string): string[] {
  return [
    `<!-- adam:field id="${id}" bytes="${byteLen(content)}" sha256="${sha256Hex(content)}" -->`,
    content,
    `<!-- /adam:field id="${id}" -->`,
    "",
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateSdkMcpServer.mockClear();
  mockTool.mockClear();
  clearTestDb();
  // Fresh export dir per test
  exportDir = mkdtempSync(join(tmpdir(), "adam-anchor-ref-test-"));
  process.env.ADAM_CONFIG_EXPORT_DIR = exportDir;

  // Build a fixture doc with anchors for a role's cagPrompt and a template
  // step's prompt, persona.speakAs, and two customAssertions.
  const headerLines: string[] = [
    "```yaml",
    "schema_version: 72",
    "exported_at: 2026-06-07T12:00:00Z",
    "templates:",
    "  - id: tpl-morning",
    "    name: Morning",
    "roles:",
    "  - id: r-x",
    "    name: TestRole",
    "```",
    "",
  ];
  const bodyLines: string[] = [];
  for (const [id, content] of [
    ["role.r-x.cagPrompt", CAG_PROMPT_CONTENT],
    ["template.tpl-morning.step.s1.prompt", STEP_PROMPT_CONTENT],
    ["template.tpl-morning.step.s1.persona.speakAs", PERSONA_SPEAK_AS_CONTENT],
    ["template.tpl-morning.step.s1.outputContract.customAssertions[0]", CUSTOM_ASSERTION_0_CONTENT],
    ["template.tpl-morning.step.s1.outputContract.customAssertions[1]", CUSTOM_ASSERTION_1_CONTENT],
  ] as Array<[string, string]>) {
    bodyLines.push(...emitAnchor(id, content));
  }
  const text = headerLines.concat(bodyLines).join("\n");
  fixturePath = join(exportDir, "fixture.configdoc.yaml");
  writeFileSync(fixturePath, text, "utf8");

  // Seed a real role so templates with `roleId: "r-x"` can validate.
  // The fixtures above use r-x as the closure role id.
  createRoleFn({
    id: "r-x",
    name: "TestRole-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    cagPrompt: "seeded test role",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-r-x",
    status: "active",
    preferences: {},
    createdAt: Date.now(),
  });
});

afterAll(() => {
  try { rmSync(exportDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> {
  const { createAdamTools } = await import("../../manager/adam-tools.js");
  createAdamTools();
  const config = mockCreateSdkMcpServer.mock.calls[0][0];
  const tools = (config as { tools: Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }> }).tools;
  const tool = tools.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.handler(args) as Promise<{ content: Array<{ text: string }> }>;
}

async function callCreateRole(args: Record<string, unknown>) {
  return callTool("create_role", args);
}

async function callCreateTemplate(args: Record<string, unknown>) {
  return callTool("create_template", args);
}

describe("create_role — cagPromptRef anchor byte-fidelity", () => {
  it("stores cagPrompt byte-identical to the anchor content", async () => {
    const result = await callCreateRole({
      name: "anchor-ref-role",
      cagPromptRef: { docPath: fixturePath, anchorId: "role.r-x.cagPrompt" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.roleId).toBeDefined();

    const { getRoleByName } = await import("../../store/roles.js");
    const role = getRoleByName("anchor-ref-role");
    expect(role).toBeDefined();
    expect(Buffer.from(role!.cagPrompt, "utf8").equals(Buffer.from(CAG_PROMPT_CONTENT, "utf8"))).toBe(true);
  });

  it("rejects both inline cagPrompt and cagPromptRef as ambiguous", async () => {
    const result = await callCreateRole({
      name: "ambiguous-role",
      cagPrompt: "inline prompt",
      cagPromptRef: { docPath: fixturePath, anchorId: "role.r-x.cagPrompt" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.error).toMatch(/ambiguous|both/i);
  });

  it("rejects a docPath that is outside the export dir", async () => {
    const result = await callCreateRole({
      name: "bad-path-role",
      cagPromptRef: { docPath: "/etc/hosts", anchorId: "role.r-x.cagPrompt" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.error).toMatch(/export dir|outside|traversal|escape/i);
  });

  it("rejects a missing anchor id", async () => {
    const result = await callCreateRole({
      name: "missing-anchor-role",
      cagPromptRef: { docPath: fixturePath, anchorId: "role.r-x.nonexistent" },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
  });
});

describe("create_role — backward compat (no anchor ref)", () => {
  it("plain create_role({ name, cagPrompt }) still works identically", async () => {
    const plainCagPrompt = "Plain CAG prompt — no anchor.";
    const result = await callCreateRole({
      name: "plain-role",
      cagPrompt: plainCagPrompt,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.roleId).toBeDefined();
    expect(payload.error).toBeUndefined();

    const { getRoleByName } = await import("../../store/roles.js");
    const role = getRoleByName("plain-role");
    expect(role).toBeDefined();
    expect(role!.cagPrompt).toBe(plainCagPrompt);
  });
});

describe("create_template — step anchor-refs (prompt / persona.speakAs / customAssertions)", () => {
  it("stores step prompt byte-identical via promptRef", async () => {
    const result = await callCreateTemplate({
      name: "anchor-ref-tpl",
      steps: [
        {
          id: "s1",
          roleId: "r-x",
          promptRef: { docPath: fixturePath, anchorId: "template.tpl-morning.step.s1.prompt" },
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.templateId).toBeDefined();
    expect(payload.error).toBeUndefined();

    const { getTaskTemplate } = await import("../../store/task-templates.js");
    const tpl = getTaskTemplate(payload.templateId);
    expect(tpl).toBeDefined();
    const step = tpl!.steps.find((s: { id: string }) => s.id === "s1");
    expect(step).toBeDefined();
    expect(Buffer.from(step!.prompt, "utf8").equals(Buffer.from(STEP_PROMPT_CONTENT, "utf8"))).toBe(true);
  });

  it("stores step persona.speakAs byte-identical via personaSpeakAsRef", async () => {
    const result = await callCreateTemplate({
      name: "anchor-ref-persona-tpl",
      steps: [
        {
          id: "s1",
          roleId: "r-x",
          prompt: "inline prompt",
          persona: {
            speakAsRef: { docPath: fixturePath, anchorId: "template.tpl-morning.step.s1.persona.speakAs" },
          },
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeUndefined();

    const { getTaskTemplate } = await import("../../store/task-templates.js");
    const tpl = getTaskTemplate(payload.templateId);
    const step = tpl!.steps.find((s: { id: string }) => s.id === "s1");
    expect(Buffer.from(step!.persona!.speakAs, "utf8").equals(Buffer.from(PERSONA_SPEAK_AS_CONTENT, "utf8"))).toBe(true);
  });

  it("stores step customAssertions byte-identical via customAssertionRefs[]", async () => {
    const result = await callCreateTemplate({
      name: "anchor-ref-assertions-tpl",
      steps: [
        {
          id: "s1",
          roleId: "r-x",
          prompt: "inline prompt",
          outputContract: {
            customAssertionRefs: [
              { docPath: fixturePath, anchorId: "template.tpl-morning.step.s1.outputContract.customAssertions[0]" },
              { docPath: fixturePath, anchorId: "template.tpl-morning.step.s1.outputContract.customAssertions[1]" },
            ],
          },
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeUndefined();

    const { getTaskTemplate } = await import("../../store/task-templates.js");
    const tpl = getTaskTemplate(payload.templateId);
    const step = tpl!.steps.find((s: { id: string }) => s.id === "s1");
    const assertions = step!.outputContract!.customAssertions!;
    expect(assertions).toHaveLength(2);
    expect(Buffer.from(assertions[0], "utf8").equals(Buffer.from(CUSTOM_ASSERTION_0_CONTENT, "utf8"))).toBe(true);
    expect(Buffer.from(assertions[1], "utf8").equals(Buffer.from(CUSTOM_ASSERTION_1_CONTENT, "utf8"))).toBe(true);
  });

  it("rejects a docPath that is outside the export dir on step promptRef", async () => {
    const result = await callCreateTemplate({
      name: "bad-path-tpl",
      steps: [
        {
          id: "s1",
          roleId: "r-x",
          promptRef: { docPath: "/etc/hosts", anchorId: "template.tpl-morning.step.s1.prompt" },
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.error).toMatch(/export dir|outside|traversal|escape/i);
  });
});

describe("create_template — backward compat (no anchor ref)", () => {
  it("plain create_template({ name, steps: [{id, roleId, prompt}] }) still works identically", async () => {
    const plainPrompt = "Plain step prompt — no anchor.";
    const result = await callCreateTemplate({
      name: "plain-tpl",
      steps: [{ id: "s1", roleId: "r-x", prompt: plainPrompt }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeUndefined();
    expect(payload.templateId).toBeDefined();

    const { getTaskTemplate } = await import("../../store/task-templates.js");
    const tpl = getTaskTemplate(payload.templateId);
    const step = tpl!.steps.find((s: { id: string }) => s.id === "s1");
    expect(step!.prompt).toBe(plainPrompt);
  });
});
