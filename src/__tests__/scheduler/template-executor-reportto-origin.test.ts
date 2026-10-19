import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

const { mockGwSend, mockCreateTaskWithAdmission, mockGetChannel } = vi.hoisted(() => ({
  mockGwSend: vi.fn(async (_options: unknown): Promise<{ success: boolean; logEntryId: string; error?: string }> => ({ success: true, logEntryId: "log-1" })),
  mockCreateTaskWithAdmission: vi.fn(),
  mockGetChannel: vi.fn((id: string): any => ({ id, platform: "wechat", config: { userId: "default-chat" } })),
}));

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../config/index.js", () => ({
  getDefaults: () => ({
    timeout: 600,
    maxTurns: 100,
    maxBudgetUsd: 5,
    effort: "high" as const,
    model: "claude-sonnet-4-6",
    settingSources: ["project"],
    approvalRequired: [],
    approvalTimeout: 300,
    env: {},
  }),
  getChatConfig: () => ({ sessionTimeoutMinutes: 60, maxSessionTurns: 200, autoTitle: false, archiveExtractMemory: false }),
}));

vi.mock("../../delivery/outbound-gateway.js", () => ({
  getOutboundGateway: () => ({
    send: mockGwSend,
    redeliverExecutionTo: async (args: {
      executionId: string;
      targets: Array<{ channelId: string; chatId?: string }>;
      content: string;
      messageType?: string;
      fileArtifacts?: Array<Record<string, unknown>>;
      actorToolName?: string;
      sessionId?: string;
    }) => {
      // Fan out to mockGwSend per target so existing test assertions on send() shape still hold.
      const attachments = (args.fileArtifacts ?? []).map((a) => ({
        path: a.blobPath,
        mediaType: typeof a.mime === "string" && a.mime.startsWith("audio/") ? "audio"
          : typeof a.mime === "string" && a.mime.startsWith("video/") ? "video"
          : typeof a.mime === "string" && a.mime.startsWith("image/") ? "image"
          : "file",
        filename: a.originalFilename ?? a.key,
        contentType: a.mime,
        mimeType: a.mime,
        artifactId: a.id,
        sizeBytes: a.sizeBytes,
      }));
      const deliveries: Array<{ target: { channelId: string; chatId?: string }; deliveryLogId: string; status: "delivered" | "failed"; attachmentCount: number; error?: string }> = [];
      for (const t of args.targets) {
        const result = await mockGwSend({
          taskId: args.executionId,
          sessionId: args.sessionId,
          channelId: t.channelId,
          chatId: t.chatId,
          content: args.content,
          messageType: args.messageType ?? "result_delivery",
          attachments: attachments.length > 0 ? attachments : undefined,
          actorToolName: args.actorToolName,
        });
        deliveries.push({
          target: { channelId: t.channelId, chatId: t.chatId },
          deliveryLogId: result.logEntryId,
          status: result.success ? "delivered" : "failed",
          attachmentCount: attachments.length,
          ...(result.error ? { error: result.error } : {}),
        });
      }
      return { deliveries };
    },
  }),
}));

vi.mock("../../lib/task-dispatch.js", () => ({
  createTaskWithAdmission: (...args: unknown[]) => mockCreateTaskWithAdmission(...args),
}));

