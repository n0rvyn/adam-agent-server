import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5.0,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["user", "project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
  getConfig: () => ({
    defaults: {},
    workers: { count: 2, maxTasksBeforeRecycle: 50, maxMemoryMB: 512 },
    server: { port: 7100, host: "0.0.0.0" },
  }),
}));

// Mock TemplateExecutor to prevent actual task execution
vi.mock("../../scheduler/template-executor.js", () => {
  return {
    TemplateExecutor: class {
      async execute(_template: unknown, executionId: string) {
        return { executionId, status: "completed", stepResults: new Map() };
      }
    },
  };
});

import { BreeEngine } from "../../scheduler/bree-engine.js";
import { createTaskTemplate } from "../../store/task-templates.js";

afterAll(() => cleanup());

describe("BreeEngine event triggers", () => {
  let engine: BreeEngine;

  beforeEach(() => {
    clearTestDb();
    engine = new BreeEngine();
  });

  afterEach(async () => {
    await engine.stop();
  });

  it("does not throw when no template_complete triggers match", async () => {
    await engine.checkTemplateCompleteTriggers("nonexistent-template");
  });

  it("matches template_complete:<templateId> triggers", async () => {
    // Template that triggers when pkos-inbox completes
    createTaskTemplate({
      id: "t-sync",
      name: "pkos-sync",
      trigger: { type: "template_complete", event: "template_complete:pkos-inbox" },
      steps: [{ id: "s1", prompt: "sync to notion" }],
      rolePreference: "role-test-seed",
      enabled: true,
      createdAt: Date.now(),
    });

    const executeSpy = vi.spyOn(engine as any, "executeTemplateExecution");
    await engine.checkTemplateCompleteTriggers("pkos-inbox");
    expect(executeSpy).toHaveBeenCalled();
  });

  it("does not match template_complete when templateId differs", async () => {
    // Template that triggers when pkos-inbox completes
    createTaskTemplate({
      id: "t-sync-2",
      name: "pkos-sync-2",
      trigger: { type: "template_complete", event: "template_complete:pkos-inbox" },
      steps: [{ id: "s1", prompt: "sync to notion" }],
      rolePreference: "role-test-seed",
      enabled: true,
      createdAt: Date.now(),
    });

    const executeSpy = vi.spyOn(engine as any, "executeTemplateExecution");
    await engine.checkTemplateCompleteTriggers("pkos-domain-scan");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does not match template_complete when no source templateId matches", async () => {
    createTaskTemplate({
      id: "t-sync-3",
      name: "pkos-sync-3",
      trigger: { type: "template_complete", event: "template_complete:pkos-inbox" },
      steps: [{ id: "s1", prompt: "sync" }],
      rolePreference: "role-test-seed",
      enabled: true,
      createdAt: Date.now(),
    });

    const executeSpy = vi.spyOn(engine as any, "executeTemplateExecution");
    await engine.checkTemplateCompleteTriggers("manual-template");
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
