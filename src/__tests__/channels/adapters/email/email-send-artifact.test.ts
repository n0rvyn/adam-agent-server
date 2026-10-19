import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "../../../../shared/types.js";
import { EmailVirtualAdapter } from "../../../../channels/adapters/email/email-virtual-adapter.js";
import type { EmailGateway } from "../../../../channels/adapters/email/email-gateway.js";

describe("email send artifact", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends Markdown HTML/text and a local artifact attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adam-email-send-"));
    tempDirs.push(dir);
    const file = join(dir, "artifact.txt");
    writeFileSync(file, "artifact");
    const gateway = fakeGateway();
    const adapter = new EmailVirtualAdapter(channel(), gateway);

    await adapter.sendMessage("client@example.com", {
      content: "# Report",
      messageType: "deliver",
      mediaUrl: file,
      mediaType: "file",
    });

    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "client@example.com",
      subject: "[Adam Deliver]",
      text: "Report",
      html: expect.stringContaining("<h1>Report</h1>"),
      attachments: [{ filename: "artifact.txt", path: file, contentType: "application/octet-stream" }],
    }));
  });

  it("sends multiple artifact attachments in one email", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adam-email-send-"));
    tempDirs.push(dir);
    const report = join(dir, "report.md");
    const audio = join(dir, "audio.mp3");
    writeFileSync(report, "# report");
    writeFileSync(audio, "audio");
    const gateway = fakeGateway();
    const adapter = new EmailVirtualAdapter(channel(), gateway);

    await adapter.sendMessage("client@example.com", {
      content: "# Report",
      messageType: "deliver",
      attachments: [
        { path: report, filename: "daily-report.md", contentType: "text/markdown" },
        { path: audio, mediaType: "audio" },
      ],
    });

    expect(gateway.send).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        { filename: "daily-report.md", path: report, contentType: "text/markdown" },
        { filename: "audio.mp3", path: audio, contentType: "application/octet-stream" },
      ],
    }));
  });

  it("fails when a local artifact is missing", async () => {
    const adapter = new EmailVirtualAdapter(channel(), fakeGateway());

    await expect(adapter.sendMessage("client@example.com", {
      content: "Report",
      mediaUrl: "/tmp/adam-missing-file.txt",
      mediaType: "file",
    })).rejects.toThrow("not found");
  });
});

function channel(): Channel {
  return {
    id: "mail-1",
    name: "Client Mail",
    platform: "email",
    enabled: true,
    status: "connected",
    config: { address: "client@example.com" },
    createdAt: 1,
    messageCount: 0,
  };
}

function fakeGateway(): EmailGateway {
  return {
    getStatus: vi.fn(() => ({ status: "connected" })),
    send: vi.fn(async () => "<sent@example.com>"),
    isSentByAdam: vi.fn(() => false),
  } as unknown as EmailGateway;
}