vi.mock("../../lib/artifact-storage.js", () => ({
  ensureArtifactsDir: vi.fn(),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: (id: string) => mockGetChannel(id),
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

import { createSession, _resetForTest } from "../../chat/session-manager.js";
import { TemplateExecutor } from "../../scheduler/template-executor.js";
import { getMessagesBySession } from "../../store/messages.js";
import { createTask } from "../../store/tasks.js";
import { createArtifact } from "../../store/artifacts.js";
import { getTemplateExecution } from "../../store/template-executions.js";
import type { CreateTaskInput } from "../../lib/task-dispatch.js";
import type { TaskTemplate } from "../../shared/types.js";

describe("TemplateExecutor reportTo origin fallback", () => {
  afterAll(() => cleanup());

  beforeEach(() => {
    clearTestDb();
    _resetForTest();
    mockGwSend.mockClear();
    mockGwSend.mockResolvedValue({ success: true, logEntryId: "log-1" });
    mockCreateTaskWithAdmission.mockReset();
    mockGetChannel.mockReset();
    mockGetChannel.mockImplementation((id: string) => ({ id, platform: "wechat", config: { userId: "default-chat" } }));
  });

  function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
    const template: TaskTemplate = {
      id: `tmpl-${Math.random().toString(36).slice(2)}`,
      name: "Origin Report Template",
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

  it("uses channel origin as reportTo when the template has no explicit reportTo", async () => {
    const template = makeTemplate();

    await new TemplateExecutor().execute(template, "exec-channel-origin", {
      originReportTo: [{ type: "channel", channelId: "ch-origin", chatId: "chat-origin" }],
    });

    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "exec-channel-origin",
      channelId: "ch-origin",
      chatId: "chat-origin",
      messageType: "report",
      content: expect.stringContaining("Origin Report Template"),
    }));
    const firstCall = mockGwSend.mock.calls[0] as [Record<string, unknown>] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall![0].content).not.toContain("TemplateExecution completed");
  });

  it("writes web origin report to the originating chat session", async () => {
    const session = createSession({ type: "web" });
    const template = makeTemplate();

    await new TemplateExecutor().execute(template, "exec-session-origin", {
      originReportTo: [{ type: "session", sessionId: session.id }],
    });

    const messages = getMessagesBySession(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: "assistant",
      taskId: "exec-session-origin",
      content: expect.stringContaining("Origin Report Template"),
    }));
  });

  it("explicit reportTo wins over origin fallback", async () => {
    const template = makeTemplate({
      reportTo: [{ type: "channel", channelId: "ch-explicit", chatId: "chat-explicit" }],
    });

    await new TemplateExecutor().execute(template, "exec-explicit-origin", {
      originReportTo: [{ type: "channel", channelId: "ch-origin", chatId: "chat-origin" }],
    });

    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "ch-explicit",
      chatId: "chat-explicit",
      messageType: "report",
    }));
    expect(mockGwSend).not.toHaveBeenCalledWith(expect.objectContaining({ channelId: "ch-origin" }));
  });

  it("does not send a report when neither explicit reportTo nor origin fallback exists", async () => {
    const template = makeTemplate();

    await new TemplateExecutor().execute(template, "exec-no-origin");

    expect(mockGwSend).not.toHaveBeenCalled();
  });

  it("sends channel origin report when a step fails before the normal completion path", async () => {
    const template = makeTemplate({
      steps: [{ id: "fail-step", prompt: "Fail this step" }],
    });
    mockCreateTaskWithAdmission.mockImplementation(async (input: CreateTaskInput) => {
      const taskId = `task-${input.stepId}`;
      createTask({
        id: taskId,
        parentId: input.parentId,
        templateId: input.templateId,
        stepId: input.stepId,
        roleId: input.roleId,
        status: "failed",
        prompt: input.prompt,
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        error: "boom",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      return {
        ok: true,
        taskId,
        roleId: input.roleId ?? "role-test",
        requirements: input.requirements ?? {},
        fitScore: 1,
        candidates: [],
        warnings: [],
      };
    });

    const result = await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-failed-channel", {
      originReportTo: [{ type: "channel", channelId: "ch-origin", chatId: "chat-origin" }],
    });

    expect(result.status).toBe("failed");
    expect(getTemplateExecution("exec-failed-channel")?.status).toBe("failed");
    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "exec-failed-channel",
      messageType: "report",
      channelId: "ch-origin",
      chatId: "chat-origin",
      content: expect.stringContaining("failed"),
    }));
  });

  it("writes failed origin report to the originating chat session", async () => {
    const session = createSession({ type: "web" });
    const template = makeTemplate({
      steps: [{ id: "fail-step", prompt: "Fail this step" }],
    });
    mockCreateTaskWithAdmission.mockImplementation(async (input: CreateTaskInput) => {
      const taskId = `task-${input.stepId}`;
      createTask({
        id: taskId,
        parentId: input.parentId,
        templateId: input.templateId,
        stepId: input.stepId,
        roleId: input.roleId,
        status: "failed",
        prompt: input.prompt,
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        error: "boom",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      return {
        ok: true,
        taskId,
        roleId: input.roleId ?? "role-test",
        requirements: input.requirements ?? {},
        fitScore: 1,
        candidates: [],
        warnings: [],
      };
    });

    const result = await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-failed-session", {
      originReportTo: [{ type: "session", sessionId: session.id }],
    });

    expect(result.status).toBe("failed");
    expect(getTemplateExecution("exec-failed-session")?.status).toBe("failed");
    const messages = getMessagesBySession(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      role: "assistant",
      taskId: "exec-failed-session",
      content: expect.stringContaining("failed"),
    }));
  });

  it("sends channel origin report when cancellation is observed at the layer checkpoint", async () => {
    const template = makeTemplate({
      steps: [{ id: "cancel-step", prompt: "Cancel this step" }],
    });
    mockCreateTaskWithAdmission.mockImplementation(async (input: CreateTaskInput) => {
      const taskId = `task-${input.stepId}`;
      createTask({
        id: taskId,
        parentId: input.parentId,
        templateId: input.templateId,
        stepId: input.stepId,
        roleId: input.roleId,
        status: "cancelled",
        prompt: input.prompt,
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      getTestDb().prepare("UPDATE template_executions SET status = ?, completed_at = ? WHERE id = ?")
        .run("cancelled", Date.now(), input.parentId);
      return {
        ok: true,
        taskId,
        roleId: input.roleId ?? "role-test",
        requirements: input.requirements ?? {},
        fitScore: 1,
        candidates: [],
        warnings: [],
      };
    });

    const result = await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-cancelled-channel", {
      originReportTo: [{ type: "channel", channelId: "ch-origin", chatId: "chat-origin" }],
    });

    expect(result.status).toBe("cancelled");
    expect(getTemplateExecution("exec-cancelled-channel")?.status).toBe("cancelled");
    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "exec-cancelled-channel",
      messageType: "report",
      channelId: "ch-origin",
      chatId: "chat-origin",
      content: expect.stringContaining("cancelled"),
    }));
  });

  it("keeps failed terminal state when report delivery returns a failed Gateway result", async () => {
    const template = makeTemplate({
      steps: [{ id: "fail-step", prompt: "Fail this step" }],
    });
    mockGwSend.mockResolvedValueOnce({ success: false, logEntryId: "log-report", error: "adapter down" });
    mockCreateTaskWithAdmission.mockImplementation(async (input: CreateTaskInput) => {
      const taskId = `task-${input.stepId}`;
      createTask({
        id: taskId,
        parentId: input.parentId,
        templateId: input.templateId,
        stepId: input.stepId,
        roleId: input.roleId,
        status: "failed",
        prompt: input.prompt,
        config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
        error: "boom",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      return {
        ok: true,
        taskId,
        roleId: input.roleId ?? "role-test",
        requirements: input.requirements ?? {},
        fitScore: 1,
        candidates: [],
        warnings: [],
      };
    });

    const result = await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-report-failure", {
      originReportTo: [{ type: "channel", channelId: "ch-origin", chatId: "chat-origin" }],
    });

    expect(result.status).toBe("failed");
    expect(getTemplateExecution("exec-report-failure")?.status).toBe("failed");
  });

  it("delivers configured primary artifact as partial result on failed execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "adam-fallback-artifact-"));
    const primaryPath = join(tempDir, "final-script.md");
    const otherPath = join(tempDir, "other.md");
    writeFileSync(primaryPath, "SCRIPT BODY");
    writeFileSync(otherPath, "OTHER BODY");
    try {
      const template = makeTemplate({
        steps: [
          { id: "script", prompt: "Write script", outputAs: "final-script" },
          { id: "audio", prompt: "Make audio", dependsOn: ["script"] },
        ],
        config: {
          delivery: { mode: "primary-artifact", primaryArtifact: { stepId: "script" } },
        },
        deliverTo: [{ type: "channel", channelId: "ch-deliver", chatId: "chat-deliver" }],
        reportTo: [{ type: "channel", channelId: "ch-report", chatId: "chat-report" }],
      });

      mockCreateTaskWithAdmission.mockImplementation(async (input: CreateTaskInput) => {
        const taskId = `task-${input.stepId}`;
        if (input.stepId === "script") {
          createTask({
            id: taskId,
            parentId: input.parentId,
            templateId: input.templateId,
            stepId: input.stepId,
            roleId: input.roleId,
            status: "completed",
            prompt: input.prompt,
            config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
            result: "script done",
            createdAt: Date.now(),
            completedAt: Date.now(),
          });
          createArtifact({
            id: "artifact-primary",
            sourceKind: "template_step",
            roleId: "role-test",
            executionId: input.parentId!,
            stepId: "script",
            key: "final-script",
            kind: "file",
            blobPath: primaryPath,
            mime: "text/markdown",
            originalFilename: "final-script.md",
            sizeBytes: 11,
            createdAt: Date.now(),
          });
          createArtifact({
            id: "artifact-other",
            sourceKind: "template_step",
            roleId: "role-test",
            executionId: input.parentId!,
            stepId: "script",
            key: "other",
            kind: "file",
            blobPath: otherPath,
            mime: "text/markdown",
            originalFilename: "other.md",
            sizeBytes: 10,
            createdAt: Date.now() + 1,
          });
        } else {
          createTask({
            id: taskId,
            parentId: input.parentId,
            templateId: input.templateId,
            stepId: input.stepId,
            roleId: input.roleId,
            status: "failed",
            prompt: input.prompt,
            config: { timeout: 600, approvalRequired: [], approvalTimeout: 300 },
            error: "audio quota",
            createdAt: Date.now(),
            completedAt: Date.now(),
          });
        }
        return {
          ok: true,
          taskId,
          roleId: input.roleId ?? "role-test",
          requirements: input.requirements ?? {},
          fitScore: 1,
          candidates: [],
          warnings: [],
        };
      });

      const result = await new TemplateExecutor({ maxRetries: 1, baseDelayMs: 1 }).execute(template, "exec-fallback-artifact");

      expect(result.status).toBe("failed");
      // Fix B (2026-05-18 plan): on failure-path delivery, ALL successfully-published
      // file artifacts are attached, not just the primary one. The "other" artifact
      // belongs to the same completed step (script) and must travel with the primary.
      // The failed step (audio) published nothing, so only primary + other are sent.
      expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "exec-fallback-artifact",
        channelId: "ch-deliver",
        chatId: "chat-deliver",
        messageType: "result_delivery",
        content: expect.stringContaining("SCRIPT BODY"),
        attachments: expect.arrayContaining([
          expect.objectContaining({ path: primaryPath, filename: "final-script.md" }),
          expect.objectContaining({ path: otherPath, filename: "other.md" }),
        ]),
      }));
      expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
        taskId: "exec-fallback-artifact",
        channelId: "ch-report",
        chatId: "chat-report",
        messageType: "report",
        content: expect.stringContaining("failed"),
      }));
      const deliverCall = mockGwSend.mock.calls.find((call) => (call[0] as { channelId?: string }).channelId === "ch-deliver");
      const deliveredPaths = (deliverCall?.[0] as { attachments?: Array<{ path: string }> }).attachments?.map((a) => a.path).sort();
      expect(deliveredPaths).toEqual([primaryPath, otherPath].sort());
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves email channel report target when chatId is omitted", async () => {
    mockGetChannel.mockImplementation((id: string) => ({
      id,
      platform: "email",
      config: { address: "Client@Example.com" },
    }));
    const template = makeTemplate({
      reportTo: [{ type: "channel", channelId: "mail-origin" }],
    });

    await new TemplateExecutor().execute(template, "exec-email-resolved");

    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "exec-email-resolved",
      channelId: "mail-origin",
      chatId: "client@example.com",
      messageType: "report",
    }));
  });

  it("resolves WeChat channel report target to config userId when chatId is omitted and no session exists", async () => {
    mockGetChannel.mockImplementation((id: string) => ({
      id,
      platform: "wechat",
      config: { userId: "wechat-user-1" },
    }));
    const template = makeTemplate({
      reportTo: [{ type: "channel", channelId: "wechat-origin" }],
    });

    await new TemplateExecutor().execute(template, "exec-wechat-resolved");

    expect(mockGwSend).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "exec-wechat-resolved",
      channelId: "wechat-origin",
      chatId: "wechat-user-1",
      messageType: "report",
    }));
  });

  it("skips channel report target when no chatId can be resolved", async () => {
    mockGetChannel.mockImplementation((id: string) => ({
      id,
      platform: "telegram",
      config: {},
    }));
    const template = makeTemplate({
      reportTo: [{ type: "channel", channelId: "telegram-origin" }],
    });

    await new TemplateExecutor().execute(template, "exec-unresolved-channel");

    expect(mockGwSend).not.toHaveBeenCalled();
  });
});
