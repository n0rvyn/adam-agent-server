/**
 * Integration tests for OutboundGateway.redeliverExecutionTo per-target packing.
 * Cases A-G as specified in Task 8-tests of the email-priority-packing plan.
 *
 * These tests MUST FAIL before Task 8-impl because packing is not wired yet:
 *   - Cases A/B/C: sendMessage receives full attachment set (no packing)
 *   - Case D: no structured OutboundFirstAttachmentExceedsCap error
 *   - Case E: WeChat assertion may pass (packer not applied = correct behavior already)
 *   - Case F: per-target attachmentCount differs -- currently both targets show artifacts.length
 *   - Case G: zero-attachment guard -- may pass (no packing branch = no footer added)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const emittedEvents: Array<{ type: string; [key: string]: unknown }> = [];
vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: (event: { type: string; [key: string]: unknown }) => { emittedEvents.push(event); },
  },
}));

vi.mock("../../delivery/format.js", () => ({
  formatForChannel: vi.fn((content: string) => content),
}));

// Channel mock: email channels with and without cap maps; one WeChat channel
const channelStore: Record<string, Record<string, unknown>> = {};
vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn((channelId: string) => channelStore[channelId]),
  getRecipientCap: vi.fn((channelId: string, domain: string) => {
    const ch = channelStore[channelId];
    if (!ch) return 20971520;
    const capMap = ch.recipientCapMap as Record<string, number> | undefined;
    if (capMap && capMap[domain] !== undefined) return capMap[domain];
    const def = ch.defaultRecipientCapBytes as number | undefined;
    return def ?? 20971520;
  }),
}));

const mockSendMessage = vi.fn();
vi.mock("../../server/routes/channels.js", () => ({
  getChannelManager: vi.fn(() => ({ sendMessage: mockSendMessage })),
}));

const artifactRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((executionId: string) =>
    artifactRows.filter((r) => r.executionId === executionId),
  ),
}));

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
  artifactRows.length = 0;
  emittedEvents.length = 0;
  mockSendMessage.mockReset().mockResolvedValue("msg-pack-1");

  const db = getTestDb();
  db.exec("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-pack', 'completed', 'seed', '{}', " + Date.now() + ")");
  db.exec("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-overflow', 'completed', 'seed', '{}', " + Date.now() + ")");
  db.exec("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-wechat', 'completed', 'seed', '{}', " + Date.now() + ")");
  db.exec("INSERT INTO tasks (id, status, prompt, config, created_at) VALUES ('exec-zero', 'completed', 'seed', '{}', " + Date.now() + ")");

  Object.keys(channelStore).forEach((k) => delete channelStore[k]);
  Object.assign(channelStore, {
    "ch-email-qq": {
      id: "ch-email-qq",
      name: "QQ Email",
      platform: "email",
      config: {},
      viewerKey: "owner",
      recipientCapMap: { "qq.com": 20971520 },
      defaultRecipientCapBytes: 20971520,
    },
    "ch-email-norvyn": {
      id: "ch-email-norvyn",
      name: "Norvyn Email",
      platform: "email",
      config: {},
      viewerKey: "owner",
      recipientCapMap: {},
      defaultRecipientCapBytes: 52428800,
    },
    "ch-email-nodefault": {
      id: "ch-email-nodefault",
      name: "No Default Email",
      platform: "email",
      config: {},
      viewerKey: "owner",
      recipientCapMap: {},
      defaultRecipientCapBytes: undefined,
    },
    "ch-wechat": {
      id: "ch-wechat",
      name: "WeChat",
      platform: "wechat",
      config: {},
      viewerKey: "owner",
    },
  });

  const gateway = getOutboundGateway();
  (gateway as unknown as { _dedupCache: Map<string, unknown> })._dedupCache.clear();
  (gateway as unknown as { _rateLimitWindows: Map<string, number[]> })._rateLimitWindows.clear();
  (gateway as unknown as { _recentlySentIds: Set<string> })._recentlySentIds.clear();
});

import { getOutboundGateway } from "../../delivery/outbound-gateway.js";

function buildMixedArtifacts(executionId: string): Array<Record<string, unknown>> {
  return [
    { id: "art-01", executionId, stepId: "s1", key: "podcast.mp3", kind: "file", blobPath: "/tmp/podcast.mp3", mime: "audio/mpeg", sizeBytes: 8388608, priority: 10, createdAt: Date.now() },
    { id: "art-02", executionId, stepId: "s1", key: "clip.mp4", kind: "file", blobPath: "/tmp/clip.mp4", mime: "video/mp4", sizeBytes: 5242880, priority: 10, createdAt: Date.now() },
    { id: "art-03", executionId, stepId: "s1", key: "script.md", kind: "file", blobPath: "/tmp/script.md", mime: "text/markdown", sizeBytes: 1048576, priority: 50, createdAt: Date.now() },
    { id: "art-04", executionId, stepId: "s1", key: "img1.png", kind: "file", blobPath: "/tmp/img1.png", mime: "image/png", sizeBytes: 2097152, priority: 100, createdAt: Date.now() },
    { id: "art-05", executionId, stepId: "s1", key: "img2.png", kind: "file", blobPath: "/tmp/img2.png", mime: "image/png", sizeBytes: 2097152, priority: 100, createdAt: Date.now() },
    { id: "art-06", executionId, stepId: "s1", key: "img3.png", kind: "file", blobPath: "/tmp/img3.png", mime: "image/png", sizeBytes: 2097152, priority: 100, createdAt: Date.now() },
    { id: "art-07", executionId, stepId: "s1", key: "extra1.zip", kind: "file", blobPath: "/tmp/extra1.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-08", executionId, stepId: "s1", key: "extra2.zip", kind: "file", blobPath: "/tmp/extra2.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-09", executionId, stepId: "s1", key: "extra3.zip", kind: "file", blobPath: "/tmp/extra3.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-10", executionId, stepId: "s1", key: "extra4.zip", kind: "file", blobPath: "/tmp/extra4.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-11", executionId, stepId: "s1", key: "extra5.zip", kind: "file", blobPath: "/tmp/extra5.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-12", executionId, stepId: "s1", key: "extra6.zip", kind: "file", blobPath: "/tmp/extra6.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-13", executionId, stepId: "s1", key: "extra7.zip", kind: "file", blobPath: "/tmp/extra7.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-14", executionId, stepId: "s1", key: "extra8.zip", kind: "file", blobPath: "/tmp/extra8.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
    { id: "art-15", executionId, stepId: "s1", key: "extra9.zip", kind: "file", blobPath: "/tmp/extra9.zip", mime: "application/zip", sizeBytes: 524288, priority: 200, createdAt: Date.now() },
  ];
}

describe("OutboundGateway per-target packing (Cases A-G)", () => {
  it("Case A: email channel cap_map['qq.com']=20MB + 15 artifacts -> packer drops low-priority items; body gets footer", async () => {
    artifactRows.push(...buildMixedArtifacts("exec-pack"));
    const gateway = getOutboundGateway();

    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-pack",
      targets: [{ channelId: "ch-email-qq", chatId: "foo@qq.com" }],
      content: "Podcast email body",
      messageType: "result_delivery",
      dedupDiscriminator: "case-A",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe("delivered");

    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    const sentAttachments = callArg.attachments as Array<unknown> | undefined;

    expect(sentAttachments).toBeDefined();
    expect((sentAttachments as Array<unknown>).length).toBeLessThan(15);
    expect((sentAttachments as Array<unknown>).length).toBeGreaterThan(0);

    const sentContent = callArg.content as string;
    expect(sentContent).toContain("上限");
    expect(sentContent).toContain("qq.com");
  });

  it("Case B: target foo@unknown.com (no cap_map entry) -> uses defaultRecipientCapBytes=20MB -> packing applied", async () => {
    artifactRows.push(...buildMixedArtifacts("exec-pack"));
    const gateway = getOutboundGateway();

    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-pack",
      targets: [{ channelId: "ch-email-qq", chatId: "foo@unknown.com" }],
      content: "Podcast email body",
      messageType: "result_delivery",
      dedupDiscriminator: "case-B",
    });

    expect(result.deliveries[0].status).toBe("delivered");
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    const sentAttachments = callArg.attachments as Array<unknown> | undefined;
    expect(sentAttachments).toBeDefined();
    expect((sentAttachments as Array<unknown>).length).toBeLessThan(15);
  });

  it("Case C: channel has no defaultRecipientCapBytes -> falls back to DEFAULT_EMAIL_CAP_BYTES=20MB -> packing applied", async () => {
    artifactRows.push(...buildMixedArtifacts("exec-pack"));
    const gateway = getOutboundGateway();

    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-pack",
      targets: [{ channelId: "ch-email-nodefault", chatId: "foo@nodefault.com" }],
      content: "Podcast email body",
      messageType: "result_delivery",
      dedupDiscriminator: "case-C",
    });

    expect(result.deliveries[0].status).toBe("delivered");
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    const sentAttachments = callArg.attachments as Array<unknown> | undefined;
    expect(sentAttachments).toBeDefined();
    expect((sentAttachments as Array<unknown>).length).toBeLessThan(15);
  });

  it("Case D: 25MB MP3 + 50KB png to 20MB-cap recipient -> partial-drop: png delivered, body footer mentions MP3", async () => {
    // MP3 (25MB × 1.33 = 33.25MB) overflows 20MB cap; companion png (50KB × 1.33 ≈ 66KB) fits.
    artifactRows.push(
      {
        id: "art-big",
        executionId: "exec-overflow",
        stepId: "s1",
        key: "big-podcast.mp3",
        kind: "file",
        blobPath: "/tmp/big-podcast.mp3",
        mime: "audio/mpeg",
        sizeBytes: 25165824, // 25MB — overflows 20MB cap
        priority: 10,
        createdAt: Date.now(),
      },
      {
        id: "art-small",
        executionId: "exec-overflow",
        stepId: "s1",
        key: "cover.png",
        kind: "file",
        blobPath: "/tmp/cover.png",
        mime: "image/png",
        sizeBytes: 51200, // 50KB — fits
        priority: 50,
        createdAt: Date.now(),
      },
    );

    const gateway = getOutboundGateway();
    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-overflow",
      targets: [{ channelId: "ch-email-qq", chatId: "overflow@qq.com" }],
      content: "Overflow test",
      dedupDiscriminator: "case-D",
    });

    expect(result.deliveries).toHaveLength(1);
    // Partial-drop: email is delivered (smaller companion included)
    expect(result.deliveries[0].status).toBe("delivered");
    // Only the png companion is attached
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    const sentAttachments = callArg.attachments as Array<{ artifactId?: string }> | undefined;
    expect(sentAttachments).toBeDefined();
    expect(sentAttachments!.length).toBe(1);
    expect(sentAttachments![0].artifactId).toBe("art-small");
    // Body footer mentions the dropped MP3 and the cap
    const sentContent = callArg.content as string;
    expect(sentContent).toMatch(/上限|exceeded.*cap|excluded.*size/i);
  });

  it("Case H: single 25MB MP3 to 20MB-cap recipient (no companion) -> all-or-nothing fail with effectiveSizeBytes in error", async () => {
    // No companion: the only item overflows → true all-or-nothing failure preserved
    artifactRows.push({
      id: "art-solo-big",
      executionId: "exec-overflow",
      stepId: "s1",
      key: "solo-podcast.mp3",
      kind: "file",
      blobPath: "/tmp/solo-podcast.mp3",
      mime: "audio/mpeg",
      sizeBytes: 25165824, // 25MB — overflows 20MB cap
      priority: 10,
      createdAt: Date.now(),
    });

    const gateway = getOutboundGateway();
    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-overflow",
      targets: [{ channelId: "ch-email-qq", chatId: "solo-overflow@qq.com" }],
      content: "Solo overflow test",
      dedupDiscriminator: "case-H",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe("failed");
    expect(result.deliveries[0].error).toMatch(/OutboundFirstAttachmentExceedsCap/);
    expect(result.deliveries[0].error).toMatch(/solo-podcast\.mp3|art-solo-big/);
    expect(result.deliveries[0].error).toMatch(/qq\.com/);
    // Task 2: new effectiveSizeBytes field must be present in error message
    expect(result.deliveries[0].error).toMatch(/effectiveSizeBytes=/);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("Case E: WeChat channel -> packer NOT applied; content has no footer; sendMessage called with all artifacts", async () => {
    artifactRows.push(
      { id: "wc-01", executionId: "exec-wechat", stepId: "s1", key: "audio.mp3", kind: "file", blobPath: "/tmp/audio.mp3", mime: "audio/mpeg", sizeBytes: 1048576, priority: 10, createdAt: Date.now() },
      { id: "wc-02", executionId: "exec-wechat", stepId: "s1", key: "img.png", kind: "file", blobPath: "/tmp/img.png", mime: "image/png", sizeBytes: 524288, priority: 100, createdAt: Date.now() },
    );

    const gateway = getOutboundGateway();
    await gateway.redeliverExecutionTo({
      executionId: "exec-wechat",
      targets: [{ channelId: "ch-wechat", chatId: "user-wechat" }],
      content: "WeChat message",
      dedupDiscriminator: "case-E",
    });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    const sentContent = callArg.content as string;
    expect(sentContent).not.toContain("上限");
  });

  it("Case F: two targets with different caps -> per-target attachmentCount differs (QQ < norvyn)", async () => {
    artifactRows.push(...buildMixedArtifacts("exec-pack"));
    const gateway = getOutboundGateway();

    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-pack",
      targets: [
        { channelId: "ch-email-qq", chatId: "foo@qq.com" },
        { channelId: "ch-email-norvyn", chatId: "foo@example.org" },
      ],
      content: "Multi-target packing",
      dedupDiscriminator: "case-F",
    });

    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries[0].status).toBe("delivered");
    expect(result.deliveries[1].status).toBe("delivered");

    const qqCount = result.deliveries[0].attachmentCount;
    const norvynCount = result.deliveries[1].attachmentCount;

    expect(qqCount).toBeLessThan(norvynCount);
    expect(qqCount).toBeLessThan(15);
    expect(norvynCount).toBeGreaterThan(qqCount);
  });

  it("Case G (0-attachment guard): zero fileArtifacts -> packer NOT invoked; no footer in content; attachments=undefined", async () => {
    const gateway = getOutboundGateway();

    const result = await gateway.redeliverExecutionTo({
      executionId: "exec-zero",
      targets: [{ channelId: "ch-email-qq", chatId: "foo@qq.com" }],
      content: "Zero attachments email body",
      dedupDiscriminator: "case-G",
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe("delivered");
    expect(result.deliveries[0].attachmentCount).toBe(0);

    const callArg = mockSendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(callArg.attachments).toBeUndefined();
    const sentContent = callArg.content as string;
    expect(sentContent).not.toContain("上限");
  });
});
