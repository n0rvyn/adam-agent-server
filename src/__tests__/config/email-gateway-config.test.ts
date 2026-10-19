import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const { TEST_ENV_DIR, TEST_ENV_PATH } = vi.hoisted(() => {
  const dir = "/tmp/adam-email-gateway-config";
  return { TEST_ENV_DIR: dir, TEST_ENV_PATH: `${dir}/.env` };
});

vi.mock("../../shared/constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/constants.js")>();
  return { ...actual, ENV_PATH: TEST_ENV_PATH };
});

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { buildSdkEnv, initRuntimeConfig } from "../../config/runtime.js";
import { collectSeedValues } from "../../config/loader.js";
import { computeEnvDiff, readEnvFile } from "../../config/env-sync.js";

const EMAIL_ENV_KEYS = [
  "ADAM_EMAIL_ADDRESS",
  "ADAM_EMAIL_IMAP_HOST",
  "ADAM_EMAIL_IMAP_PORT",
  "ADAM_EMAIL_IMAP_SECURE",
  "ADAM_EMAIL_IMAP_USER",
  "ADAM_EMAIL_IMAP_PASS",
  "ADAM_EMAIL_IMAP_MAILBOX",
  "ADAM_EMAIL_SMTP_HOST",
  "ADAM_EMAIL_SMTP_PORT",
  "ADAM_EMAIL_SMTP_SECURE",
  "ADAM_EMAIL_SMTP_USER",
  "ADAM_EMAIL_SMTP_PASS",
  "ADAM_EMAIL_SMTP_FROM",
  "ADAM_EMAIL_SUBJECT_PREFIX",
];

describe("email gateway config", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mkdirSync(TEST_ENV_DIR, { recursive: true });
    for (const key of EMAIL_ENV_KEYS) delete process.env[key];
    initRuntimeConfig(DEFAULT_CONFIG);
  });

  afterEach(() => {
    rmSync(TEST_ENV_DIR, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it("defines disabled defaults", () => {
    expect(DEFAULT_CONFIG.emailGateway).toEqual({
      enabled: false,
      address: "",
      displayName: "Adam",
      imap: {
        host: "",
        port: 993,
        secure: true,
        auth: { user: "", pass: "" },
        mailbox: "INBOX",
      },
      smtp: {
        host: "",
        port: 465,
        secure: true,
        auth: { user: "", pass: "" },
        from: "",
      },
      subjectPrefix: "Adam",
    });
  });

  it("env sync maps ADAM_EMAIL keys to emailGateway config paths", () => {
    writeFileSync(
      TEST_ENV_PATH,
      [
        "ADAM_EMAIL_IMAP_HOST=imap.example.com",
        "ADAM_EMAIL_IMAP_USER=adam@example.com",
        "ADAM_EMAIL_IMAP_PASS=imap-secret",
        "ADAM_EMAIL_SMTP_HOST=smtp.example.com",
        "ADAM_EMAIL_SMTP_PASS=smtp-secret",
      ].join("\n"),
      "utf-8",
    );

    expect(readEnvFile()).toEqual({
      ADAM_EMAIL_IMAP_HOST: "imap.example.com",
      ADAM_EMAIL_IMAP_USER: "adam@example.com",
      ADAM_EMAIL_IMAP_PASS: "imap-secret",
      ADAM_EMAIL_SMTP_HOST: "smtp.example.com",
      ADAM_EMAIL_SMTP_PASS: "smtp-secret",
    });

    const diffs = computeEnvDiff({
      "emailGateway.imap.host": "",
      "emailGateway.imap.auth.user": "",
      "emailGateway.imap.auth.pass": "",
      "emailGateway.smtp.host": "",
      "emailGateway.smtp.auth.pass": "",
    });

    expect(diffs.map((diff) => [diff.envKey, diff.configPath])).toEqual([
      ["ADAM_EMAIL_IMAP_HOST", "emailGateway.imap.host"],
      ["ADAM_EMAIL_IMAP_USER", "emailGateway.imap.auth.user"],
      ["ADAM_EMAIL_IMAP_PASS", "emailGateway.imap.auth.pass"],
      ["ADAM_EMAIL_SMTP_HOST", "emailGateway.smtp.host"],
      ["ADAM_EMAIL_SMTP_PASS", "emailGateway.smtp.auth.pass"],
    ]);
  });

  it("first-boot collectSeedValues maps ADAM_EMAIL env vars to emailGateway paths", () => {
    process.env.ADAM_EMAIL_ADDRESS = "adam@example.com";
    process.env.ADAM_EMAIL_IMAP_HOST = "imap.example.com";
    process.env.ADAM_EMAIL_IMAP_PORT = "993";
    process.env.ADAM_EMAIL_IMAP_SECURE = "true";
    process.env.ADAM_EMAIL_IMAP_USER = "adam@example.com";
    process.env.ADAM_EMAIL_IMAP_PASS = "imap-secret";
    process.env.ADAM_EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.ADAM_EMAIL_SMTP_PORT = "465";
    process.env.ADAM_EMAIL_SMTP_PASS = "smtp-secret";

    expect(collectSeedValues()).toMatchObject({
      "emailGateway.address": "adam@example.com",
      "emailGateway.imap.host": "imap.example.com",
      "emailGateway.imap.port": 993,
      "emailGateway.imap.secure": true,
      "emailGateway.imap.auth.user": "adam@example.com",
      "emailGateway.imap.auth.pass": "imap-secret",
      "emailGateway.smtp.host": "smtp.example.com",
      "emailGateway.smtp.port": 465,
      "emailGateway.smtp.auth.pass": "smtp-secret",
    });
  });

  it("first-boot seed does not put managed ADAM_EMAIL keys into defaults.env", () => {
    writeFileSync(
      TEST_ENV_PATH,
      "ADAM_EMAIL_IMAP_PASS=imap-secret\nCUSTOM_VISIBLE=value\n",
      "utf-8",
    );

    const seeds = collectSeedValues();
    expect(seeds["emailGateway.imap.auth.pass"]).toBeUndefined();
    expect(seeds["defaults.env"]).toEqual({ CUSTOM_VISIBLE: "value" });
  });

  it("buildSdkEnv excludes every ADAM_EMAIL key inherited from process.env", () => {
    process.env.ADAM_EMAIL_IMAP_PASS = "imap-secret";
    process.env.ADAM_EMAIL_SMTP_PASS = "smtp-secret";
    process.env.ADAM_EMAIL_IMAP_HOST = "imap.example.com";

    const env = buildSdkEnv();

    expect(env.ADAM_EMAIL_IMAP_PASS).toBeUndefined();
    expect(env.ADAM_EMAIL_SMTP_PASS).toBeUndefined();
    expect(env.ADAM_EMAIL_IMAP_HOST).toBeUndefined();
  });
});
