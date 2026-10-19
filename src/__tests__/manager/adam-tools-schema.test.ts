import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Hoisted mocks for the SDK — return config so we can inspect tools[]
const { mockCreateSdkMcpServer, mockTool, mockWarn } = vi.hoisted(() => {
  const mockWarn = vi.fn();
  return {
    mockCreateSdkMcpServer: vi.fn().mockImplementation((config: unknown) => config),
    mockTool: vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema: schema,
      handler,
    })),
    mockWarn,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
  setLogLevel: vi.fn(),
}));

// Mock store/db so factories don't touch the production DB.
vi.mock("../../store/db.js", async () => {
  const { setupTestDb, getTestDb } = await import("../helpers/test-db.js");
  setupTestDb();
  return { getDb: () => getTestDb(), closeDb: () => {} };
});
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock("../../config/runtime.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({
    defaults: { maxConcurrent: 5, maxTurns: 50 },
    execution: { maxConcurrent: 5, pollIntervalMs: 30000 },
    watchdog: { enabled: false },
    chat: { sessionTimeoutMinutes: 60, maxSessionTurns: 200 },
  }),
  updateMutableConfig: vi.fn(),
}));
vi.mock("../../agent/memory-service.js", () => ({ queryMemory: vi.fn().mockResolvedValue([]) }));
vi.mock("../../lib/embedding.js", () => ({ generateEmbedding: vi.fn().mockResolvedValue(new Float32Array(768)) }));
vi.mock("../../strategy/engine.js", () => ({ StrategyEngine: vi.fn() }));
vi.mock("../../strategy/generator.js", () => ({ StrategyGenerator: vi.fn() }));
vi.mock("../../sandbox/provider.js", () => ({
  getSandboxProvider: () => ({ platform: "sandbox-exec", isAvailable: async () => true }),
  isSandboxAvailable: vi.fn().mockResolvedValue(true),
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { createExecutionTools, EXECUTION_TOOLS_MCP_NAME } = await import("../../manager/execution-tools.js");
const { createSharedMemoryTools } = await import("../../manager/shared-tools.js");

// Fields that legitimately keep bare z.string() despite an ID/Path/Url suffix.
// Each entry must justify itself in a comment.
const ALLOWLIST = new Set<string>([
  // chatId is platform-specific (WeChat wxid_..., Telegram 12345, Slack U07ABCDEF) — no single regex.
  "chatId",
  // operationId maps to task_plans.id (UUID), but the field name doesn't end in Id so the schema
  // uses plain z.string() — the operationId UUID format is validated at the handler level.
  "operationId",
  // roleId is a UUID but validated at the handler level (admitTask checks role existence).
  // Many tools accept roleId as a lookup key; the handler enforces validity.
  "roleId",
  // presetId is a free-form preset reference (slug or UUID — no single regex); carried as a
  // portable inline field by config-doc import (create_role/create_template), validated at the
  // handler / preset registry. Same rationale as roleId.
  "presetId",
]);

interface FieldIssue {
  tool: string;
  field: string;
  problem: "bare-string-on-id-suffix" | "missing-description";
}

/**
 * Read the description from a schema, looking through ZodOptional/ZodDefault/ZodNullable wrappers.
 * In zod 4, `.describe()` placement matters: `.describe().optional()` puts it on inner;
 * `.optional().describe()` puts it on outer. We accept either.
 */
function readDescription(schema: any): string {
  return (
    schema?.description ??
    schema?._def?.description ??
    schema?._def?.innerType?.description ??
    schema?._def?.innerType?._def?.description ??
    ""
  );
}

function unwrap(schema: any): any {
  // Walk past ZodOptional / ZodDefault / ZodNullable to reach the typed core.
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodNullable) {
    s = s._def.innerType;
  }
  return s;
}

function hasFormatCheck(stringSchema: any): boolean {
  const checks = stringSchema?._def?.checks ?? [];
  // zod 4 check constructor names (REPL-verified):
  //   regex → $ZodCheckRegex; refine → ZodCustom; uuid → ZodUUID; url → ZodURL; email → ZodEmail
  //   min/max → $ZodCheckMinLength/MaxLength (NOT counted as format)
  const FORMAT_PATTERNS = ["Regex", "Custom", "UUID", "URL", "Email"];
  return checks.some((c: any) => {
    const ctorName = c?.constructor?.name ?? "";
    return FORMAT_PATTERNS.some((p) => ctorName.includes(p));
  });
}

function walkSchema(toolName: string, fieldName: string, rawSchema: any, issues: FieldIssue[]): void {
  // Description check: only on top-level fields (not nested ZodObject internals).
  // Skip ZodLiteral (union discriminators) — these are enum tags, descriptions are on the union field itself.
  const core = unwrap(rawSchema);
  const isLiteral = core instanceof z.ZodLiteral;
  if (!isLiteral) {
    const description = readDescription(rawSchema);
    if (!description.trim()) {
      issues.push({ tool: toolName, field: fieldName, problem: "missing-description" });
    }
  }

  // Bare z.string() on an *Id|*Path|*Url field — only checked at top level (not nested).
  if (core instanceof z.ZodString) {
    const isIdSuffix = /(Id|Path|Url)$/.test(fieldName);
    if (isIdSuffix && !hasFormatCheck(core) && !ALLOWLIST.has(fieldName)) {
      issues.push({ tool: toolName, field: fieldName, problem: "bare-string-on-id-suffix" });
    }
    return;
  }

  // For ZodObject — only check the top-level description (already done above).
  // Do NOT recurse into nested TaskRequirements / inner objects — those are shared schema
  // types that should be fixed at their definition site, not instrumented per-call-site.
  if (core instanceof z.ZodObject) {
    return;
  }

  // For ZodUnion — only check the top-level description (already done above).
  // Do NOT recurse into union options; inner literals are discriminated-union tags.
  if (core instanceof z.ZodUnion) {
    return;
  }

  // For ZodArray — skip (check is on the array field itself, not its element type).
  // ZodOptional was already unwrapped above.
  // Other types (ZodNumber, ZodBoolean, ZodLiteral, ZodEnum, ZodRecord) — description already checked above.
}

function gatherTools(label: string, source: any): Array<{ name: string; inputSchema: unknown; tool: string }> {
  // adam-tools: createSdkMcpServer config → { tools: [...] }
  if (source?.tools && Array.isArray(source.tools)) {
    return source.tools.map((t: any) => ({ name: t.name, inputSchema: t.inputSchema, tool: `${label}/${t.name}` }));
  }
  // execution-tools / shared-tools: returns array directly
  if (Array.isArray(source)) {
    return source.map((t: any) => ({ name: t.name, inputSchema: t.inputSchema, tool: `${label}/${t.name}` }));
  }
  throw new Error(`gatherTools: unknown source shape for ${label}`);
}

describe("Tool schema audit (S2-D/E guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no leaf z.string() for *Id|*Path|*Url fields, and every leaf has a description", () => {
    const issues: FieldIssue[] = [];

    // Adam tools (no args)
    const adam = createAdamTools();
    for (const t of gatherTools("adam-tools", adam)) {
      const schema = t.inputSchema as Record<string, unknown> | undefined;
      if (!schema) continue;
      for (const [fieldName, fieldSchema] of Object.entries(schema)) {
        walkSchema(t.tool, fieldName, fieldSchema, issues);
      }
    }

    // Execution tools (needs a roleId)
    const exec = createExecutionTools("role-test");
    for (const t of gatherTools(EXECUTION_TOOLS_MCP_NAME, exec)) {
      const schema = t.inputSchema as Record<string, unknown> | undefined;
      if (!schema) continue;
      for (const [fieldName, fieldSchema] of Object.entries(schema)) {
        walkSchema(t.tool, fieldName, fieldSchema, issues);
      }
    }

    // Shared memory tools — BOTH variants (scoped + unscoped)
    for (const variant of [createSharedMemoryTools("role-test"), createSharedMemoryTools()]) {
      for (const t of gatherTools(`shared-tools[${variant === undefined ? "?" : "v"}]`, variant)) {
        const schema = t.inputSchema as Record<string, unknown> | undefined;
        if (!schema) continue;
        for (const [fieldName, fieldSchema] of Object.entries(schema)) {
          walkSchema(t.tool, fieldName, fieldSchema, issues);
        }
      }
    }

    if (issues.length > 0) {
      const summary = issues.map((i) => `  - ${i.tool}.${i.field}: ${i.problem}`).join("\n");
      throw new Error(
        `Tool schema audit found ${issues.length} issue(s). Use schemas from src/lib/tool-schemas.ts and add .describe() to every field.\n${summary}`,
      );
    }
    expect(issues).toHaveLength(0);
  });

  // RED-TEAM: end-to-end via the real gather+walk path (proves the audit detects regressions).
  it("red-team end-to-end: a synthetic source with a bad field is caught", () => {
    const badSource = [
      {
        name: "fake_tool",
        inputSchema: {
          taskId: z.string().describe("Task ID"), // bare *Id without regex — should be flagged
          okField: z.string().describe("Free text"), // OK
          undescribed: z.string(), // missing description — should be flagged
        },
      },
    ];
    const issues: FieldIssue[] = [];
    for (const t of gatherTools("test-fake", badSource)) {
      const schema = t.inputSchema as Record<string, unknown> | undefined;
      if (!schema) continue;
      for (const [k, v] of Object.entries(schema)) {
        walkSchema(t.tool, k, v, issues);
      }
    }
    expect(issues.find((i) => i.field === "taskId" && i.problem === "bare-string-on-id-suffix")).toBeDefined();
    expect(issues.find((i) => i.field === "undescribed" && i.problem === "missing-description")).toBeDefined();
    expect(issues.find((i) => i.field === "okField")).toBeUndefined();
  });

  it("ALLOWLIST entry chatId is exempt from id-suffix check", () => {
    const issues: FieldIssue[] = [];
    walkSchema("test", "chatId", z.string().describe("chat id"), issues);
    expect(issues).toHaveLength(0);
  });

  // POSITIVE CONTROL: catches future regressions where hasFormatCheck stops recognizing
  // a check class (e.g., zod upgrades changes a constructor name and the audit silently
  // starts flagging valid refine-based schemas).
  it("positive control: schemas from tool-schemas.ts produce ZERO issues for *Id|*Path|*Url fields", async () => {
    const { roleIdSchema, taskIdSchema, templateIdSchema, pluginIdSchema, localFilePathSchema, eventDefIdSchema, channelIdSchema } =
      await import("../../lib/tool-schemas.js");
    const issues: FieldIssue[] = [];
    const sample = {
      name: "positive_control",
      inputSchema: {
        roleId: roleIdSchema,
        taskId: taskIdSchema,
        templateId: templateIdSchema,
        pluginId: pluginIdSchema,
        eventDefId: eventDefIdSchema,
        channelId: channelIdSchema,
        path: localFilePathSchema,
        mediaUrl: localFilePathSchema.optional().describe("Optional media path"),
      },
    };
    for (const t of gatherTools("positive", [sample])) {
      const schema = t.inputSchema as Record<string, unknown>;
      for (const [k, v] of Object.entries(schema)) {
        walkSchema(t.tool, k, v, issues);
      }
    }
    if (issues.length > 0) {
      const summary = issues.map((i) => `  - ${i.tool}.${i.field}: ${i.problem}`).join("\n");
      throw new Error(`Positive control failed — tool-schemas.ts schemas should pass:\n${summary}`);
    }
    expect(issues).toHaveLength(0);
  });

  it("readDescription handles both .describe().optional() and .optional().describe() orderings", () => {
    expect(readDescription(z.string().describe("a").optional())).toBe("a");
    expect(readDescription(z.string().optional().describe("b"))).toBe("b");
    expect(readDescription(z.string())).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Task 4-tests: deriveStepKind — canonical id mapping + fallback
// ---------------------------------------------------------------------------

describe("deriveStepKind — canonical step id → kind mapping", () => {
  it("maps canonical Chinese and English step ids to expected kinds (table-driven)", async () => {
    const { deriveStepKind } = await import("../../agent/derive-step-kind.js");

    const cases: [string, string][] = [
      ["采集", "collection"],
      ["写稿A", "drafting"],
      ["写稿B", "drafting"],
      ["写稿C", "drafting"],
      ["批判A", "criticism"],
      ["批判B", "criticism"],
      ["批判C", "criticism"],
      ["润色A", "polishing"],
      ["润色B", "polishing"],
      ["润色C", "polishing"],
      ["评分", "scoring"],
      ["定稿", "finalizing"],
      ["jay", "tts"],
      ["audio", "tts"],
      ["tts", "tts"],
      ["picasso", "image"],
      ["image", "image"],
    ];

    for (const [stepId, expectedKind] of cases) {
      expect(deriveStepKind(stepId), `stepId="${stepId}"`).toBe(expectedKind);
    }
  });

  it("returns step.id verbatim for unknown step ids (fallback)", async () => {
    const { deriveStepKind } = await import("../../agent/derive-step-kind.js");
    expect(deriveStepKind("myCustomStep")).toBe("myCustomStep");
  });

  it("emits a warn-log when falling back to id-as-kind", async () => {
    mockWarn.mockClear();
    const { deriveStepKind } = await import("../../agent/derive-step-kind.js");
    deriveStepKind("unknownId");
    expect(mockWarn).toHaveBeenCalledOnce();
    const callArg = mockWarn.mock.calls[0];
    // First arg is the bindings object, second is the message string
    expect(callArg[1]).toMatch(/no canonical mapping/i);
  });
});

describe("mapTemplateStepInput — kind auto-derivation", () => {
  it("auto-derives kind from step id when kind is not provided", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");

    const step = mapTemplateStepInput({ id: "写稿A", prompt: "Write a draft" } as Parameters<typeof mapTemplateStepInput>[0]);
    expect(step.kind).toBe("drafting");
  });

  it("auto-derives kind 'tts' for 'jay' step id", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");

    const step = mapTemplateStepInput({ id: "jay", prompt: "Generate audio" } as Parameters<typeof mapTemplateStepInput>[0]);
    expect(step.kind).toBe("tts");
  });

  it("preserves explicit user-supplied kind over auto-derivation", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");

    const step = mapTemplateStepInput({ id: "jay", kind: "vocals", prompt: "Generate vocals" } as Parameters<typeof mapTemplateStepInput>[0]);
    expect(step.kind).toBe("vocals");
  });

  it("falls back to step.id verbatim as kind when id has no canonical mapping", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");

    const step = mapTemplateStepInput({ id: "myCustomStep", prompt: "Do something custom" } as Parameters<typeof mapTemplateStepInput>[0]);
    expect(step.kind).toBe("myCustomStep");
  });
});
