import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EmailGatewayConfig } from "../../../../shared/types.js";

const mocks = vi.hoisted(() => ({
  imapInstances: [] as any[],
  smtpInstances: [] as any[],
}));

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(function () {
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 1 }),
      logout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn(),
    };
    mocks.imapInstances.push(instance);
    return instance;
  }),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockImplementation(() => {
      const instance = {
        verify: vi.fn().mockResolvedValue(true),
        sendMail: vi.fn().mockResolvedValue({ messageId: "sent-1" }),
        close: vi.fn(),
      };
      mocks.smtpInstances.push(instance);
      return instance;
    }),
  },
}));

import { writeFileSync, mkdirSync, rmSync as rmFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { EmailGateway, restartEmailGatewayFromConfig, computeSendTimeoutMs } from "../../../../channels/adapters/email/email-gateway.js";

describe("EmailGateway", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.imapInstances.length = 0;
    mocks.smtpInstances.length = 0;
    runtimeRoot = mkdtempSync(join(tmpdir(), "adam-email-gateway-"));
    process.env.ADAM_TEST_DIR = runtimeRoot;
  });

  afterEach(() => {
    delete process.env.ADAM_TEST_DIR;
    rmSync(runtimeRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("start connects both clients", async () => {
    const gateway = new EmailGateway();
    await gateway.start(config());

    expect(ImapFlow).toHaveBeenCalledTimes(1);
    expect(mocks.imapInstances[0].connect).toHaveBeenCalled();
    expect(mocks.imapInstances[0].mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(mocks.smtpInstances[0].verify).toHaveBeenCalled();
    expect(gateway.getStatus().status).toBe("connected");

    await gateway.stop();
  });

  it("stop closes resources", async () => {
    const gateway = new EmailGateway();
    await gateway.start(config());
    await gateway.stop();

    expect(mocks.imapInstances[0].logout).toHaveBeenCalled();
    expect(mocks.smtpInstances[0].close).toHaveBeenCalled();
    expect(gateway.getStatus().status).toBe("stopped");
  });

  it("stop is idempotent when cleanup methods return non-promises", async () => {
    vi.mocked(ImapFlow).mockImplementationOnce(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 1 }),
        logout: vi.fn(),
        close: vi.fn(),
        fetch: vi.fn(),
      };
      mocks.imapInstances.push(instance);
      return instance as any;
    });
    const gateway = new EmailGateway();
    await gateway.start(config());

    await expect(gateway.stop()).resolves.toBeUndefined();
    await expect(gateway.stop()).resolves.toBeUndefined();

    expect(mocks.imapInstances[0].logout).toHaveBeenCalledTimes(1);
    expect(mocks.imapInstances[0].close).toHaveBeenCalledTimes(1);
    expect(mocks.smtpInstances[0].close).toHaveBeenCalledTimes(1);
  });

  it("stop ignores cleanup promise rejections", async () => {
    vi.mocked(ImapFlow).mockImplementationOnce(function () {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 1 }),
        logout: vi.fn().mockRejectedValue(new Error("logout failed")),
        close: vi.fn().mockRejectedValue(new Error("close failed")),
        fetch: vi.fn(),
      };
      mocks.imapInstances.push(instance);
      return instance as any;
    });
    const gateway = new EmailGateway();
    await gateway.start(config());

    await expect(gateway.stop()).resolves.toBeUndefined();
    expect(gateway.getStatus().status).toBe("stopped");
  });

  it("send calls sendMail and records message id", async () => {
    const gateway = new EmailGateway();
    await gateway.start(config());

    await expect(gateway.send({
      to: "test1@test.com",
      subject: "Report",
      text: "Plain",
      html: "<p>Plain</p>",
      attachments: [{ path: "/tmp/report.txt" }],
    })).resolves.toBe("sent-1");

    expect(mocks.smtpInstances[0].sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: "test1@test.com",
      subject: "Report",
    }));
    expect(gateway.isSentByAdam("sent-1")).toBe(true);

    await gateway.stop();
  });

  it("failed IMAP connect sets status error", async () => {
    vi.mocked(ImapFlow).mockImplementationOnce(function () {
      const instance = {
        connect: vi.fn().mockRejectedValue(new Error("imap failed")),
        mailboxOpen: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
      };
      mocks.imapInstances.push(instance);
      return instance as any;
    });
    const gateway = new EmailGateway();

    await expect(gateway.start(config())).rejects.toThrow("imap failed");
    expect(gateway.getStatus()).toMatchObject({ status: "error", lastError: "imap failed" });
  });

  it("partial start failure closes already-opened clients and clears timers", async () => {
    vi.mocked(nodemailer.createTransport).mockImplementationOnce(() => {
      const instance = {
        verify: vi.fn().mockRejectedValue(new Error("smtp failed")),
        close: vi.fn(),
      };
      mocks.smtpInstances.push(instance);
      return instance as any;
    });
    const gateway = new EmailGateway();

    await expect(gateway.start(config())).rejects.toThrow("smtp failed");

    expect(mocks.imapInstances[0].logout).toHaveBeenCalled();
    expect(mocks.smtpInstances[0].close).toHaveBeenCalled();
    expect(gateway.getStatus().status).toBe("error");
  });

  it("send timeout returns stable failure without leaking credentials", async () => {
    vi.useFakeTimers();
    const gateway = new EmailGateway();
    await gateway.start(config());
    mocks.smtpInstances[0].sendMail.mockReturnValue(new Promise(() => undefined));

    const sendPromise = gateway.send({
      to: "test1@test.com",
      subject: "Report",
      text: "Plain",
    });
    // Empty attachments → 30s base timeout (computeSendTimeoutMs).
    // Advance past it to trigger the timeout race.
    const assertion = expect(sendPromise).rejects.toThrow("SMTP send timed out");
    await vi.advanceTimersByTimeAsync(30_000);

    await assertion;
    await gateway.stop();
  });

  it("repeated restart stops previous clients before creating new ones", async () => {
    await restartEmailGatewayFromConfig(config(), "test");
    await restartEmailGatewayFromConfig(config(), "test");

    expect(mocks.imapInstances).toHaveLength(2);
    expect(mocks.smtpInstances).toHaveLength(2);
    expect(mocks.imapInstances[0].logout).toHaveBeenCalled();
    expect(mocks.smtpInstances[0].close).toHaveBeenCalled();
  });
});

