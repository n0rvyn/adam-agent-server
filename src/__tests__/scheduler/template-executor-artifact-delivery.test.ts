import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

// All shared state hoisted so vi.mock factory closures can reference them
const { artifactRows, mockGwSend, mockRedeliver } = vi.hoisted(() => {
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

  const mockGwSend = vi.fn().mockResolvedValue({ success: true, logEntryId: "log-1" });
  // Task 4 refactor: deliverTo loop now calls redeliverExecutionTo (not send()).
  // Assert on mockRedeliver, not mockGwSend.
  const mockRedeliver = vi.fn().mockResolvedValue({
    deliveries: [{ target: { channelId: "ch-test", chatId: "chat-test" }, deliveryLogId: "log-1", status: "delivered", attachmentCount: 0 }],
  });

  return { artifactRows, mockGwSend, mockRedeliver };
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
    send: mockGwSend,
    redeliverExecutionTo: mockRedeliver,
  }),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(() => "script body text") };
});

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn(() => artifactRows),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((id: string) => {
    if (id === "mail-1") return { id, platform: "email" };
    if (id === "wechat-1") return { id, platform: "wechat" };
    return undefined;
  }),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { filenameForArtifact } from "../../lib/artifact-attachments.js";
import type { Artifact } from "../../lib/artifact-attachments.js";
import type { TaskTemplate } from "../../shared/types.js";

afterAll(() => cleanup());

