import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { z } from "zod";
import { setupTestDb, getTestDb, clearTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// Mock DB so stores hit the in-memory test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

// Mock the SDK (must use vi.hoisted so the factory can reference the mocks at parse time)
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

// Dynamically import adam-tools AFTER mocks are set up
const { createAdamTools } = await import("../../manager/adam-tools.js");

// Import real store for result verification
const { getTaskTemplate } = await import("../../store/task-templates.js");
const { initializeDefaultRoles } = await import("../../store/role-presets.js");
const { listRuntimeEffectsByTrace } = await import("../../store/runtime-effects.js");
const { withTrace } = await import("../../lib/trace-context.js");
const { listRoles } = await import("../../store/roles.js");

describe("adam-tools templates with event trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSdkMcpServer.mockClear();
    mockTool.mockClear();
    mockDispatchTemplate.mockClear();
    clearTestDb();
    // Seed system roles (needed by some tools)
    initializeDefaultRoles();
  });

  afterAll(() => cleanup());

  function getTool(name: string) {
    createAdamTools();
    const config = mockCreateSdkMcpServer.mock.calls[0][0];
    return config.tools.find((t: { name: string }) => t.name === name);
  }

  describe("create_template", () => {
    it("stores trigger.type=event and trigger.eventDefId when triggerType=event with valid eventDefId", async () => {
      const tool = getTool("create_template");
      expect(tool).toBeDefined();
      const eventDefId = "550e8400-e29b-41d4-a716-446655440000";

      const result = await tool.handler({
        name: "tmpl-test-event",
        triggerType: "event",
        eventDefId,
        prompt: "process the event",
        autoSelectRole: true,
        requirements: {},
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.trigger.type).toBe("event");
      expect(parsed.trigger.eventDefId).toBe(eventDefId);

      // Verify via real store
      const saved = getTaskTemplate(parsed.templateId);
      expect(saved).toBeDefined();
      expect(saved!.trigger.type).toBe("event");
      expect(saved!.trigger.eventDefId).toBe(eventDefId);
    });

    it("returns error when triggerType=event but eventDefId is missing", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-bad",
        triggerType: "event",
        prompt: "process the event",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("eventDefId required");
    });

    it("returns error when triggerType=cron but eventDefId is provided", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-bad2",
        triggerType: "cron",
        triggerCron: "0 9 * * *",
        eventDefId: "550e8400-e29b-41d4-a716-446655440000",
        prompt: "process",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("eventDefId only valid when triggerType='event'");
    });

    it("stores cron trigger correctly when triggerType=cron", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-cron",
        triggerType: "cron",
        triggerCron: "0 9 * * *",
        prompt: "morning brief",
        autoSelectRole: true,
        requirements: {},
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.trigger.type).toBe("cron");
      expect(parsed.trigger.cron).toBe("0 9 * * *");
      expect(parsed.trigger.eventDefId).toBeUndefined();

      // Verify via real store
      const saved = getTaskTemplate(parsed.templateId);
      expect(saved!.trigger.type).toBe("cron");
      expect(saved!.trigger.eventDefId).toBeUndefined();
    });

    it("defaults to manual trigger for shorthand single-step Templates", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-manual",
        prompt: "manual run",
        autoSelectRole: true,
        requirements: {},
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.trigger.type).toBe("manual");
      expect(parsed.stepCount).toBe(1);
      expect(parsed.steps[0]).toMatchObject({ id: "step-1", autoSelectRole: true });

      const saved = getTaskTemplate(parsed.templateId);
      expect(saved!.trigger.type).toBe("manual");
      expect(saved!.steps[0]).toMatchObject({ id: "step-1", prompt: "manual run", autoSelectRole: true });
    });

    it("stores canonical steps[] with dependencies and outputAs", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-steps",
        triggerType: "manual",
        config: { continueOnError: true },
        steps: [
          { id: "extract", prompt: "Extract", autoSelectRole: true, requirements: {}, outputAs: "raw" },
          { id: "summarize", prompt: "Summarize {{extract.result}}", autoSelectRole: true, requirements: {}, dependsOn: ["extract"] },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.stepCount).toBe(2);
      expect(parsed.steps[0]).toMatchObject({ id: "extract", outputAs: "raw" });

      const saved = getTaskTemplate(parsed.templateId);
      expect(saved!.steps).toEqual([
        { id: "extract", kind: "extract", prompt: "Extract", autoSelectRole: true, requirements: {}, outputAs: "raw" },
        { id: "summarize", kind: "summarize", prompt: "Summarize {{extract.result}}", autoSelectRole: true, requirements: {}, dependsOn: ["extract"] },
      ]);
      expect(saved!.config?.continueOnError).toBe(true);
    });

    it("stores canonical steps[] with outputContract, persona, and consumed artifacts", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-contract-fields",
        triggerType: "manual",
        steps: [
          {
            id: "draft",
            prompt: "Draft transcript",
            autoSelectRole: true,
            requirements: {},
            outputAs: "transcript",
            consumesFrom: ["research"],
            consumesFromOptional: ["outline"],
            persona: { speakAs: "Host", voiceConstraints: "Plainspoken" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
              mustReferenceArtifacts: true,
            },
          },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.steps[0]).toMatchObject({
        id: "draft",
        consumesFrom: ["research"],
        consumesFromOptional: ["outline"],
        persona: { speakAs: "Host", voiceConstraints: "Plainspoken" },
        outputContract: {
          contractRules: [
            { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
            { kind: "format", value: "markdown" },
          ],
          mustReferenceArtifacts: true,
        },
      });

      const saved = getTaskTemplate(parsed.templateId);
      expect(saved!.steps[0]).toMatchObject({
        consumesFrom: ["research"],
        consumesFromOptional: ["outline"],
        persona: { speakAs: "Host", voiceConstraints: "Plainspoken" },
        outputContract: {
          contractRules: [
            { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
            { kind: "format", value: "markdown" },
          ],
          mustReferenceArtifacts: true,
        },
      });
    });

    it("stores goalIds as Template execution context without replacing steps", async () => {
      const tool = getTool("create_template");
      const goalIds = ["goal-alpha", "goal-beta"];

      const result = await tool.handler({
        name: "tmpl-test-goals",
        prompt: "Ship the milestone",
        autoSelectRole: true,
        requirements: {},
        goalIds,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();
      expect(parsed.stepCount).toBe(1);
      expect(parsed.goalIds).toEqual(goalIds);

      const saved = getTaskTemplate(parsed.templateId);
      expect(saved!.goalIds).toEqual(goalIds);
      expect(saved!.steps).toHaveLength(1);
      expect(saved!.steps[0]).toMatchObject({ id: "step-1", prompt: "Ship the milestone" });
    });

    it("rejects goalIds-only Templates because Goal is a Template property, not a task body", async () => {
      const tool = getTool("create_template");

      const result = await tool.handler({
        name: "tmpl-test-goals-only",
        goalIds: ["goal-alpha"],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("requires either prompt shorthand or canonical steps[]");
    });
  });

  describe("update_template", () => {
    async function createTemplate(name: string, triggerType = "cron", triggerCron = "0 9 * * *", eventDefId?: string) {
      const tool = getTool("create_template");
      const args: Record<string, unknown> = { name, triggerType, prompt: "test prompt", autoSelectRole: true, requirements: {} };
      if (triggerCron) args.triggerCron = triggerCron;
      if (eventDefId) args.eventDefId = eventDefId;
      const result = await tool.handler(args);
      return JSON.parse(result.content[0].text);
    }

    it("updates trigger to event type with eventDefId", async () => {
      const created = await createTemplate("tmpl-test-update");

      const updateTool = getTool("update_template");
      const eventDefId = "550e8400-e29b-41d4-a716-446655440099";
      const result = await updateTool.handler({ templateId: created.templateId, triggerType: "event", eventDefId });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      const saved = getTaskTemplate(created.templateId);
      expect(saved!.trigger.type).toBe("event");
      expect(saved!.trigger.eventDefId).toBe(eventDefId);
    });

    it("returns error when triggerType=event but eventDefId is missing", async () => {
      const created = await createTemplate("tmpl-test-update2");

      const updateTool = getTool("update_template");
      const result = await updateTool.handler({ templateId: created.templateId, triggerType: "event" });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("eventDefId required");
    });

    it("infers type=event from eventDefId without explicit triggerType", async () => {
      const created = await createTemplate("tmpl-test-update3");

      const updateTool = getTool("update_template");
      const eventDefId = "550e8400-e29b-41d4-a716-446655440099";
      const result = await updateTool.handler({ templateId: created.templateId, eventDefId });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);

      const saved = getTaskTemplate(created.templateId);
      expect(saved!.trigger.type).toBe("event");
      expect(saved!.trigger.eventDefId).toBe(eventDefId);
    });

    it("supports full steps[] replacement", async () => {
      const created = await createTemplate("tmpl-test-steps-replace");
      const updateTool = getTool("update_template");

      const result = await updateTool.handler({
        templateId: created.templateId,
        steps: [
          { id: "first", prompt: "First", autoSelectRole: true, requirements: {}, outputAs: "firstOut" },
          { id: "second", prompt: "Second", autoSelectRole: true, requirements: {}, dependsOn: ["first"] },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(getTaskTemplate(created.templateId)!.steps.map((step) => step.id)).toEqual(["first", "second"]);
      expect(getTaskTemplate(created.templateId)!.steps[0].outputAs).toBe("firstOut");
    });

    it("writes runtime effect rows for targeted step changes", async () => {
      const created = await createTemplate("tmpl-runtime-effect");
      const updateTool = getTool("update_template");

      await withTrace("trace-update-template", "chat", async () => {
        const result = await updateTool.handler({
          templateId: created.templateId,
          stepId: "step-1",
          prompt: "Updated prompt",
          config: { backgroundMusicVolume: -5 },
        });
        expect(JSON.parse(result.content[0].text).success).toBe(true);
      });

      const effects = listRuntimeEffectsByTrace("trace-update-template");
      expect(effects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          effectCategory: "template_update",
          entityType: "task_template",
          entityId: created.templateId,
          fieldPath: "steps.step-1.prompt",
          toolName: "update_template",
        }),
        expect.objectContaining({
          effectCategory: "template_update",
          fieldPath: "steps.step-1.config.backgroundMusicVolume",
        }),
      ]));
    });

    it("preserves full contract fields during steps[] replacement", async () => {
      const created = await createTemplate("tmpl-test-steps-replace-contract");
      const updateTool = getTool("update_template");

      const result = await updateTool.handler({
        templateId: created.templateId,
        steps: [
          {
            id: "draft",
            prompt: "Draft",
            autoSelectRole: true,
            requirements: {},
            outputAs: "draftText",
            consumesFrom: ["research"],
            consumesFromOptional: ["outline"],
            persona: { speakAs: "Narrator", voiceConstraints: "Concise" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
              mustReferenceArtifacts: true,
            },
          },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.template.steps[0]).toMatchObject({
        outputAs: "draftText",
        consumesFrom: ["research"],
        consumesFromOptional: ["outline"],
        persona: { speakAs: "Narrator", voiceConstraints: "Concise" },
        outputContract: {
          contractRules: [
            { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
            { kind: "format", value: "markdown" },
          ],
          mustReferenceArtifacts: true,
        },
      });

      const saved = getTaskTemplate(created.templateId)!;
      expect(saved.steps[0]).toMatchObject(parsed.template.steps[0]);
    });

    it("supports stepId-targeted edits", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-targeted",
        triggerType: "manual",
        steps: [
          { id: "first", prompt: "First", autoSelectRole: true, requirements: {} },
          { id: "second", prompt: "Second", autoSelectRole: true, requirements: {}, dependsOn: ["first"] },
        ],
      })).content[0].text);

      const updateTool = getTool("update_template");
      const result = await updateTool.handler({
        templateId: created.templateId,
        stepId: "second",
        prompt: "Updated second",
        outputAs: "summary",
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      const saved = getTaskTemplate(created.templateId)!;
      expect(saved.steps[0].prompt).toBe("First");
      expect(saved.steps[1]).toMatchObject({ prompt: "Updated second", outputAs: "summary" });
    });

    it("supports stepId-targeted outputContract updates", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-targeted-contract",
        triggerType: "manual",
        steps: [
          {
            id: "draft",
            prompt: "Draft",
            autoSelectRole: true,
            requirements: {},
            outputContract: { contractRules: [{ kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" }] },
          },
        ],
      })).content[0].text);

      const updateTool = getTool("update_template");
      const result = await updateTool.handler({
        templateId: created.templateId,
        stepId: "draft",
        outputContract: {
          contractRules: [{ kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" }],
        },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.template.steps[0].outputContract.contractRules).toEqual([
        { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
      ]);

      const saved = getTaskTemplate(created.templateId)!;
      expect(saved.steps[0].outputContract?.contractRules).toEqual([
        { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
      ]);
    });

    it("requires stepId for shorthand prompt updates on multi-step Templates", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-multi-error",
        triggerType: "manual",
        steps: [
          { id: "first", prompt: "First", autoSelectRole: true, requirements: {} },
          { id: "second", prompt: "Second", autoSelectRole: true, requirements: {}, dependsOn: ["first"] },
        ],
      })).content[0].text);

      const updateTool = getTool("update_template");
      const result = await updateTool.handler({ templateId: created.templateId, prompt: "Ambiguous" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("stepId is required");
    });
  });

  describe("get_template_detail", () => {
    it("returns full persisted step config", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-detail",
        description: "Detail test",
        triggerType: "manual",
        config: { continueOnError: true },
        steps: [
          {
            id: "research",
            prompt: "Research",
            autoSelectRole: true,
            requirements: {},
            outputAs: "researchNotes",
          },
          {
            id: "draft",
            prompt: "Draft",
            autoSelectRole: true,
            requirements: {},
            dependsOn: ["research"],
            config: { timeout: 120, maxTurns: 8 },
            outputAs: "draftText",
            consumesFrom: ["research"],
            consumesFromOptional: ["outline"],
            persona: { speakAs: "Host" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
            },
          },
        ],
      })).content[0].text);

      const detailTool = getTool("get_template_detail");
      const result = await detailTool.handler({ templateId: created.templateId });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeUndefined();

      expect(parsed).toMatchObject({
        id: created.templateId,
        name: "tmpl-test-detail",
        description: "Detail test",
        enabled: true,
        trigger: { type: "manual" },
        config: { continueOnError: true },
      });
      expect(parsed.steps[1]).toMatchObject({
        id: "draft",
        prompt: "Draft",
        autoSelectRole: true,
        dependsOn: ["research"],
        outputAs: "draftText",
        config: { timeout: 120, maxTurns: 8 },
        consumesFrom: ["research"],
        consumesFromOptional: ["outline"],
        persona: { speakAs: "Host" },
        outputContract: {
          contractRules: [
            { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
            { kind: "format", value: "markdown" },
          ],
        },
      });
    });

    it("returns not-found error for unknown template", async () => {
      const detailTool = getTool("get_template_detail");
      const result = await detailTool.handler({ templateId: "missing-template" });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed).toEqual({ error: "Template not found: missing-template" });
    });
  });

  describe("list_templates", () => {
    it("summarizes configurable step fields when present", async () => {
      const createTool = getTool("create_template");
      await createTool.handler({
        name: "tmpl-test-list-contract",
        triggerType: "manual",
        steps: [
          {
            id: "draft",
            prompt: "Draft",
            autoSelectRole: true,
            requirements: {},
            consumesFrom: ["research"],
            consumesFromOptional: ["outline"],
            persona: { speakAs: "Host" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
            },
          },
        ],
      });

      const listTool = getTool("list_templates");
      const result = await listTool.handler({});
      const parsed = JSON.parse(result.content[0].text);
      const template = parsed.find((item: { name: string }) => item.name === "tmpl-test-list-contract");

      expect(template.steps[0]).toMatchObject({
        consumesFrom: ["research"],
        consumesFromOptional: ["outline"],
        persona: { speakAs: "Host" },
        outputContract: {
          contractRules: [
            { kind: "lengthTarget", min: 2500, max: 20000, unit: "characters" },
            { kind: "format", value: "markdown" },
          ],
        },
      });
      expect(template.steps[0].promptPreview).toBe("Draft");
    });
  });

  describe("template step schema validation", () => {
    function updateTemplateSchema() {
      const tool = getTool("update_template");
      return z.object(tool.inputSchema);
    }

    // Single-vocabulary pure design: contract values are validated through ContractRuleItemSchema
    // (the legacy lengthTarget/format outputContract fields were removed). Bad rule values must be rejected.
    it.each([
      ["negative lengthTarget min", { contractRules: [{ kind: "lengthTarget", min: -1, max: 10, unit: "characters" }] }],
      ["nonpositive lengthTarget max", { contractRules: [{ kind: "lengthTarget", min: 0, max: 0, unit: "characters" }] }],
      ["lengthTarget min greater than max", { contractRules: [{ kind: "lengthTarget", min: 11, max: 10, unit: "characters" }] }],
      ["invalid lengthTarget unit", { contractRules: [{ kind: "lengthTarget", min: 1, max: 10, unit: "pages" }] }],
      ["invalid format value", { contractRules: [{ kind: "format", value: "html" }] }],
      ["unknown rule kind", { contractRules: [{ kind: "bogus", value: "x" }] }],
    ])("rejects outputContract with %s", (_name, outputContract) => {
      const parsed = updateTemplateSchema().safeParse({
        templateId: "tmpl-test-schema",
        stepId: "draft",
        outputContract,
      });

      expect(parsed.success).toBe(false);
    });
  });

  describe("run_template", () => {
    it("dispatches a Template through the internal execution path", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-run",
        prompt: "Run me",
        autoSelectRole: true,
        requirements: {},
      })).content[0].text);

      const runTool = getTool("run_template");
      const result = await runTool.handler({ templateId: created.templateId });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.executionId).toBeDefined();
      expect(mockDispatchTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.templateId, name: "tmpl-test-run" }),
        expect.objectContaining({ executionId: parsed.executionId, triggerContext: { source: "adam-tools" } }),
      );
    });

    it("writes template_execution_started runtime effect after run_template starts", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-run-effect",
        prompt: "Run me",
        autoSelectRole: true,
        requirements: {},
      })).content[0].text);

      const runTool = getTool("run_template");
      let executionId = "";
      await withTrace("trace-run-template", "chat", async () => {
        const result = await runTool.handler({ templateId: created.templateId });
        const parsed = JSON.parse(result.content[0].text);
        executionId = parsed.executionId;
      });

      expect(listRuntimeEffectsByTrace("trace-run-template")).toEqual([
        expect.objectContaining({
          effectCategory: "template_execution_started",
          entityType: "template_execution",
          entityId: executionId,
          toolName: "run_template",
        }),
      ]);
    });

    it("writes task_scheduled and task_cancelled effects for one-shot scheduling", async () => {
      const activeRole = listRoles("active", 20, 0).find((role) => role.source !== "system") ?? listRoles("active", 20, 0)[0];
      const scheduleTool = getTool("schedule_task");
      const cancelTool = getTool("cancel_scheduled_task");
      let templateId = "";

      await withTrace("trace-schedule-task", "chat", async () => {
        const scheduled = JSON.parse((await scheduleTool.handler({
          prompt: "Do this later",
          delayMinutes: 30,
          roleId: activeRole.id,
        })).content[0].text);
        templateId = scheduled.templateId;
      });
      expect(listRuntimeEffectsByTrace("trace-schedule-task")).toEqual([
        expect.objectContaining({
          effectCategory: "task_scheduled",
          entityType: "task_template",
          entityId: templateId,
          toolName: "schedule_task",
        }),
      ]);

      await withTrace("trace-cancel-task", "chat", async () => {
        const cancelled = JSON.parse((await cancelTool.handler({ templateId })).content[0].text);
        expect(cancelled.cancelled).toBe(true);
      });
      expect(listRuntimeEffectsByTrace("trace-cancel-task")).toEqual([
        expect.objectContaining({
          effectCategory: "task_cancelled",
          entityType: "task_template",
          entityId: templateId,
          toolName: "cancel_scheduled_task",
        }),
      ]);
    });

    it("returns a TemplateExecution ID for Goal-backed Templates", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-test-run-goal",
        prompt: "Run with goal context",
        autoSelectRole: true,
        requirements: {},
        goalIds: ["goal-alpha"],
      })).content[0].text);

      const runTool = getTool("run_template");
      const result = await runTool.handler({ templateId: created.templateId });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.success).toBe(true);
      expect(parsed.executionId).toBeDefined();
      expect(parsed.templateId).toBe(created.templateId);
      expect(mockDispatchTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: created.templateId, goalIds: ["goal-alpha"] }),
        expect.objectContaining({ executionId: parsed.executionId, triggerContext: { source: "adam-tools" } }),
      );
    });
  });

  describe("Template contract compatibility — identity wording preserved", () => {
    it("manual single-step Template preserves identity wording in prompt", async () => {
      const tool = getTool("create_template");
      const created = JSON.parse((await tool.handler({
        name: "tmpl-identity-single",
        prompt: "你是 Boris。整理今天邮件",
        autoSelectRole: true,
        requirements: {},
      })).content[0].text);

      expect(created.error).toBeUndefined();
      expect(created.templateId).toBeDefined();

      // Verify the saved prompt matches exactly (shorthand prompt → steps[0].prompt)
      const { getTaskTemplate } = await import("../../store/task-templates.js");
      const saved = getTaskTemplate(created.templateId);
      expect(saved?.steps?.[0]?.prompt).toBe("你是 Boris。整理今天邮件");
    });

    it("multi-step Template preserves identity wording in step prompts", async () => {
      const tool = getTool("create_template");
      const created = JSON.parse((await tool.handler({
        name: "tmpl-identity-multi",
        steps: [
          { id: "step-1", prompt: "你是 Researcher。收集材料", autoSelectRole: true, requirements: {} },
          { id: "step-2", prompt: "你是 Writer。基于 {{step-1.result}} 写正文", autoSelectRole: true, requirements: {}, dependsOn: ["step-1"] },
        ],
      })).content[0].text);

      expect(created.error).toBeUndefined();
      expect(created.templateId).toBeDefined();

      const { getTaskTemplate } = await import("../../store/task-templates.js");
      const saved = getTaskTemplate(created.templateId);
      expect(saved?.steps).toHaveLength(2);
      expect(saved?.steps?.[0]?.prompt).toBe("你是 Researcher。收集材料");
      expect(saved?.steps?.[1]?.prompt).toBe("你是 Writer。基于 {{step-1.result}} 写正文");
      expect(saved?.steps?.[1]?.dependsOn).toEqual(["step-1"]);
    });

    it("update_template targeted step edit preserves identity wording", async () => {
      const createTool = getTool("create_template");
      const created = JSON.parse((await createTool.handler({
        name: "tmpl-identity-update",
        steps: [
          { id: "step-a", prompt: "你是 Researcher。收集材料", autoSelectRole: true, requirements: {} },
          { id: "step-b", prompt: "你是 Writer。写正文", autoSelectRole: true, requirements: {} },
        ],
      })).content[0].text);

      const updateTool = getTool("update_template");
      const updated = JSON.parse((await updateTool.handler({
        templateId: created.templateId,
        steps: [
          { id: "step-a", prompt: "你是 Researcher。收集材料", autoSelectRole: true, requirements: {} },
          { id: "step-b", prompt: "你是 Editor。润色 {{step-a.result}}", autoSelectRole: true, requirements: {} },
        ],
      })).content[0].text);

      expect(updated.error).toBeUndefined();

      const { getTaskTemplate } = await import("../../store/task-templates.js");
      const saved = getTaskTemplate(created.templateId);
      expect(saved?.steps?.[1]?.prompt).toBe("你是 Editor。润色 {{step-a.result}}");
    });
  });
});
