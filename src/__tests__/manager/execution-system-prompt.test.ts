import { describe, it, expect } from "vitest";
import { buildExecutionSystemPrompt } from "../../manager/execution-system-prompt.js";
import type { ExecutionPromptContext } from "../../shared/types.js";

describe("execution-system-prompt", () => {
  it("includes task ID and prompt", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-99",
      prompt: "Write a report on Q4 earnings",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("task-99");
    expect(prompt).toContain("Write a report on Q4 earnings");
  });

  it("includes role context when roleName is provided", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-1",
      prompt: "Deploy the service",
      roleName: "DevOps Engineer",
      roleCagPrompt: "Specializes in CI/CD pipelines and cloud infrastructure",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("Role: DevOps Engineer");
    expect(prompt).toContain("Specializes in CI/CD pipelines");
  });

  it("does not include role block when roleName is absent", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-2",
      prompt: "Simple task",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).not.toContain("Role Context");
  });

  it("omits CAG Prompt line when roleCagPrompt is absent even with roleName", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-3",
      prompt: "Do the thing",
      roleName: "General",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("Role: General");
    expect(prompt).not.toContain("CAG Prompt:");
  });

  it("works without any optional fields", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-min",
      prompt: "Minimal task",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("task-min");
    expect(prompt).toContain("Minimal task");
    // Should not crash or have undefined in output
    expect(prompt).not.toContain("undefined");
  });

  it("formats all parts together correctly", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-full",
      prompt: "Build the dashboard",
      roleName: "Frontend Dev",
      roleCagPrompt: "React and TypeScript expert",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("Task ID: task-full");
    expect(prompt).toContain("Prompt: Build the dashboard");
    expect(prompt).toContain("Role: Frontend Dev");
    expect(prompt).toContain("React and TypeScript expert");
  });

  it("includes cwd in file-write constraint when provided", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-cwd",
      prompt: "Generate a report",
      cwd: "/Users/foo/.adam/roles/bar",
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("/Users/foo/.adam/roles/bar");
    expect(prompt).toContain("File writes:");
  });

  it("always includes the /tmp write prohibition regardless of context shape", () => {
    const minimal = buildExecutionSystemPrompt({
      taskId: "t-min",
      prompt: "x",
    });
    const full = buildExecutionSystemPrompt({
      taskId: "t-full",
      prompt: "x",
      roleName: "R",
      roleCagPrompt: "C",
      allowedTools: ["Write"],
      cwd: "/tmp-allowed-for-role",
    });

    for (const p of [minimal, full]) {
      expect(p).toContain("Do NOT write to absolute paths");
      expect(p).toContain("/tmp/*");
    }
  });

  it("includes TemplateExecution artifact guidance for template execution step tasks", () => {
    const context: ExecutionPromptContext = {
      taskId: "task-step",
      prompt: "Process upstream output",
      templateExecutionStep: {
        executionId: "exec-1",
        stepId: "step-b",
      },
    };

    const prompt = buildExecutionSystemPrompt(context);

    expect(prompt).toContain("TemplateExecution Step Context");
    expect(prompt).toContain("step-b");
    expect(prompt).toContain("exec-1");
    expect(prompt).toContain("write_artifact");
    expect(prompt).toContain("publish_artifact_file");
    expect(prompt).toContain("fetch_artifact_file");
    expect(prompt).toContain("list_artifacts");
  });

  it("treats Required Step Output blocks as completion conditions", () => {
    const prompt = buildExecutionSystemPrompt({
      taskId: "task-required-output",
      prompt: "## Required Step Output\n- Required artifact key: `最终逐字稿`",
      templateExecutionStep: {
        executionId: "exec-1",
        stepId: "polish",
      },
    });

    expect(prompt).toContain("Required Step Output");
    expect(prompt).toContain("completion condition");
    expect(prompt).toContain("Publish the required artifact under the exact key");
    expect(prompt).toContain("final assistant response is only a summary");
  });

  // S5-B: ExecutionManager system prompt must warn about UNTRUSTED_INPUT blocks in tool results.
  it("warns about UNTRUSTED_INPUT in tool results", () => {
    const prompt = buildExecutionSystemPrompt({ taskId: "t1", prompt: "do x" });
    expect(prompt).toContain("UNTRUSTED_INPUT");
  });
});