describe("TemplateExecutor artifact delivery", () => {
  beforeEach(() => {
    clearTestDb();
    artifactRows.length = 0;
    mockGwSend.mockClear();
    mockGwSend.mockResolvedValue({ success: true, logEntryId: "log-1" });
    mockRedeliver.mockClear();
    mockRedeliver.mockResolvedValue({
      deliveries: [{ target: { channelId: "ch-test", chatId: "chat-test" }, deliveryLogId: "log-1", status: "delivered", attachmentCount: 0 }],
    });
  });

  function makeTemplate(overrides: Partial<TaskTemplate>): TaskTemplate {
    const template: TaskTemplate = {
      id: `tmpl-${Math.random().toString(36).slice(2)}`,
      name: "Artifact Template",
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
      template.config ? JSON.stringify(template.config) : null,
      template.enabled ? 1 : 0,
      template.createdAt ?? Date.now(),
      template.isPreset ? 1 : 0,
      template.presetId ?? null,
      template.deliverTo ? JSON.stringify(template.deliverTo) : null,
      template.reportTo ? JSON.stringify(template.reportTo) : null,
    );
    return template;
  }

  // Phase 4: deliverTo loop now calls redeliverExecutionTo for all channel types
  it("sends one email delivery with all file artifacts as attachments", async () => {
    artifactRows.push(
      { id: "a1", executionId: "exec-email", stepId: "write", key: "report", kind: "file", blobPath: "/tmp/report.md", mime: "text/markdown", sizeBytes: 10, createdAt: 1 },
      { id: "a2", executionId: "exec-email", stepId: "audio", key: "podcast.mp3", kind: "file", blobPath: "/tmp/podcast-source.mp3", mime: "audio/mpeg", sizeBytes: 20, createdAt: 2 },
    );
    const template = makeTemplate({
      deliverTo: [{ type: "channel", channelId: "mail-1", chatId: "client@example.com" }],
    });

    const executor = new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 });
    await executor.execute(template, "exec-email");

    // Phase 4: deliverTo uses redeliverExecutionTo
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    expect(mockRedeliver).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ channelId: "mail-1", chatId: "client@example.com" }],
      messageType: "result_delivery",
      fileArtifacts: expect.arrayContaining([
        expect.objectContaining({ id: "a1", key: "report", mime: "text/markdown" }),
        expect.objectContaining({ id: "a2", key: "podcast.mp3", mime: "audio/mpeg" }),
      ]),
    }));
  });

  it("passes artifact ledger metadata through outbound attachments", async () => {
    artifactRows.push({
      id: "artifact-meta",
      executionId: "exec-meta",
      stepId: "audio",
      key: "podcast",
      kind: "file",
      blobPath: "/tmp/podcast-source.mp3",
      mime: "audio/mpeg",
      originalFilename: "podcast-original.mp3",
      locator: "local:///tmp/podcast-source.mp3",
      purpose: "media",
      contentHash: "sha256:podcast",
      sizeBytes: 20,
      createdAt: 2,
    });
    const template = makeTemplate({
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-meta");

    expect(mockRedeliver).toHaveBeenCalledWith(expect.objectContaining({
      fileArtifacts: expect.arrayContaining([
        expect.objectContaining({
          id: "artifact-meta",
          locator: "local:///tmp/podcast-source.mp3",
          originalFilename: "podcast-original.mp3",
          mime: "audio/mpeg",
          sizeBytes: 20,
          purpose: "media",
          contentHash: "sha256:podcast",
        }),
      ]),
    }));
  });

  // Phase 4 (D-002): non-email channels bundle summary + all artifacts into ONE sendViaGateway call
  it("non-email channel sends one aggregated call with summary and all file artifacts bundled", async () => {
    artifactRows.push(
      { id: "a1", executionId: "exec-wechat", stepId: "write", key: "report", kind: "file", blobPath: "/tmp/report.md", mime: "text/markdown", sizeBytes: 10, createdAt: 1 },
      { id: "a2", executionId: "exec-wechat", stepId: "audio", key: "podcast", kind: "file", blobPath: "/tmp/podcast-source.mp3", mime: "audio/mpeg", sizeBytes: 20, createdAt: 2 },
    );
    const template = makeTemplate({
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-wechat");

    // Phase 4: one call via redeliverExecutionTo
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    expect(mockRedeliver).toHaveBeenCalledWith(expect.objectContaining({
      messageType: "result_delivery",
      fileArtifacts: expect.arrayContaining([
        expect.objectContaining({ id: "a1", mime: "text/markdown" }),
        expect.objectContaining({ id: "a2", mime: "audio/mpeg" }),
      ]),
    }));
  });

  it("delivers collection manifest children as outbound attachments with preserved filenames", async () => {
    const items = Array.from({ length: 10 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        artifactId: `picasso-${number}`,
        key: `artwork_${number}_surrealism.png`,
        filename: `artwork_${number}_surrealism.png`,
        mime: "image/png",
        sizeBytes: 100 + index,
        purpose: "media" as const,
      };
    });
    artifactRows.push({
      id: "manifest",
      executionId: "exec-picasso",
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
        executionId: "exec-picasso",
        stepId: "paint",
        key: item.key,
        kind: "file",
        blobPath: `/tmp/${item.filename}`,
        mime: item.mime,
        originalFilename: item.filename,
        locator: `local:///tmp/${item.filename}`,
        purpose: item.purpose,
        contentHash: `sha256:${item.key}`,
        sizeBytes: item.sizeBytes,
        createdAt: 2,
      });
    }
    const template = makeTemplate({
      config: {
        delivery: {
          mode: "primary-artifact",
          primaryArtifact: { stepId: "paint", key: "artworks" },
        },
      },
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-picasso");

    const deliverCall = mockRedeliver.mock.calls[0][0] as { content: string; fileArtifacts?: Array<Record<string, unknown>> };
    expect(deliverCall.content).toContain("Artifact collection \"artworks\" (10 files)");
    expect((deliverCall.fileArtifacts ?? [])).toHaveLength(10);
    expect((deliverCall.fileArtifacts ?? [])[1]).toEqual(expect.objectContaining({
      id: "picasso-02",
      key: "artwork_02_surrealism.png",
      mime: "image/png",
      sizeBytes: 101,
    }));
  });

  // Phase 4: gateway failure still tracked — but now as a single call
  it("gateway success=false on single aggregated call — tracked but no partial sends", async () => {
    artifactRows.push(
      { id: "good", executionId: "exec-fail", stepId: "b", key: "good", kind: "file", blobPath: "/tmp/good.mp3", mime: "audio/mpeg", sizeBytes: 20, createdAt: 2 },
    );
    mockRedeliver.mockResolvedValueOnce({
      deliveries: [{ target: { channelId: "wechat-1", chatId: "chat-1" }, deliveryLogId: "fail-log", status: "failed", error: "channel offline", attachmentCount: 0 }],
    });
    const template = makeTemplate({
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-fail");

    // Phase 4: only one call (no partial artifact sends)
    expect(mockRedeliver).toHaveBeenCalledTimes(1);
  });

  it("failed execution sends root failure report instead of resolving success primary artifact", async () => {
    const template = makeTemplate({
      config: {
        delivery: {
          mode: "primary-artifact",
          primaryArtifact: { stepId: "polish", key: "最终逐字稿" },
        },
      },
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });
    const context = {
      templateId: template.id,
      templateName: template.name,
      template,
      executionId: "exec-root-failure",
      stepResults: new Map([
        ["write", {
          stepId: "write",
          taskId: "task-write-retry",
          status: "failed",
          error: "契约校验失败（length retry）：actual 2111 characters / target 2200-2800 characters",
        }],
      ]),
      stepStatuses: {},
      config: {},
      continueOnError: false,
      failedStepIds: new Set(["write"]),
      deliverTo: template.deliverTo,
      reportTo: [],
      goalSteps: [],
    };

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).deliverTemplateExecutionResult(context as any, "failed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    expect(mockRedeliver).toHaveBeenCalledWith(expect.objectContaining({
      targets: [{ channelId: "wechat-1", chatId: "chat-1" }],
      messageType: "report",
      fileArtifacts: [],
      content: expect.stringContaining("length retry"),
    }));
  });

  // ===== Task 2-tests: Failure-path attachments regression tests =====

  it("failure + primary-artifact mode + multiple completed-step file artifacts → all attached, not just primary", async () => {
    // Case A: execution failed but two steps published artifacts — failure delivery must
    // attach ALL completed file artifacts, not just the primary one. messageType=result_delivery
    // because tryAssembleFallbackDelivery succeeds (primary artifact exists).
    const execId = "exec-failure-multi-art";
    artifactRows.push(
      // stepA (primary): file artifact with text/markdown — readFileSync is mocked above
      { id: "fa-stepA", executionId: execId, stepId: "stepA", key: "script.md", kind: "file", blobPath: "/tmp/script.md", mime: "text/markdown", sizeBytes: 16, createdAt: 1 },
      // stepB: audio mp3 — also successfully published (kind=file so getDeliverableFileArtifacts picks it up)
      { id: "fa-stepB", executionId: execId, stepId: "stepB", key: "audio", kind: "file", blobPath: "/tmp/podcast.mp3", mime: "audio/mpeg", sizeBytes: 2000, createdAt: 2 },
      // stepC: no artifact (failed step — not in artifactRows)
    );

    const template = makeTemplate({
      config: {
        delivery: {
          mode: "primary-artifact",
          primaryArtifact: { stepId: "stepA", key: "script.md" },
        },
      },
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    const context = {
      templateId: template.id,
      templateName: template.name,
      template,
      executionId: execId,
      stepResults: new Map([
        ["stepA", { stepId: "stepA", taskId: "task-A", status: "completed", result: "script content" }],
        ["stepB", { stepId: "stepB", taskId: "task-B", status: "completed", result: "audio produced" }],
        ["stepC", { stepId: "stepC", taskId: "task-C", status: "failed", error: "step C failed" }],
      ]),
      stepStatuses: {},
      config: {},
      continueOnError: true,
      failedStepIds: new Set(["stepC"]),
      deliverTo: template.deliverTo,
      reportTo: [],
      goalSteps: [],
    };

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).deliverTemplateExecutionResult(context as any, "failed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const callArgs = mockRedeliver.mock.calls[0][0] as { fileArtifacts: Array<{ id: string; mime: string }>; messageType: string };
    // Post-fix: BOTH stepA's markdown AND stepB's audio must be attached.
    // Strict length=2 locks the dedupe-by-id invariant (review-execution nice-to-have #7):
    // primary artifact appears in BOTH getDeliverableFileArtifacts(...) AND
    // fallback.fileArtifacts. The merge code de-dupes by artifact.id so the result is exactly
    // 2, not 3. If dedupe were removed, length would be 3 and this assertion would fail.
    expect(callArgs.fileArtifacts).toHaveLength(2);
    expect(callArgs.fileArtifacts.filter((a) => a.id === "fa-stepA")).toHaveLength(1);
    expect(callArgs.fileArtifacts.some((a) => a.id === "fa-stepA")).toBe(true);
    expect(callArgs.fileArtifacts.some((a) => a.id === "fa-stepB" && a.mime === "audio/mpeg")).toBe(true);
    // tryAssembleFallbackDelivery succeeded (primary artifact found) → usedFallbackDelivery=true → result_delivery
    expect(callArgs.messageType).toBe("result_delivery");
  });

  it("failure + concat-step-results mode + partial artifacts → attachments retained, messageType=report", async () => {
    // Case B: execution failed in concat-step-results mode. tryAssembleFallbackDelivery returns null.
    // fileArtifacts must still contain stepB's audio (Fix B). messageType=report (no fallback summary).
    const execId = "exec-failure-concat";
    artifactRows.push(
      // stepB: audio mp3 — successfully published
      { id: "fb-stepB", executionId: execId, stepId: "stepB", key: "audio", kind: "file", blobPath: "/tmp/podcast2.mp3", mime: "audio/mpeg", sizeBytes: 1500, createdAt: 2 },
      // stepC: no artifact (failed)
    );

    const template = makeTemplate({
      // default mode = concat-step-results (no explicit delivery config)
      deliverTo: [{ type: "channel", channelId: "wechat-1", chatId: "chat-1" }],
    });

    const context = {
      templateId: template.id,
      templateName: template.name,
      template,
      executionId: execId,
      stepResults: new Map([
        ["stepA", { stepId: "stepA", taskId: "task-A", status: "completed", result: "text result" }],
        ["stepB", { stepId: "stepB", taskId: "task-B", status: "completed", result: "audio produced" }],
        ["stepC", { stepId: "stepC", taskId: "task-C", status: "failed", error: "step C failed" }],
      ]),
      stepStatuses: {},
      config: {},
      continueOnError: true,
      failedStepIds: new Set(["stepC"]),
      deliverTo: template.deliverTo,
      reportTo: [],
      goalSteps: [],
    };

    await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).deliverTemplateExecutionResult(context as any, "failed");

    expect(mockRedeliver).toHaveBeenCalledTimes(1);
    const callArgs = mockRedeliver.mock.calls[0][0] as { fileArtifacts: Array<{ id: string; mime: string }>; messageType: string };
    // Post-fix: stepB's audio must be attached despite failure
    expect(callArgs.fileArtifacts.length).toBe(1);
    expect(callArgs.fileArtifacts[0].id).toBe("fb-stepB");
    expect(callArgs.fileArtifacts[0].mime).toBe("audio/mpeg");
    // concat-step-results + no fallback → messageType=report
    expect(callArgs.messageType).toBe("report");
  });

  it("derives artifact filenames from key, mime, and originalFilename", () => {
    // filenameForArtifact moved to shared module (Task 3) — requires full Artifact
    function makeArtifact(overrides: Partial<{ id: string; key: string; mime: string; originalFilename: string; blobPath: string | undefined }>) {
      return { id: "art-1", executionId: "exec-1", stepId: "s1", kind: "file" as const, sizeBytes: 100, createdAt: Date.now(), ...overrides } as unknown as Artifact;
    }
    // (b) key with extension wins — even when blobPath suggests another ext
    expect(filenameForArtifact(makeArtifact({ id: "id-1", key: "custom.md", blobPath: "/tmp/source.txt" }))).toBe("custom.md");
    // (c) mime-derived extension when key has no ext (per Task 6 new behavior)
    expect(filenameForArtifact(makeArtifact({ id: "id-2", key: "custom", mime: "audio/mpeg", blobPath: "/tmp/source.mp3" }))).toBe("custom.mp3");
    // (e) plain key when no mime info — no extension is better than wrong .bin
    expect(filenameForArtifact(makeArtifact({ id: "id-2b", key: "custom", blobPath: "/tmp/source.bin" }))).toBe("custom");
    // (a) originalFilename with extension wins above key+mime
    expect(filenameForArtifact(makeArtifact({ id: "id-2c", key: "custom", mime: "audio/mpeg", originalFilename: "podcast.mp3", blobPath: "/tmp/x.bin" }))).toBe("podcast.mp3");
    // (f) blob basename fallback when key empty and blobPath present
    expect(filenameForArtifact(makeArtifact({ id: "id-3", key: "", blobPath: undefined }))).toBe("id-3");
  });
});
