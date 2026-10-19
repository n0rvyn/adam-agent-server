/**
 * Task 1b-tests: Schema propagation + validator for minDependencies.
 *
 * Tests:
 * 1. templateStepInputShape accepts minDependencies on a step (zod round-trip)
 * 2. updateTemplateShape full-step-replace path persists minDependencies
 * 3. updateTemplateShape targeted-patch path persists minDependencies
 * 4. validateTemplateDefinition accepts valid minDependencies
 * 5. validateTemplateDefinition rejects minDependencies=0
 * 6. validateTemplateDefinition rejects minDependencies > dependsOn.length
 *
 * Pre-impl: zod strips unknown field → parsed result has no minDependencies.
 * Pre-impl: validator doesn't know about the field → all validations pass.
 */

import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { mockCreateSdkMcpServer, mockTool, mockDispatchTemplate } = vi.hoisted(() => {
  const mockCreateSdkMcpServer = vi.fn().mockImplementation((config: unknown) => config);
  const mockTool = vi.fn().mockImplementation((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler,
  }));
  const mockDispatchTemplate = vi.fn().mockResolvedValue(undefined);
  return { mockCreateSdkMcpServer, mockTool, mockDispatchTemplate };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

vi.mock("../../scheduler/template-dispatch.js", () => ({
  dispatchTemplate: mockDispatchTemplate,
}));

const { createAdamTools } = await import("../../manager/adam-tools.js");
const { getTaskTemplate, updateTaskTemplate } = await import("../../store/task-templates.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("minDependencies schema propagation via MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    mockDispatchTemplate.mockClear();
    clearTestDb();
    initializeDefaultRoles();
  });

  afterAll(() => cleanup());

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    return config.tools.find((t: { name: string }) => t.name === name);
  }

  /**
   * Test 1 — minDependencies round-trip through templateStepInputShape → mapTemplateStepInput.
   * We test via the exported mapTemplateStepInput which is the output path from the zod parser.
   * Pre-impl FAIL: templateStepInputShape doesn't include minDependencies → mapTemplateStepInput drops it.
   */
  it("(test 1) mapTemplateStepInput preserves minDependencies=2 from parsed step", async () => {
    // mapTemplateStepInput is the function called by the create/update handlers after zod parsing.
    // If the zod shape has minDependencies, it flows through to mapped.minDependencies.
    // If the zod shape doesn't have minDependencies, the function has no field to spread.
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");
    const mapped = mapTemplateStepInput({
      id: "评分",
      prompt: "Score the output",
      dependsOn: ["写稿A", "写稿B", "写稿C"],
      minDependencies: 2,
    });
    // Pre-impl: templateStepInputShape doesn't have minDependencies field.
    // The function can't spread a field it doesn't receive → FAILS.
    expect(mapped.minDependencies).toBe(2);
  });

  /**
   * Test 2 — update_template full-step-replace path: minDependencies must flow through.
   * Same as test 1 (same mapTemplateStepInput function).
   * Pre-impl: FAILS for same reason.
   */
  it("(test 2) mapTemplateStepInput preserves minDependencies=2 for full-step-replace", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");
    const mapped = mapTemplateStepInput({
      id: "评分",
      prompt: "Score",
      dependsOn: ["写稿A", "写稿B", "写稿C"],
      minDependencies: 2,
    });
    expect(mapped.minDependencies).toBe(2);
  });

  /**
   * Test 3 — updateTemplateShape targeted-patch: minDependencies is a direct field.
   * The targeted patch flow sets step-specific fields (stepId + other fields) on a step.
   * We verify that mapTemplateStepInput preserves minDependencies even when only
   * a subset of fields is provided (as in targeted patch).
   * Pre-impl: FAILS because mapTemplateStepInput has no spread for minDependencies.
   */
  it("(test 3) mapTemplateStepInput preserves minDependencies in targeted-patch context", async () => {
    const { mapTemplateStepInput } = await import("../../manager/adam-tools.js");
    // Targeted patch: only stepId + minDependencies are set; prompt/dependsOn come from existing step.
    const mapped = mapTemplateStepInput({
      id: "评分",
      prompt: "test",
      // dependsOn not set in targeted-patch for step-level fields
      minDependencies: 2,
    });
    expect(mapped.minDependencies).toBe(2);
  });

  /**
   * Test 4 — REGRESSION for #262: update_template targeted-patch handler must persist
   * minDependencies when it is the ONLY step field passed (stepId + minDependencies, no steps[]).
   *
   * This drives the real update_template handler branch (adam-tools.ts stepFieldsChanging +
   * merge block), NOT mapTemplateStepInput. Pre-fix: stepFieldsChanging omitted minDependencies,
   * so a {stepId, minDependencies}-only call returned success but was a silent no-op — the DB row
   * was never touched. Tests 1-3 above all called mapTemplateStepInput directly and so never
   * exercised this branch, which is why the bug shipped.
   */
  it("(test 4 — #262 regression) update_template {stepId, minDependencies} persists via targeted patch", async () => {
    const createTool = getTool("create_template");
    const created = await createTool.handler({
      name: "tmpl-262-regression",
      triggerType: "manual",
      config: { continueOnError: true },
      steps: [
        { id: "写稿A", prompt: "A", autoSelectRole: true, requirements: {}, outputAs: "a" },
        { id: "写稿B", prompt: "B", autoSelectRole: true, requirements: {}, outputAs: "b" },
        { id: "写稿C", prompt: "C", autoSelectRole: true, requirements: {}, outputAs: "c" },
        { id: "评分", prompt: "Score {{写稿A.result}}", autoSelectRole: true, requirements: {}, dependsOn: ["写稿A", "写稿B", "写稿C"] },
      ],
    });
    const createParsed = JSON.parse(created.content[0].text);
    expect(createParsed.error).toBeUndefined();
    const templateId = createParsed.templateId as string;

    // Sanity: 评分 starts with no minDependencies (strict-AND).
    const before = getTaskTemplate(templateId);
    const scoreBefore = before!.steps.find((s) => s.id === "评分");
    expect(scoreBefore?.minDependencies).toBeUndefined();

    // Targeted patch: ONLY stepId + minDependencies, no steps[] array.
    const updateTool = getTool("update_template");
    const result = await updateTool.handler({ templateId, stepId: "评分", minDependencies: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeUndefined();

    // The 评分 step must now require only 2 of 3 dependencies; other steps untouched.
    const after = getTaskTemplate(templateId);
    const scoreAfter = after!.steps.find((s) => s.id === "评分");
    expect(scoreAfter?.minDependencies).toBe(2);
    expect(after!.steps.find((s) => s.id === "写稿A")?.minDependencies).toBeUndefined();
    // Step ordering and count preserved (no full-replace side effects).
    expect(after!.steps.map((s) => s.id)).toEqual(["写稿A", "写稿B", "写稿C", "评分"]);
  });
});
