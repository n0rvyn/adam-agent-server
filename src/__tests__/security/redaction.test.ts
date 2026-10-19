import { describe, expect, it } from "vitest";
import { publicTaskView, redactSecrets } from "../../security/redaction.js";
import type { Task } from "../../shared/types.js";

describe("security/redaction", () => {
  it("deep-redacts nested secret and env containers", () => {
    const value = redactSecrets({
      anthropic: { apiKey: "sk-real" },
      emailGateway: {
        imap: { auth: { user: "adam@example.com", pass: "imap-secret" } },
      },
      defaults: { env: { CUSTOM_KEY: "custom-secret", SAFE_NAME: "visible" } },
    });

    expect(value).toMatchObject({
      anthropic: { apiKey: "[REDACTED]" },
      emailGateway: { imap: { auth: { user: "adam@example.com", pass: "[REDACTED]" } } },
      defaults: { env: { CUSTOM_KEY: "[REDACTED]", SAFE_NAME: "[REDACTED]" } },
    });
  });

  it("omits raw execution profile and env from public task config", () => {
    const task = {
      id: "task-1",
      status: "pending",
      prompt: "run",
      config: {
        timeout: 300,
        approvalRequired: [],
        approvalTimeout: 60,
        model: "claude-sonnet-4-6",
        env: { API_TOKEN: "secret" },
        executionProfile: {
          id: "role-1",
          name: "role",
          cagPrompt: "prompt",
          learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
          memoryStreamId: "mem-1",
          status: "active",
          preferences: {},
          createdAt: Date.now(),
          envVars: { PRIVATE_TOKEN: "secret" },
        },
      },
      createdAt: Date.now(),
    } as unknown as Task;

    const view = publicTaskView(task);

    expect(view.config).toMatchObject({ timeout: 300, model: "claude-sonnet-4-6" });
    expect(view.config).not.toHaveProperty("env");
    expect(view.config).not.toHaveProperty("executionProfile");
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});