describe("computeSendTimeoutMs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "adam-email-timeout-test-"));
  });

  afterEach(() => {
    rmFileSync(tmpDir, { recursive: true, force: true });
  });

  function makeAttachment(filename: string, sizeBytes: number) {
    const path = join(tmpDir, filename);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path, Buffer.alloc(sizeBytes));
    return { path, filename };
  }

  it("returns base 30s when attachments is undefined", () => {
    expect(computeSendTimeoutMs(undefined)).toBe(30_000);
  });

  it("returns base 30s when attachments is empty", () => {
    expect(computeSendTimeoutMs([])).toBe(30_000);
  });

  it("scales with attachment total bytes (14.5 MB MP3 ≈ 26 MB base64 → ~130s)", () => {
    const att = makeAttachment("podcast.mp3", 14_500_000);
    const result = computeSendTimeoutMs([att]);
    // base 30000 + ceil(14.5MB * 1.33 / 1024^2 * 5000) = 30000 + ceil(91997) ≈ 122000
    expect(result).toBeGreaterThanOrEqual(110_000);
    expect(result).toBeLessThanOrEqual(140_000);
  });

  it("caps at 300s for very large attachments", () => {
    const att = makeAttachment("huge.bin", 100 * 1024 * 1024);
    expect(computeSendTimeoutMs([att])).toBe(300_000);
  });

  it("sums multiple attachments", () => {
    const a1 = makeAttachment("a.mp3", 14_500_000);
    const a2 = makeAttachment("b.png", 500_000);
    const a3 = makeAttachment("c.png", 500_000);
    const result = computeSendTimeoutMs([a1, a2, a3]);
    // Slightly higher than single 14.5MB case
    expect(result).toBeGreaterThanOrEqual(115_000);
    expect(result).toBeLessThanOrEqual(150_000);
  });

  it("falls back to base when stat fails (missing file)", () => {
    const ghost = { path: join(tmpDir, "does-not-exist.bin"), filename: "ghost.bin" };
    expect(computeSendTimeoutMs([ghost])).toBe(30_000);
  });
});

function config(): EmailGatewayConfig {
  return {
    enabled: true,
    address: "adam@example.com",
    displayName: "Adam",
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "adam@example.com", pass: "imap-secret" },
      mailbox: "INBOX",
    },
    smtp: {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "adam@example.com", pass: "smtp-secret" },
      from: "adam@example.com",
    },
    subjectPrefix: "Adam",
  };
}
