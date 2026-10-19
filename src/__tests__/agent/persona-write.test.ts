import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeRolePersona, buildRoleSystemPrompt, formatThreeTierRules } from "../../agent/persona.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Role } from "../../shared/types.js";

describe("Per-task persona write integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "adam-persona-test-"));
  });

  it("writes agent persona to per-task workspace CLAUDE.md", () => {
    const agent: Role = {
      id: "agent-test",
      name: "审慎",
      cagPrompt: "极其细心的工程师",
      preferences: {},
      learnedRules: { stylePreferences: ["always check edge cases"], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "",
      status: "active",
      createdAt: Date.now(),
    };

    const taskWorkspace = path.join(tempDir, "task-abc123");
    writeRolePersona(agent, taskWorkspace);

    const claudeMdPath = path.join(taskWorkspace, ".claude", "CLAUDE.md");
    expect(fs.existsSync(claudeMdPath)).toBe(true);

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("审慎");
    expect(content).toContain("always check edge cases");
  });

  it("writes default Adam persona when no agent is assigned", () => {
    const defaultAgent: Role = {
      id: "default",
      name: "Adam",
      cagPrompt: "General assistant with access to task management, configuration, and agent capabilities.",
      preferences: {},
      learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
      memoryStreamId: "",
      status: "active",
      createdAt: Date.now(),
    };

    const taskWorkspace = path.join(tempDir, "task-def456");
    writeRolePersona(defaultAgent, taskWorkspace);

    const claudeMdPath = path.join(taskWorkspace, ".claude", "CLAUDE.md");
    expect(fs.existsSync(claudeMdPath)).toBe(true);

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    expect(content).toContain("Adam");
    expect(content).toContain("General assistant");
  });

  it("per-task workspaces are isolated (different agent personas)", () => {
    const agent1: Role = {
      id: "a1", name: "审慎",
      cagPrompt: "Engineer",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "",
      status: "active", createdAt: 0,
    };
    const agent2: Role = {
      id: "a2", name: "敏捷",
      cagPrompt: "Fast coder",
      preferences: {}, learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] }, memoryStreamId: "",
      status: "active", createdAt: 0,
    };

    const ws1 = path.join(tempDir, "task-1");
    const ws2 = path.join(tempDir, "task-2");
    writeRolePersona(agent1, ws1);
    writeRolePersona(agent2, ws2);

    const content1 = fs.readFileSync(path.join(ws1, ".claude", "CLAUDE.md"), "utf-8");
    const content2 = fs.readFileSync(path.join(ws2, ".claude", "CLAUDE.md"), "utf-8");

    expect(content1).toContain("审慎");
    expect(content1).not.toContain("敏捷");
    expect(content2).toContain("敏捷");
    expect(content2).not.toContain("审慎");
  });
});
