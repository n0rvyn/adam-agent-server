import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import Fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

vi.mock("../../server/events/server-bus.js", () => ({
  serverBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  setLogLevel: vi.fn(),
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../channels/adapters/email/email-gateway-tester.js", () => ({
  testImapConnection: vi.fn(),
  testSmtpConnection: vi.fn(),
  sendRoundtripProbe: vi.fn(),
}));

import { configRoutes } from "../../server/routes/config.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { initRuntimeConfig } from "../../config/runtime.js";
import {
  sendRoundtripProbe,
  testImapConnection,
  testSmtpConnection,
} from "../../channels/adapters/email/email-gateway-tester.js";

afterAll(() => cleanup());

describe("config email gateway test routes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearTestDb();
    initRuntimeConfig({
      ...DEFAULT_CONFIG,
      emailGateway: {
        ...DEFAULT_CONFIG.emailGateway!,
        enabled: true,
        address: "adam@example.com",
        imap: {
          ...DEFAULT_CONFIG.emailGateway!.imap,
          host: "imap.example.com",
          auth: { user: "adam@example.com", pass: "imap-secret" },
        },
        smtp: {
          ...DEFAULT_CONFIG.emailGateway!.smtp,
          host: "smtp.example.com",
          auth: { user: "adam@example.com", pass: "smtp-secret" },
          from: "adam@example.com",
        },
      },
    });
    app = Fastify({ logger: false });
    await app.register(configRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns structured IMAP success result", async () => {
    vi.mocked(testImapConnection).mockResolvedValue({
      ok: true,
      stage: "imap",
      code: "ok",
      message: "IMAP connection succeeded",
    });

    const response = await app.inject({ method: "POST", url: "/config/email-gateway/test-imap" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      stage: "imap",
      code: "ok",
      message: "IMAP connection succeeded",
    });
    expect(testImapConnection).toHaveBeenCalledWith(expect.objectContaining({ address: "adam@example.com" }));
  });

  it("returns structured SMTP error result without raw credentials", async () => {
    vi.mocked(testSmtpConnection).mockResolvedValue({
      ok: false,
      stage: "smtp",
      code: "auth_failed",
      message: "SMTP authentication failed",
      details: { command: "AUTH" },
    });

    const response = await app.inject({ method: "POST", url: "/config/email-gateway/test-smtp" });
    expect(response.statusCode).toBe(200);
    const bodyText = response.body;
    expect(response.json().code).toBe("auth_failed");
    expect(bodyText).not.toContain("smtp-secret");
    expect(bodyText).not.toContain("imap-secret");
  });

  it("returns status for configured email gateway", async () => {
    const response = await app.inject({ method: "GET", url: "/config/email-gateway/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      configured: true,
      lastStatus: "stopped",
    });
  });

  it("timeout routes return stable codes without raw credentials", async () => {
    vi.mocked(testImapConnection).mockResolvedValue({
      ok: false,
      stage: "imap",
      code: "timeout",
      message: "IMAP check timed out after 10000ms",
      details: { timeoutMs: 10_000 },
    });
    vi.mocked(testSmtpConnection).mockResolvedValue({
      ok: false,
      stage: "smtp",
      code: "timeout",
      message: "SMTP check timed out after 10000ms",
      details: { timeoutMs: 10_000 },
    });
    vi.mocked(sendRoundtripProbe).mockResolvedValue({
      ok: false,
      stage: "roundtrip",
      code: "timeout",
      message: "ROUNDTRIP check timed out after 30000ms",
      details: { timeoutMs: 30_000 },
    });

    const imap = await app.inject({ method: "POST", url: "/config/email-gateway/test-imap" });
    const smtp = await app.inject({ method: "POST", url: "/config/email-gateway/test-smtp" });
    const roundtrip = await app.inject({ method: "POST", url: "/config/email-gateway/test-roundtrip" });

    expect(imap.json().code).toBe("timeout");
    expect(smtp.json().code).toBe("timeout");
    expect(roundtrip.json().code).toBe("timeout");
    expect(`${imap.body}${smtp.body}${roundtrip.body}`).not.toContain("smtp-secret");
    expect(`${imap.body}${smtp.body}${roundtrip.body}`).not.toContain("imap-secret");
  });
});
