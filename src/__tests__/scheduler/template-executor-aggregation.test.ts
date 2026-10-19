/**
 * Tests for TemplateExecutor artifact aggregation into single result_delivery.
 *
 * Verifies Phase 4 change: non-email channels no longer send summary + N×artifact
 * as separate messages; instead all file artifacts are bundled as attachments[] in
 * a single sendViaGateway call with messageType="result_delivery".
 *
 * Covers:
 * - 3 file artifacts → single sendViaGateway call with 3 attachments
 * - 0 file artifacts → sendViaGateway with empty attachments array
 * - email channel → existing behavior preserved (attachments in single call)
 * - custom deliveryMessageType → gateway.send called with translated envelope kind
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// --- Hoisted mutable mock state ---
const { artifactRows, mockRedeliver } = vi.hoisted(() => {
  const artifactRows: Array<{
    id: string;
    executionId: string;
    stepId: string;
    key: string;
    kind: "json" | "file";
    value?: unknown;
    blobPath?: string;
    mime?: string;
    originalFilename?: string;
    locator?: string;
    purpose?: "report" | "media" | "data" | "scratch" | "archive";
    contentHash?: string;
    sizeBytes: number;
    createdAt: number;
  }> = [];
  const mockRedeliver = vi.fn().mockResolvedValue({
    deliveries: [{ target: { channelId: "mock", chatId: "mock" }, deliveryLogId: "log-1", status: "delivered", attachmentCount: 0 }],
  });
  return { artifactRows, mockRedeliver };
});

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
    settingSources: ["project"],
    allowedTools: [],
    disallowedTools: [],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({
    send: vi.fn().mockResolvedValue({ success: true, logEntryId: "log-1" }),
    redeliverExecutionTo: mockRedeliver,
  }),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => artifactRows),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((id: string) => {
    if (id === "email-1") return { id, platform: "email" };
    if (id === "wechat-1") return { id, platform: "wechat" };
    if (id === "telegram-1") return { id, platform: "telegram" };
    return undefined;
  }),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import type { TaskTemplate } from "../../shared/types.js";
import type { TemplateExecutionContext } from "../../scheduler/template-executor.js";
import type { StepResult } from "../../shared/types.js";
import type { TemplateExecutionStepStatus } from "../../store/template-executions.js";
import type { NotifyTarget, TaskConfig } from "../../shared/types.js";

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
  mockRedeliver.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  const template: TaskTemplate = {
    id: `tmpl-${Math.random().toString(36).slice(2)}`,
    name: "Test Template",
    trigger: { type: "manual" },
    steps: [],
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
  getTestDb().prepare(`
    INSERT INTO task_templates (
      id, name, description, trigger_type, trigger_cron, steps, config, enabled,
      created_at, is_preset, preset_id, deliver_to, report_to
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    template.id,
    template.name,
    template.description ?? null,
    template.trigger.type,
    template.trigger.cron ?? null,
    JSON.stringify(template.steps),
    JSON.stringify(template.config ?? {}),
    template.enabled ? 1 : 0,
    template.createdAt,
    0,
    null,
    JSON.stringify(template.deliverTo ?? []),
    JSON.stringify(template.reportTo ?? []),
  );
  return template;
}

function makeExecutionContext(overrides: {
  deliverTo?: NotifyTarget[];
  reportTo?: NotifyTarget[];
  deliveryMessageType?: string;
  executionId?: string;
  templateId?: string;
} = {}): TemplateExecutionContext {
  return {
    templateId: overrides.templateId ?? "tmpl-test",
    templateName: "Test Template",
    template: { id: "tmpl-test", name: "Test Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true } as TaskTemplate,
    executionId: overrides.executionId ?? `exec-${Date.now()}`,
    stepResults: new Map<string, StepResult>(),
    stepStatuses: {} as Record<string, TemplateExecutionStepStatus>,
    config: {} as TaskConfig,
    continueOnError: false,
    failedStepIds: new Set<string>(),
    deliverTo: overrides.deliverTo ?? [],
    reportTo: overrides.reportTo ?? [],
    deliveryMessageType: overrides.deliveryMessageType,
    goalSteps: [],
  } as unknown as TemplateExecutionContext;
}

function makeFileArtifact(executionId: string, stepId: string, key: string, blobPath: string, mime = "text/plain") {
  artifactRows.push({
    id: `art-${Math.random().toString(36).slice(2)}`,
    executionId,
    stepId,
    key,
    kind: "file",
    blobPath,
    mime,
    sizeBytes: 128,
    createdAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("TemplateExecutor artifact aggregation", () => {

  it("3 file artifacts → single redeliverExecutionTo call with 3 fileArtifacts", async () => {
    const execId = `exec-3artifacts-${Date.now()}`;
    const tmpl = makeTemplate();
    const executor = new TemplateExecutor();

    // Seed 3 file artifacts
    makeFileArtifact(execId, "step-1", "report.pdf", "/tmp/fake/report.pdf", "application/pdf");
    makeFileArtifact(execId, "step-2", "data.json", "/tmp/fake/data.json", "application/json");
    makeFileArtifact(execId, "step-3", "chart.png", "/tmp/fake/chart.png", "image/png");

    const context = makeExecutionContext({
      templateId: tmpl.id,
      executionId: execId,
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await executor.deliverTemplateExecutionResult(context, "completed");

    // After Task 4, deliverTo loop calls redeliverExecutionTo (not send())
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const [callArgs] = mockRedeliver.mock.calls[0] as [Parameters<typeof mockRedeliver>[0]];
    expect(callArgs.content).toBeDefined();
    expect(callArgs.fileArtifacts).toBeDefined();
    expect(callArgs.fileArtifacts).toHaveLength(3);
    expect(callArgs.messageType).toBe("result_delivery");
  });

  it("0 file artifacts → redeliverExecutionTo called with empty fileArtifacts", async () => {
    const execId = `exec-noartifacts-${Date.now()}`;
    const tmpl = makeTemplate();
    const executor = new TemplateExecutor();

    // No artifacts — artifactRows stays empty

    const context = makeExecutionContext({
      templateId: tmpl.id,
      executionId: execId,
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await executor.deliverTemplateExecutionResult(context, "completed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const [callArgs] = mockRedeliver.mock.calls[0] as [Parameters<typeof mockRedeliver>[0]];
    // fileArtifacts is either undefined or empty array
    if (callArgs.fileArtifacts !== undefined) {
      expect(callArgs.fileArtifacts).toHaveLength(0);
    }
  });

  it("email channel → existing behavior preserved (redeliverExecutionTo with attachments)", async () => {
    const execId = `exec-email-${Date.now()}`;
    const tmpl = makeTemplate();
    const executor = new TemplateExecutor();

    makeFileArtifact(execId, "step-1", "invoice.pdf", "/tmp/fake/invoice.pdf", "application/pdf");
    makeFileArtifact(execId, "step-1", "receipt.pdf", "/tmp/fake/receipt.pdf", "application/pdf");

    const context = makeExecutionContext({
      templateId: tmpl.id,
      executionId: execId,
      deliverTo: [{ type: "channel", channelId: "email-1", chatId: "client@example.com" }],
    });

    await executor.deliverTemplateExecutionResult(context, "completed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const [callArgs] = mockRedeliver.mock.calls[0] as [Parameters<typeof mockRedeliver>[0]];
    expect(callArgs.fileArtifacts).toBeDefined();
    expect(callArgs.fileArtifacts).toHaveLength(2);
  });

  it("custom deliveryMessageType → redeliverExecutionTo called with translated envelope kind", async () => {
    const execId = `exec-custom-${Date.now()}`;
    const tmpl = makeTemplate();
    const executor = new TemplateExecutor();

    makeFileArtifact(execId, "step-1", "output.csv", "/tmp/fake/output.csv", "text/csv");

    const context = makeExecutionContext({
      templateId: tmpl.id,
      executionId: execId,
      deliverTo: [{ type: "channel", channelId: "telegram-1", chatId: "chat-custom" }],
      deliveryMessageType: "custom_digest",
    });

    await executor.deliverTemplateExecutionResult(context, "completed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const [callArgs] = mockRedeliver.mock.calls[0] as [Parameters<typeof mockRedeliver>[0]];
    // deliveryMessageType "custom_digest" is passed through as-is (string & {} type)
    expect(callArgs.messageType).toBe("custom_digest");
    expect(callArgs.fileArtifacts).toHaveLength(1);
  });

  it("collection manifest renders as a file list and delivers 10 child files", async () => {
    const execId = `exec-collection-${Date.now()}`;
    const tmpl = makeTemplate({
      config: {
        delivery: {
          mode: "primary-artifact",
          primaryArtifact: { stepId: "paint", key: "artworks" },
        },
      },
    });
    const executor = new TemplateExecutor();
    const items = Array.from({ length: 10 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        artifactId: `art-${number}`,
        key: `artwork_${number}_surrealism.png`,
        filename: `artwork_${number}_surrealism.png`,
        mime: "image/png",
        sizeBytes: 100 + index,
        purpose: "media" as const,
      };
    });
    artifactRows.push({
      id: "manifest",
      executionId: execId,
      stepId: "paint",
      key: "artworks",
      kind: "json",
      value: { type: "artifact_collection", outputAs: "artworks", items },
      sizeBytes: 500,
      createdAt: 1,
    });
    for (const item of items) {
      artifactRows.push({
        id: item.artifactId,
        executionId: execId,
        stepId: "paint",
        key: item.key,
        kind: "file",
        blobPath: `/tmp/fake/${item.filename}`,
        mime: item.mime,
        originalFilename: item.filename,
        locator: `local:///tmp/fake/${item.filename}`,
        purpose: item.purpose,
        contentHash: `sha256:${item.key}`,
        sizeBytes: item.sizeBytes,
        createdAt: 2,
      });
    }

    const context = makeExecutionContext({
      templateId: tmpl.id,
      executionId: execId,
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });
    context.template = tmpl;
    context.templateName = tmpl.name;

    await executor.deliverTemplateExecutionResult(context, "completed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const [callArgs] = mockRedeliver.mock.calls[0] as [Parameters<typeof mockRedeliver>[0]];
    expect(callArgs.content).toContain("Artifact collection \"artworks\" (10 files)");
    expect(callArgs.content).toContain("artwork_02_surrealism.png");
    expect(callArgs.fileArtifacts).toHaveLength(10);
    expect(callArgs.fileArtifacts?.map((artifact: { key?: string }) => artifact.key?.replace(/.*\//, ""))).toEqual(
      items.map((item) => item.filename),
    );
  });

});
