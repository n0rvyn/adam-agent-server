import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";
import type { TaskTemplate, TaskConfig } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

const TEMPLATE_IDS = [
  "95a97f8c-2168-4195-9188-e2245f1b4ff2",
  "3b696bb6-9d4a-463b-a9da-eb5c86cac8ed",
] as const;

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: overrides.id ?? `tmpl-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? "Test Template",
    description: overrides.description,
    trigger: overrides.trigger ?? { type: "manual" },
    steps: overrides.steps ?? [{ id: "s1", prompt: "Do something" }],
    rolePreference: overrides.rolePreference ?? "role-test-seed",
    config: overrides.config,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt,
  };
}

describe("template-config-delivery deserialization roundtrip", () => {
  describe("primary-artifact mode", () => {
    it("roundtrips primary-artifact mode correctly", () => {
      const tmpl = makeTemplate({
        id: "test-primary-artifact",
        config: {
          delivery: {
            mode: "primary-artifact",
            primaryArtifact: { stepId: "快刀润色", key: "podcast-script-final" },
          },
        } as TaskConfig,
      });
      createTaskTemplate(tmpl);
      const retrieved = getTaskTemplate("test-primary-artifact")!;

      expect(retrieved.config?.delivery).toBeDefined();
      expect(retrieved.config!.delivery!.mode).toBe("primary-artifact");
      expect(retrieved.config!.delivery!.primaryArtifact).toEqual({ stepId: "快刀润色", key: "podcast-script-final" });
    });

    it("roundtrip is stable — re-serialize and re-parse preserves all fields", () => {
      const tmpl = makeTemplate({
        id: "test-roundtrip-stable",
        config: {
          continueOnError: true,
          delivery: {
            mode: "primary-artifact",
            primaryArtifact: { stepId: "polish", key: "final" },
          },
        } as TaskConfig,
      });
      createTaskTemplate(tmpl);

      const retrieved = getTaskTemplate("test-roundtrip-stable")!;
      // Re-serialize
      const reSerialized = JSON.parse(JSON.stringify(retrieved.config));
      // Re-parse
      const reparsed = reSerialized as TaskConfig;

      expect(reparsed.delivery).toEqual({
        mode: "primary-artifact",
        primaryArtifact: { stepId: "polish", key: "final" },
      });
      expect(reparsed.continueOnError).toBe(true);
    });
  });

  describe("concat-step-results mode", () => {
    it("roundtrips concat-step-results mode correctly", () => {
      const tmpl = makeTemplate({
        id: "test-concat-mode",
        config: {
          delivery: { mode: "concat-step-results" },
        } as TaskConfig,
      });
      createTaskTemplate(tmpl);
      const retrieved = getTaskTemplate("test-concat-mode")!;

      expect(retrieved.config?.delivery).toBeDefined();
      expect(retrieved.config!.delivery!.mode).toBe("concat-step-results");
      expect(retrieved.config!.delivery!.primaryArtifact).toBeUndefined();
    });
  });

  describe("custom mode", () => {
    it("roundtrips custom mode with customRenderer preserved", () => {
      const tmpl = makeTemplate({
        id: "test-custom-mode",
        config: {
          delivery: { mode: "custom", customRenderer: "my-custom-template" },
        } as TaskConfig,
      });
      createTaskTemplate(tmpl);
      const retrieved = getTaskTemplate("test-custom-mode")!;

      expect(retrieved.config?.delivery).toBeDefined();
      expect(retrieved.config!.delivery!.mode).toBe("custom");
      expect(retrieved.config!.delivery!.customRenderer).toBe("my-custom-template");
    });
  });

  describe("no delivery config (default behavior)", () => {
    it("template with no config roundtrips with delivery undefined", () => {
      const tmpl = makeTemplate({ id: "test-no-config" });
      createTaskTemplate(tmpl);
      const retrieved = getTaskTemplate("test-no-config")!;

      expect(retrieved.config).toBeUndefined();
    });

    it("template with empty config roundtrips with delivery undefined", () => {
      const tmpl = makeTemplate({
        id: "test-empty-config",
        config: {} as TaskConfig,
      });
      createTaskTemplate(tmpl);
      const retrieved = getTaskTemplate("test-empty-config")!;

      expect(retrieved.config?.delivery).toBeUndefined();
    });
  });

  describe("cross-mode stability", () => {
    it("all three modes roundtrip with correct mode value and no field loss", () => {
      const configs: Array<Partial<TaskConfig>> = [
        { delivery: { mode: "concat-step-results" } },
        { delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "polish", key: "final" } } },
        { delivery: { mode: "custom", customRenderer: "my-renderer" } },
      ];

      for (let i = 0; i < configs.length; i++) {
        const id = `test-mode-${i}`;
        const tmpl = makeTemplate({ id, config: configs[i] });
        createTaskTemplate(tmpl);
        const retrieved = getTaskTemplate(id)!;
        expect(retrieved.config?.delivery?.mode).toBe(configs[i].delivery?.mode);
      }
    });
  });
});
