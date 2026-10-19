import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
const { TEST_ENV_DIR, TEST_ENV_PATH } = vi.hoisted(() => {
  const dir = "/tmp/adam-email-gateway-routes";
  return { TEST_ENV_DIR: dir, TEST_ENV_PATH: `${dir}/.env` };
});

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

vi.mock("../../shared/constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/constants.js")>();
  return { ...actual, ENV_PATH: TEST_ENV_PATH };
});

import { configRoutes } from "../../server/routes/config.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { getRuntimeConfig, initRuntimeConfig } from "../../config/runtime.js";

afterAll(() => cleanup());

describe("config email gateway routes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearTestDb();
    mkdirSync(TEST_ENV_DIR, { recursive: true });
    writeFileSync(TEST_ENV_PATH, "", "utf-8");
    initRuntimeConfig(DEFAULT_CONFIG);
    app = Fastify({ logger: false });
    await app.register(configRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(TEST_ENV_DIR, { recursive: true, force: true });
  });

  it("GET /config masks email gateway passwords", async () => {
    await app.inject({
      method: "PATCH",
      url: "/config",
      payload: {
        "emailGateway.address": "adam@example.com",
        "emailGateway.imap.host": "imap.example.com",
        "emailGateway.imap.auth.pass": "imap-secret",
        "emailGateway.smtp.host": "smtp.example.com",
        "emailGateway.smtp.auth.pass": "smtp-secret",
      },
    });

    const response = await app.inject({ method: "GET", url: "/config" });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.config["emailGateway.imap.auth.pass"].value).toBe("imap-****");
    expect(body.config["emailGateway.smtp.auth.pass"].value).toBe("smtp-****");
    expect(JSON.stringify(body)).not.toContain("imap-secret");
    expect(JSON.stringify(body)).not.toContain("smtp-secret");
  });

  it("PATCH /config accepts valid email gateway values", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/config",
      payload: {
        "emailGateway.enabled": true,
        "emailGateway.address": "adam@example.com",
        "emailGateway.displayName": "Adam",
        "emailGateway.imap.host": "imap.example.com",
        "emailGateway.imap.port": 993,
        "emailGateway.imap.secure": true,
        "emailGateway.imap.auth.user": "adam@example.com",
        "emailGateway.imap.auth.pass": "imap-secret",
        "emailGateway.imap.mailbox": "INBOX",
        "emailGateway.smtp.host": "smtp.example.com",
        "emailGateway.smtp.port": 465,
        "emailGateway.smtp.secure": true,
        "emailGateway.smtp.auth.user": "adam@example.com",
        "emailGateway.smtp.auth.pass": "smtp-secret",
        "emailGateway.smtp.from": "Adam <adam@example.com>",
        "emailGateway.subjectPrefix": "Adam",
      },
    });

    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(false);
    expect(body.errors).toContain("\"emailGateway.smtp.from\" must be empty or a single valid email address.");

    const second = await app.inject({
      method: "PATCH",
      url: "/config",
      payload: {
        "emailGateway.enabled": true,
        "emailGateway.address": "adam@example.com",
        "emailGateway.displayName": "Adam",
        "emailGateway.imap.host": "imap.example.com",
        "emailGateway.imap.port": 993,
        "emailGateway.imap.secure": true,
        "emailGateway.imap.auth.user": "adam@example.com",
        "emailGateway.imap.auth.pass": "imap-secret",
        "emailGateway.imap.mailbox": "INBOX",
        "emailGateway.smtp.host": "smtp.example.com",
        "emailGateway.smtp.port": 465,
        "emailGateway.smtp.secure": true,
        "emailGateway.smtp.auth.user": "adam@example.com",
        "emailGateway.smtp.auth.pass": "smtp-secret",
        "emailGateway.smtp.from": "adam@example.com",
        "emailGateway.subjectPrefix": "Adam",
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().success).toBe(true);
    expect(getRuntimeConfig().emailGateway?.smtp.from).toBe("adam@example.com");
  });

  it("PATCH /config rejects invalid ports and invalid single-address fields", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/config",
      payload: {
        "emailGateway.imap.port": 0,
        "emailGateway.smtp.port": "465",
        "emailGateway.address": "a@example.com,b@example.com",
        "emailGateway.smtp.from": "Adam <adam@example.com>",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(false);
    expect(response.json().updated).toEqual([]);
    expect(response.json().errors).toEqual([
      "\"emailGateway.imap.port\" must be a positive integer port.",
      "\"emailGateway.smtp.port\" must be a positive integer port.",
      "\"emailGateway.address\" must be a single valid email address.",
      "\"emailGateway.smtp.from\" must be empty or a single valid email address.",
    ]);
  });

  it("POST /config/load-from-env maps ADAM_EMAIL vars into emailGateway paths", async () => {
    writeFileSync(
      TEST_ENV_PATH,
      [
        "ADAM_EMAIL_ADDRESS=adam@example.com",
        "ADAM_EMAIL_IMAP_HOST=imap.example.com",
        "ADAM_EMAIL_IMAP_PORT=993",
        "ADAM_EMAIL_IMAP_USER=adam@example.com",
        "ADAM_EMAIL_IMAP_PASS=imap-secret",
        "ADAM_EMAIL_SMTP_HOST=smtp.example.com",
        "ADAM_EMAIL_SMTP_PORT=465",
        "ADAM_EMAIL_SMTP_PASS=smtp-secret",
        "CUSTOM_ENV=value",
      ].join("\n"),
      "utf-8",
    );

    const response = await app.inject({ method: "POST", url: "/config/load-from-env" });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const config = getRuntimeConfig();
    expect(config.emailGateway?.address).toBe("adam@example.com");
    expect(config.emailGateway?.imap.host).toBe("imap.example.com");
    expect(config.emailGateway?.imap.port).toBe(993);
    expect(config.emailGateway?.imap.auth.pass).toBe("imap-secret");
    expect(config.emailGateway?.smtp.host).toBe("smtp.example.com");
    expect(config.emailGateway?.smtp.port).toBe(465);
    expect(config.emailGateway?.smtp.auth.pass).toBe("smtp-secret");
    expect(config.defaults.env).toEqual({ CUSTOM_ENV: "value" });
  });
});
