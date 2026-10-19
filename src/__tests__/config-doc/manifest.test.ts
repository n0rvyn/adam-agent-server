/**
 * Tests for src/store/config-doc/manifest.ts
 *
 * Pins:
 * - Dependency manifest unions all four plugin/skill sources and dedupes
 * - Placeholder manifest detects channelId/chatId, additionalDirectories paths,
 *   envVars values, mcpServers values, model — each with the correct kind
 * - Ledger owners = distinct non-undefined of the four step ledger fields
 *
 * These tests MUST fail before Task 3-impl (builder not implemented yet).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  buildDependencyManifest,
  buildPlaceholderManifest,
  collectLedgerOwners,
} from "../../store/config-doc/manifest.js";
import { createRole, getRole } from "../../store/roles.js";
import { createTaskTemplate, getTaskTemplate } from "../../store/task-templates.js";

afterAll(() => {
  try { rmSync(process.env.ADAM_TEST_DIR!, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => {
  clearTestDb();
});

describe("buildDependencyManifest", () => {
  it("unions plugins from template.config.plugins, step.requirements.plugins, role.skills, role.mcpServers", () => {
    const role = {
      id: "r1",
      name: "Host",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-1",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
      mcpServers: { "minimax-search": { command: "uvx", args: ["minimax-search"] } },
      skills: ["summarize", "translate"],
    };
    createRole(role);

    const template = {
      id: "tpl-1",
      name: "Test",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [
        {
          id: "s1",
          prompt: "do it",
          roleId: "r1",
          requirements: { plugins: ["minimax-search", "synth-auto"] },
        },
      ],
      config: { plugins: ["synth-auto"], timeout: 60, approvalRequired: [], approvalTimeout: 60 },
    };
    createTaskTemplate(template);

    const manifest = buildDependencyManifest([getTaskTemplate("tpl-1")!], [getRole("r1")!]);
    const ids = manifest.map((d) => `${d.kind}:${d.pluginId}`).sort();
    // Expect: plugin:minimax-search (from step reqs + role mcpServers), plugin:synth-auto (from config + step reqs),
    //         mcpServer:minimax-search (from role mcpServers key), skill:summarize, skill:translate
    expect(ids).toEqual(
      expect.arrayContaining([
        "plugin:minimax-search",
        "plugin:synth-auto",
        "mcpServer:minimax-search",
        "skill:summarize",
        "skill:translate",
      ]),
    );
    // Dedup: synth-auto should appear once (not twice)
    const synthAutoCount = ids.filter((s) => s.endsWith(":synth-auto")).length;
    expect(synthAutoCount).toBe(1);
  });

  it("records an 'unknown' source when a plugin id is not in the registry", () => {
    const role = {
      id: "r2",
      name: "Host2",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-2",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(role);
    const template = {
      id: "tpl-2",
      name: "T2",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "x", roleId: "r2" }],
      config: { plugins: ["ghost-plugin-xyz"], timeout: 60, approvalRequired: [], approvalTimeout: 60 },
    };
    createTaskTemplate(template);
    const manifest = buildDependencyManifest([getTaskTemplate("tpl-2")!], [getRole("r2")!]);
    const ghost = manifest.find((d) => d.pluginId === "ghost-plugin-xyz");
    expect(ghost).toBeDefined();
    expect(ghost!.source).toBe("unknown");
  });
});

describe("buildPlaceholderManifest", () => {
  it("detects deliverTo/reportTo channelId+chatId, additionalDirectories, envVars, mcpServers, model", () => {
    // Use the test runtime dir as a real path (it exists in setupTestDb)
    const runtimeDir = process.env.ADAM_TEST_DIR!;
    const role = {
      id: "r3",
      name: "Host3",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-3",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
      model: "claude-sonnet-4-6",
      additionalDirectories: [{ path: runtimeDir }],
      envVars: { API_KEY: "sk-12345" },
      mcpServers: { "minimax": { command: "uvx" } },
    };
    createRole(role);
    const template = {
      id: "tpl-3",
      name: "T3",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "x", roleId: "r3" }],
      deliverTo: [{ type: "channel" as const, channelId: "wechat:abc", chatId: "chat-xyz" }],
      reportTo: [{ type: "session" as const, sessionId: "sess-123" }],
      config: {
        env: { OTHER_KEY: "other-val" },
        timeout: 60,
        approvalRequired: [],
        approvalTimeout: 60,
      },
    };
    createTaskTemplate(template);
    const placeholders = buildPlaceholderManifest([getTaskTemplate("tpl-3")!], [getRole("r3")!]);
    const byField: Record<string, string> = {};
    for (const p of placeholders) byField[p.boundField] = p.kind;
    // Template-level deliverTo
    expect(byField["template.tpl-3.deliverTo[0].channelId"]).toBe("channel");
    expect(byField["template.tpl-3.deliverTo[0].chatId"]).toBe("channel");
    // Template-level reportTo (session)
    expect(byField["template.tpl-3.reportTo[0].sessionId"]).toBe("channel");
    // Role-level
    expect(byField["role.r3.model"]).toBe("model");
    expect(byField["role.r3.additionalDirectories[0].path"]).toBe("path");
    expect(byField["role.r3.envVars.API_KEY"]).toBe("env");
    expect(byField["role.r3.mcpServers.minimax"]).toBe("secret");
    // Template config env
    expect(byField["template.tpl-3.config.env.OTHER_KEY"]).toBe("env");
  });
});

describe("collectLedgerOwners", () => {
  it("returns distinct non-undefined ledger owner strings across steps", () => {
    // Create a role so the steps' roleId resolves.
    const role = {
      id: "r-x",
      name: "LedgerTestRole",
      cagPrompt: "x",
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "mem-x",
      status: "active" as const,
      preferences: {},
      createdAt: 1,
    };
    createRole(role);
    const template = {
      id: "tpl-4",
      name: "T4",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [
        {
          id: "s1",
          prompt: "x",
          roleId: "r-x",
          settlementLedgerOwner: "podcast-show",
          publishesClaimsTo: "podcast-show",
          settlesPredictionsFor: "podcast-show",
          openLedgerOwner: "podcast-show",
        },
        {
          id: "s2",
          prompt: "y",
          roleId: "r-x",
          settlementLedgerOwner: "news-feed",
          publishesClaimsTo: "news-feed",
        },
        {
          id: "s3",
          prompt: "z",
          roleId: "r-x",
          // no ledger fields
        },
      ],
    };
    createTaskTemplate(template);
    const owners = collectLedgerOwners([getTaskTemplate("tpl-4")!]);
    expect(owners.sort()).toEqual(["news-feed", "podcast-show"]);
  });
});
