/**
 * Unit tests for dispatch_outbound_batch MCP tool.
 *
 * Uses vi.hoisted() for mock data so vi.mock is processed BEFORE any imports
 * (vitest hoists vi.mock to the top of the module, but vi.hoisted() ensures
 * shared state is available at that hoisting point).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

// Shared test data — hoisted so vi.mock can reference it
const { channelRows, mockSendMessage, executionRows, templateRows, taskRows, artifactRows, emittedEvents } = vi.hoisted(() => {
  const channelRows = new Map<string, Record<string, unknown>>();
  const mockSendMessage = vi.fn();
  const executionRows: Array<Record<string, unknown>> = [];
  const templateRows: Array<Record<string, unknown>> = [];
  const taskRows: Array<Record<string, unknown>> = [];
  const artifactRows: Array<Record<string, unknown>> = [];
  const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
  return { channelRows, mockSendMessage, executionRows, templateRows, taskRows, artifactRows, emittedEvents };
});

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string, platform: string) => `[${platform}] ${content}`),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => channelRows.get(channelId) as unknown),
  listChannels: vi.fn(() => [...channelRows.values()] as unknown),
  // Return a large cap so packing never drops artifacts in existing outbound-batch tests
  getRecipientCap: vi.fn(() => 209_715_200),
}));

vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn((id: string) => executionRows.find((r) => r.id === id) as unknown),
}));

vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn((id: string) => templateRows.find((r) => r.id === id) as unknown),
}));

vi.mock("../../store/tasks.js", () => ({
  getTask: vi.fn((id: string) => taskRows.find((r) => r.id === id) as unknown),
}));

vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((id: string) => artifactRows.filter((r) => r.executionId === id) as unknown),
}));

const { cleanup } = setupTestDb();

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  emittedEvents.length = 0;
  channelRows.clear();
  executionRows.length = 0;
  templateRows.length = 0;
  taskRows.length = 0;
  artifactRows.length = 0;
  mockSendMessage.mockReset().mockResolvedValue("msg-redelivery-1");

  channelRows.set("ch-A", { id: "ch-A", name: "Channel A", platform: "email", config: {}, viewerKey: "owner", status: "connected" });
  channelRows.set("ch-B", { id: "ch-B", name: "Channel B", platform: "email", config: {}, viewerKey: "owner", status: "connected" });

  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
  _resetChannelManagerModuleCache();
});

import { buildTools } from "../../manager/adam-tools.js";
import type { AdamToolsRuntimeContext } from "../../manager/adam-tools.js";
import { withNewTrace } from "../../lib/trace-context.js";
import { listReceiptsByTask } from "../../store/effect-receipts.js";
import { getOutboundGateway, _resetChannelManagerModuleCache } from "../../delivery/outbound-gateway.js";

function buildDefaultRuntimeContext(): AdamToolsRuntimeContext {
  return {
    getActiveChatOrigin: () => ({
      source: { type: "channel" as const, channelId: "ch-A" },
      chatSessionId: "session-A",
    }),
  };
}

function parseResult(result: unknown) {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("dispatch_outbound_batch", () => {

  it("source=execution, success, 3 artifacts", async () => {
    executionRows.push({
      id: "exec-3arts",
      templateId: "tmpl-3arts",
      stepResultsJson: JSON.stringify([
        ["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Result A", roleName: "RoleA" }],
        ["s2", { stepId: "s2", taskId: "t2", status: "completed", result: "Result B", roleName: "RoleB" }],
      ]),
    });
    templateRows.push({ id: "tmpl-3arts", name: "3-Artifact Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });
    artifactRows.push(
      { id: "art-a", executionId: "exec-3arts", stepId: "s1", key: "file1", kind: "file", blobPath: "/tmp/f1.txt", mime: "text/plain", sizeBytes: 100, createdAt: Date.now() },
      { id: "art-b", executionId: "exec-3arts", stepId: "s1", key: "file2", kind: "file", blobPath: "/tmp/f2.txt", mime: "text/plain", sizeBytes: 200, createdAt: Date.now() },
      { id: "art-c", executionId: "exec-3arts", stepId: "s2", key: "file3", kind: "file", blobPath: "/tmp/f3.txt", mime: "text/plain", sizeBytes: 300, createdAt: Date.now() },
    );

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { inputParser: (args: unknown) => unknown; handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-3arts" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.executionId).toBe("exec-3arts");
      expect(parsed.attachmentCount).toBe(3);
      expect(parsed.deliveries).toHaveLength(1);
      expect(parsed.deliveries[0].status).toBe("delivered");
      expect(parsed.deliveries[0].attachmentCount).toBe(3);
    });
  });

  it("source=task, success", async () => {
    taskRows.push({ id: "task-to-exec", status: "completed" });
    executionRows.push({
      id: "task-to-exec",
      templateId: "tmpl-task",
      stepResultsJson: JSON.stringify([
        ["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Task result" }],
      ]),
    });
    templateRows.push({ id: "tmpl-task", name: "Task Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "task", id: "task-to-exec" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.executionId).toBe("task-to-exec");
      expect(parsed.deliveries).toHaveLength(1);
      expect(parsed.deliveries[0].status).toBe("delivered");
    });
  });

  it("execution not found", async () => {
    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "nonexistent" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.error).toContain("Execution not found");
    });
  });

  it("task without execution", async () => {
    taskRows.push({ id: "task-no-exec", status: "completed" });
    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "task", id: "task-no-exec" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.error).toContain("no associated TemplateExecution");
    });
  });

  it("viewerKey mismatch denied", async () => {
    channelRows.set("ch-B", { id: "ch-B", name: "Channel B", platform: "email", config: {}, viewerKey: "other-owner", status: "connected" });

    executionRows.push({
      id: "exec-viewerkey",
      templateId: "tmpl-vk",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "vk test" }]]),
    });
    templateRows.push({ id: "tmpl-vk", name: "VK Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-viewerkey" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }, { channelId: "ch-B", chatId: "chat-B1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.deliveries).toHaveLength(1);
      expect(parsed.deliveries[0].target.channelId).toBe("ch-A");
      expect(parsed.skippedTargets).toBeDefined();
      expect(parsed.skippedTargets ?? []).toHaveLength(1);
      expect((parsed.skippedTargets ?? [])[0].channelId).toBe("ch-B");
      expect((parsed.skippedTargets ?? [])[0].error).toContain("viewerKey");
    });
  });

  it("viewerKey match permitted", async () => {
    executionRows.push({
      id: "exec-vk-match",
      templateId: "tmpl-vk-match",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "vk match test" }]]),
    });
    templateRows.push({ id: "tmpl-vk-match", name: "VK Match", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-vk-match" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }, { channelId: "ch-B", chatId: "chat-B1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.deliveries).toHaveLength(2);
      expect(parsed.skippedTargets ?? []).toHaveLength(0);
    });
  });

  it("No persisted step results", async () => {
    executionRows.push({ id: "exec-no-json", templateId: "tmpl-no-json" });
    templateRows.push({ id: "tmpl-no-json", name: "No JSON", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-no-json" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
      const parsed = parseResult(result);
      expect(parsed.error).toContain("Cannot reconstruct execution summary");
      expect(parsed.executionId).toBe("exec-no-json");
    });
  });

  it("One missing channel", async () => {
    executionRows.push({
      id: "exec-missing-ch",
      templateId: "tmpl-mc",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Missing channel test" }]]),
    });
    templateRows.push({ id: "tmpl-mc", name: "MC Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-missing-ch" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }, { channelId: "nonexistent-channel", chatId: "chat-x" }],
      });
      const parsed = parseResult(result);
      expect(parsed.deliveries).toHaveLength(1);
      expect(parsed.deliveries[0].target.channelId).toBe("ch-A");
      expect(parsed.skippedTargets).toBeDefined();
      expect(parsed.skippedTargets ?? []).toHaveLength(1);
      expect((parsed.skippedTargets ?? [])[0].error).toBe("Channel not found");
    });
  });

  it("Disabled channel", async () => {
    channelRows.set("ch-disabled", { id: "ch-disabled", name: "Disabled", platform: "email", config: {}, viewerKey: "owner", status: "disconnected" });
    executionRows.push({
      id: "exec-disabled-ch",
      templateId: "tmpl-dc",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Disabled channel test" }]]),
    });
    templateRows.push({ id: "tmpl-dc", name: "DC Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      // ch-A is valid, ch-disabled is disconnected — partial result
      const result = await tool.handler({
        source: { type: "execution", id: "exec-disabled-ch" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }, { channelId: "ch-disabled", chatId: "chat-disabled" }],
      });
      const parsed = parseResult(result);
      // ch-A: delivered, ch-disabled: skipped
      expect(parsed.deliveries).toHaveLength(1);
      expect(parsed.deliveries[0].target.channelId).toBe("ch-A");
      expect(parsed.skippedTargets).toBeDefined();
      expect(parsed.skippedTargets ?? []).toHaveLength(1);
      expect((parsed.skippedTargets ?? [])[0].channelId).toBe("ch-disabled");
      expect((parsed.skippedTargets ?? [])[0].error).toContain("disconnected");
    });
  });

  it("includeArtifacts=false", async () => {
    executionRows.push({
      id: "exec-no-arts",
      templateId: "tmpl-na",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "No artifacts" }]]),
    });
    templateRows.push({ id: "tmpl-na", name: "No Arts", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });
    artifactRows.push(
      { id: "art-5", executionId: "exec-no-arts", stepId: "s1", key: "f", kind: "file", blobPath: "/tmp/f5.txt", mime: "text/plain", sizeBytes: 100, createdAt: Date.now() },
    );

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-no-arts" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
        includeArtifacts: false,
      });
      const parsed = parseResult(result);
      expect(parsed.attachmentCount).toBe(0);
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(callArg.attachments).toBeUndefined();
  });

  it("No deliverable targets", async () => {
    executionRows.push({
      id: "exec-no-targets",
      templateId: "tmpl-nt",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "No targets test" }]]),
    });
    templateRows.push({ id: "tmpl-nt", name: "NT Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      const result = await tool.handler({
        source: { type: "execution", id: "exec-no-targets" },
        targets: [{ channelId: "nonexistent-channel", chatId: "chat-x" }],
      });
      const parsed = parseResult(result);
      expect(parsed.error).toBe("No deliverable targets");
      expect(parsed.targetErrors).toHaveLength(1);
    });
  });

  it("Default messageType is result_delivery", async () => {
    executionRows.push({
      id: "exec-default-mt",
      templateId: "tmpl-dmt",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Default MT test" }]]),
    });
    templateRows.push({ id: "tmpl-dmt", name: "Default MT", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      await tool.handler({
        source: { type: "execution", id: "exec-default-mt" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(callArg.messageType).toBe("result_delivery");
  });

  it("receipt written with dispatch_outbound_batch actorToolName", async () => {
    executionRows.push({
      id: "exec-receipt",
      templateId: "tmpl-receipt",
      stepResultsJson: JSON.stringify([["s1", { stepId: "s1", taskId: "t1", status: "completed", result: "Receipt test" }]]),
    });
    templateRows.push({ id: "tmpl-receipt", name: "Receipt Template", config: {}, steps: [], trigger: { type: "manual" }, enabled: true });

    const tools = buildTools(buildDefaultRuntimeContext());
    const tool = tools.find((t: { name: string }) => t.name === "dispatch_outbound_batch") as unknown as { handler: (args: unknown) => Promise<unknown> };

    await withNewTrace("chat", async () => {
      await tool.handler({
        source: { type: "execution", id: "exec-receipt" },
        targets: [{ channelId: "ch-A", chatId: "chat-A1" }],
      });
    });

    const receipts = listReceiptsByTask("exec-receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].actor.toolName).toBe("dispatch_outbound_batch");
    expect(receipts[0].outcome).toBe("success");
  });
});
