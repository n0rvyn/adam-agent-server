/**
 * Task 12 — WeChat sendMessage prefers attachments[0] and falls back to mediaUrl.
 *
 * Two scenarios:
 * A. attachments path: filename is extracted from attachments[0].filename and the
 *    finalPath passed to sendWeixinMediaFile carries that name (or a timestamped copy).
 * B. mediaUrl fallback (ChatManager path): behavior unchanged, ext from mediaType.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rmSync } from "node:fs";

// Hoist ALL mocks that are referenced inside vi.mock factories (must precede vi.mock calls)
const {
  fakeMkdir,
  fakeWriteFile,
  fakeCopyFile,
  fakeUnlink,
  mockGetUpdates,
  mockSendMessage,
  mockSendTyping,
  mockSendWeixinMediaFile,
} = vi.hoisted(() => ({
  fakeMkdir:              vi.fn().mockResolvedValue(undefined),
  fakeWriteFile:          vi.fn().mockResolvedValue(undefined),
  fakeCopyFile:           vi.fn().mockResolvedValue(undefined),
  fakeUnlink:             vi.fn().mockResolvedValue(undefined),
  mockGetUpdates:         vi.fn(),
  mockSendMessage:        vi.fn(),
  mockSendTyping:         vi.fn(),
  mockSendWeixinMediaFile: vi.fn(),
}));

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../../channels/adapters/wechat/api.js", () => ({
  getUpdates: (...args: unknown[]) => mockGetUpdates(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendTyping: (...args: unknown[]) => mockSendTyping(...args),
  getConfig: vi.fn().mockResolvedValue({ typing_ticket: "test-ticket" }),
}));

vi.mock("../../../channels/adapters/wechat/messaging/send-media.js", () => ({
  sendWeixinMediaFile: (...args: unknown[]) => mockSendWeixinMediaFile(...args),
}));

vi.mock("../../../channels/adapters/wechat/login-qr.js", () => ({
  startWeixinLoginWithQr: vi.fn(),
  waitForWeixinLogin: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  __esModule: true,
  default: {
    mkdir:    fakeMkdir,
    writeFile: fakeWriteFile,
    copyFile:  fakeCopyFile,
    unlink:    fakeUnlink,
    readFile:  vi.fn().mockResolvedValue(Buffer.from("test content")),
  },
  mkdir:    fakeMkdir,
  writeFile: fakeWriteFile,
  copyFile:  fakeCopyFile,
  unlink:    fakeUnlink,
  readFile:  vi.fn().mockResolvedValue(Buffer.from("test content")),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { WeChatAdapter } from "../../../channels/adapters/wechat/wechat.js";
import type { OutboundMessage } from "../../../shared/types.js";

function markSessionActive(adapter: WeChatAdapter, chatId: string) {
  (adapter as unknown as {
    sessions: Map<string, { lastUserMessageAt: number; quotaRemaining: number }>;
  }).sessions.set(chatId, { lastUserMessageAt: Date.now(), quotaRemaining: 10 });
}

describe("WeChatAdapter attachments fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUpdates.mockReturnValue(new Promise(() => {}));
    mockSendMessage.mockResolvedValue(undefined);
    mockSendWeixinMediaFile.mockResolvedValue({ messageId: "test-msg-id" });
    fakeMkdir.mockClear();
    fakeWriteFile.mockClear();
    fakeCopyFile.mockClear();
    fakeUnlink.mockClear();
  });

  // Scenario A — attachments path
  it("Scenario A: uses attachments[0].filename for the finalPath sent to sendWeixinMediaFile", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user123");

    const msg: OutboundMessage = {
      content: "Here is the file",
      attachments: [{
        path: "/tmp/test.md",
        mediaType: "file",
        filename: "podcast.md",
        contentType: "text/markdown",
      }],
    };

    await adapter.sendMessage("user123", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string; text: string };
    // The final path must carry the user-friendly name (either as-is or with timestamp prefix)
    expect(call.filePath).toMatch(/podcast\.md$/);
    expect(call.text).toBe("Here is the file");
    await adapter.disconnect();
  });

  it("Scenario A: markdown attachment via attachments path produces .md extension in filePath", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user456");

    const msg: OutboundMessage = {
      content: "doc",
      attachments: [{
        path: "/tmp/notes.txt",
        mediaType: "file",
        filename: "notes.md",
        contentType: "text/markdown",
      }],
    };

    await adapter.sendMessage("user456", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string };
    expect(call.filePath).toMatch(/\.md$/);
    await adapter.disconnect();
  });

  // Scenario B — mediaUrl fallback (ChatManager path, no attachments)
  it("Scenario B: mediaUrl fallback calls sendWeixinMediaFile with ext derived from mediaType", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user789");

    const msg: OutboundMessage = {
      content: "audio file",
      mediaUrl: "/tmp/song.mp3",
      mediaType: "audio",
    };

    await adapter.sendMessage("user789", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string };
    // mediaType=audio maps to .mp3 regardless of contentType (none provided)
    expect(call.filePath).toMatch(/\.mp3$/);
    await adapter.disconnect();
  });

  it("Scenario B: mediaUrl with image mediaType uses .png extension", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user-img");

    const msg: OutboundMessage = {
      content: "image",
      mediaUrl: "/tmp/photo.jpg",
      mediaType: "image",
    };

    await adapter.sendMessage("user-img", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string };
    expect(call.filePath).toMatch(/\.png$/);
    await adapter.disconnect();
  });

  it("attachments path sanitizes filename — strips path separators and .. segments", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user-san");

    const msg: OutboundMessage = {
      content: "x",
      attachments: [{
        path: "/tmp/f",
        mediaType: "file",
        filename: "../../../etc/passwd",
        contentType: "text/plain",
      }],
    };

    await adapter.sendMessage("user-san", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string };
    // .. must be stripped so the filename is safe
    expect(call.filePath).not.toMatch(/\.\./);
    await adapter.disconnect();
  });

  it("attachments[0].contentType takes priority over mediaType for extension derivation", async () => {
    const adapter = new WeChatAdapter("wc1", {
      baseUrl: "https://ilink.example.com",
      botToken: "test-token",
    });
    await adapter.connect();
    markSessionActive(adapter, "user-ct");

    const msg: OutboundMessage = {
      content: "pdf",
      attachments: [{
        path: "/tmp/doc",
        mediaType: "file",              // coarse — not used for extension
        filename: "annual-report.pdf",
        contentType: "application/pdf",   // precise — used for extension
      }],
    };

    await adapter.sendMessage("user-ct", msg);

    expect(mockSendWeixinMediaFile).toHaveBeenCalledTimes(1);
    const call = mockSendWeixinMediaFile.mock.calls[0]![0] as { filePath: string };
    expect(call.filePath).toMatch(/\.pdf$/);
    await adapter.disconnect();
  });
});
