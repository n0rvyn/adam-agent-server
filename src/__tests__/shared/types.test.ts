import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import type { TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import Fastify from "fastify";
import { taskTemplateRoutes } from "../../server/routes/task-templates.js";

afterAll(() => cleanup());

function createMockBreeEngine() {
  return {
    scheduleJob: vi.fn().mockResolvedValue(undefined),
    unscheduleJob: vi.fn().mockResolvedValue(undefined),
    scheduleOnceJob: vi.fn(),
    runNow: vi.fn().mockResolvedValue("exec-123"),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

async function buildApp() {
  const breeEngine = createMockBreeEngine();
  const app = Fastify();
  await app.register(async (instance) => {
    await taskTemplateRoutes(instance, breeEngine as never);
  });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Type-level: constructing a TaskStep with all new fields compiles cleanly
// ---------------------------------------------------------------------------
describe("TaskStep type — new fields present", () => {
  it("accepts consumesFrom, consumesFromOptional, persona, outputContract", () => {
    const step: TaskStep = {
      id: "step-1",
      prompt: "Hello world",
      consumesFrom: ["step-0"],
      consumesFromOptional: ["step-opt"],
      persona: {
        speakAs: "卞旸",
        voiceConstraints: "自然口语、有观点",
      },
      outputContract: {
        contractRules: [
          { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
          { kind: "format", value: "markdown" },
        ],
        mustReferenceArtifacts: true,
      },
    };
    expect(step.consumesFrom).toEqual(["step-0"]);
    expect(step.consumesFromOptional).toEqual(["step-opt"]);
    expect(step.persona?.speakAs).toBe("卞旸");
    const lengthRule = step.outputContract?.contractRules?.find((r) => r.kind === "lengthTarget");
    expect(lengthRule?.kind === "lengthTarget" ? lengthRule.max : undefined).toBe(2800);
    expect(step.outputContract?.mustReferenceArtifacts).toBe(true);
  });

  it("all four new fields are optional (legacy rows still valid)", () => {
    const step: TaskStep = {
      id: "step-1",
      prompt: "Legacy step",
      dependsOn: ["other"],
    };
    expect(step.consumesFrom).toBeUndefined();
    expect(step.consumesFromOptional).toBeUndefined();
    expect(step.persona).toBeUndefined();
    expect(step.outputContract).toBeUndefined();
  });

  it("persona with only required field (speakAs)", () => {
    const step: TaskStep = {
      id: "step-2",
      prompt: "Minimal persona",
      persona: { speakAs: "Alice" },
    };
    expect(step.persona?.speakAs).toBe("Alice");
    expect(step.persona?.voiceConstraints).toBeUndefined();
  });

  it("outputContract with only a format contractRule", () => {
    const step: TaskStep = {
      id: "step-3",
      prompt: "Minimal contract",
      outputContract: { contractRules: [{ kind: "format", value: "json" }] },
    };
    const formatRule = step.outputContract?.contractRules?.find((r) => r.kind === "format");
    expect(formatRule?.kind === "format" ? formatRule.value : undefined).toBe("json");
    expect(step.outputContract?.contractRules?.some((r) => r.kind === "lengthTarget")).toBe(false);
    expect(step.outputContract?.mustReferenceArtifacts).toBeUndefined();
  });

  it("lengthTarget contractRule unit accepts all three values", () => {
    const units: Array<"characters" | "words" | "bytes"> = ["characters", "words", "bytes"];
    units.forEach((unit) => {
      const step: TaskStep = {
        id: "step-4",
        prompt: "Unit test",
        outputContract: { contractRules: [{ kind: "lengthTarget", min: 0, max: 100, unit }] },
      };
      const lengthRule = step.outputContract?.contractRules?.find((r) => r.kind === "lengthTarget");
      expect(lengthRule?.kind === "lengthTarget" ? lengthRule.unit : undefined).toBe(unit);
    });
  });
});

// ---------------------------------------------------------------------------
// taskStepSchema — new fields validate correctly via HTTP routes
// ---------------------------------------------------------------------------
describe("taskStepSchema — new fields via HTTP", () => {
  beforeEach(() => clearTestDb());

  it("POST /task-templates with all new fields returns 201", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Schema Test Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [
          { id: "step-1", prompt: "Gather info" },
          {
            id: "step-2",
            prompt: "Write draft",
            consumesFrom: ["step-1"],
            consumesFromOptional: [],
            persona: { speakAs: "卞旸", voiceConstraints: "自然口语" },
            outputContract: {
              contractRules: [
                { kind: "lengthTarget", min: 2200, max: 2800, unit: "characters" },
                { kind: "format", value: "markdown" },
              ],
              mustReferenceArtifacts: true,
            },
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    const { templateId } = res.json() as { templateId: string };

    // Retrieve the created template to verify new fields persisted
    const app2 = await buildApp();
    const getRes = await app2.inject({
      method: "GET",
      url: `/task-templates/${templateId}`,
      headers: { "x-api-key": "test-key" },
    });
    await app2.close();
    expect(getRes.statusCode).toBe(200);
    const created = getRes.json().template;
    expect(created.steps[1].consumesFrom).toEqual(["step-1"]);
    expect(created.steps[1].persona?.speakAs).toBe("卞旸");
    expect(created.steps[1].outputContract?.mustReferenceArtifacts).toBe(true);
  });

  it("POST rejects outputContract.lengthTarget.max = 0 (positive int required)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Bad Length Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [
          {
            id: "step-1",
            prompt: "Test",
            outputContract: { contractRules: [{ kind: "lengthTarget", min: 0, max: 0, unit: "characters" }] },
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/400|positive|max/i);
  });

  it("POST rejects outputContract.lengthTarget.min > max", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Bad Range Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [
          {
            id: "step-1",
            prompt: "Test",
            outputContract: { contractRules: [{ kind: "lengthTarget", min: 2800, max: 2200, unit: "characters" }] },
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/min.*max|lengthTarget/i);
  });

  it("POST rejects persona.speakAs = '' (min 1)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Bad Persona Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [{ id: "step-1", prompt: "Test", persona: { speakAs: "" } }],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("POST rejects invalid outputContract.lengthTarget.unit", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Bad Unit Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [
          {
            id: "step-1",
            prompt: "Test",
            outputContract: { contractRules: [{ kind: "lengthTarget", min: 0, max: 100, unit: "lines" }] },
          },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it("POST accepts consumesFrom and consumesFromOptional (empty arrays)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Optional Fields Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [
          { id: "step-1", prompt: "Test", consumesFrom: [], consumesFromOptional: [] },
        ],
      },
    });
    await app.close();
    expect(res.statusCode).toBe(201);
  });

  it("PATCH /task-templates/:id with new fields returns 200", async () => {
    // First create a bare template with rolePreference
    const app1 = await buildApp();
    const createRes = await app1.inject({
      method: "POST",
      url: "/task-templates",
      headers: { "x-api-key": "test-key" },
      payload: {
        name: "Patch Test Template",
        rolePreference: "审慎者",
        trigger: { type: "manual" },
        steps: [{ id: "step-1", prompt: "Original" }],
      },
    });
    await app1.close();
    expect(createRes.statusCode).toBe(201);
    const { templateId } = createRes.json() as { templateId: string };

    const app2 = await buildApp();
    const patchRes = await app2.inject({
      method: "PATCH",
      url: `/task-templates/${templateId}`,
      headers: { "x-api-key": "test-key" },
      payload: {
        steps: [
          {
            id: "step-1",
            prompt: "Updated with new fields",
            consumesFrom: [],
            persona: { speakAs: "Alice", voiceConstraints: "formal" },
            outputContract: { contractRules: [{ kind: "format", value: "text" }], mustReferenceArtifacts: false },
          },
        ],
      },
    });
    await app2.close();
    expect(patchRes.statusCode).toBe(200);

    // Retrieve to verify new fields persisted
    const app3 = await buildApp();
    const getRes = await app3.inject({
      method: "GET",
      url: `/task-templates/${templateId}`,
      headers: { "x-api-key": "test-key" },
    });
    await app3.close();
    expect(getRes.statusCode).toBe(200);
    const patched = getRes.json().template;
    expect(patched.steps[0].persona?.speakAs).toBe("Alice");
    expect(patched.steps[0].outputContract?.contractRules).toEqual([{ kind: "format", value: "text" }]);
    expect(patched.steps[0].consumesFrom).toEqual([]);
  });
});
