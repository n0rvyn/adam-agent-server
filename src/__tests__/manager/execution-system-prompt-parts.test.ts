import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { buildExecutionSystemPrompt, buildExecutionSystemPromptParts } from "../../manager/execution-system-prompt.js";
import type { ExecutionPromptContext } from "../../shared/types.js";

describe("buildExecutionSystemPromptParts", () => {
  // Minimal context for reuse across cases
  const baseContext: ExecutionPromptContext = {
    taskId: "task-abc123",
    prompt: "Write a haiku about rain.",
    roleName: "Writer",
    roleCagPrompt: "You are a creative writer.",
    allowedTools: ["Read", "Write", "Bash"],
    cwd: "/tmp/test-workspace",
  };

  it("returns exactly 3 parts", () => {
    const parts = buildExecutionSystemPromptParts(baseContext);
    expect(parts.length).toBe(3);
  });

  it("uses SYSTEM_PROMPT_DYNAMIC_BOUNDARY as the second element", () => {
    const parts = buildExecutionSystemPromptParts(baseContext);
    expect(parts[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it("static block is identical for different contexts (cache eligibility)", () => {
    const ctx2: ExecutionPromptContext = {
      taskId: "task-xyz789",
      prompt: "Write a sonnet about sun.",
      roleName: "Analyst",
      roleCagPrompt: "You are a data analyst.",
      allowedTools: ["Read", "Write"],
      cwd: "/tmp/other-workspace",
    };
    const parts1 = buildExecutionSystemPromptParts(baseContext);
    const parts2 = buildExecutionSystemPromptParts(ctx2);
    expect(parts1[0]).toBe(parts2[0]); // static block: string equality
  });

  it("dynamic block contains taskId and prompt for the given context", () => {
    const parts = buildExecutionSystemPromptParts(baseContext);
    expect(parts[2]).toContain("task-abc123");
    expect(parts[2]).toContain("Write a haiku about rain.");
  });

  it("buildExecutionSystemPrompt (joined) does NOT contain the boundary marker", () => {
    const joined = buildExecutionSystemPrompt(baseContext);
    expect(joined).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  });

  it("buildExecutionSystemPrompt content equals parts filtered + joined", () => {
    const parts = buildExecutionSystemPromptParts(baseContext);
    const expected = parts.filter((p) => p !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join("\n\n");
    expect(buildExecutionSystemPrompt(baseContext)).toBe(expected);
  });
});
