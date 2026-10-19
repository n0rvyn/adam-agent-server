import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: "info",
  }),
}));

vi.mock("../../store/channels.js", () => ({
  getChannel: vi.fn(),
}));

import { parseApprovalReply, formatPlanForChannel } from "../../channels/approval-handler.js";
import type { ExecutionPlan } from "../../shared/types.js";

describe("approval-handler: parseApprovalReply", () => {
  const cases: Array<{ input: string; expected: { requestId: string; decision: "allow" | "deny" } | null }> = [
    // English affirmative
    { input: "yes abc-123", expected: { requestId: "abc-123", decision: "allow" } },
    { input: "y abc-123", expected: { requestId: "abc-123", decision: "allow" } },
    // English negative
    { input: "no xyz-456", expected: { requestId: "xyz-456", decision: "deny" } },
    { input: "n xyz-456", expected: { requestId: "xyz-456", decision: "deny" } },
    // Chinese affirmative
    { input: "是 abc", expected: { requestId: "abc", decision: "allow" } },
    { input: "允许 abc", expected: { requestId: "abc", decision: "allow" } },
    // Chinese negative
    { input: "否 abc", expected: { requestId: "abc", decision: "deny" } },
    { input: "拒绝 abc", expected: { requestId: "abc", decision: "deny" } },
    // Case insensitive
    { input: "YES abc", expected: { requestId: "abc", decision: "allow" } },
    // With whitespace
    { input: "  yes abc  ", expected: { requestId: "abc", decision: "allow" } },
    // Invalid: no requestId
    { input: "yes", expected: null },
    { input: "no", expected: null },
    { input: "是", expected: null },
    // Invalid: no keyword
    { input: "abc-123", expected: null },
    { input: "approve abc-123", expected: null },
  ];

  for (const { input, expected } of cases) {
    it(`"${input}" → ${JSON.stringify(expected)}`, () => {
      expect(parseApprovalReply(input)).toEqual(expected);
    });
  }

  // 8-char shortId
  it(`"yes a1b2c3d4" → allow with 8-char shortId`, () => {
    expect(parseApprovalReply("yes a1b2c3d4")).toEqual({ requestId: "a1b2c3d4", decision: "allow" });
  });
});

describe("approval-handler: formatPlanForChannel", () => {
  function makePlan(steps: ExecutionPlan["steps"], overallRisk: "low" | "medium" | "high" = "medium"): ExecutionPlan {
    return {
      steps,
      requiredPermissions: {} as ExecutionPlan["requiredPermissions"],
      overallRisk,
    };
  }

  it("formats a Bash step with command", () => {
    const plan = makePlan([{
      index: 0,
      description: `Bash: ${JSON.stringify({ command: "ls /tmp" })}`,
      toolsNeeded: ["Bash"],
      expectedOutput: "",
      riskLevel: "medium",
    }]);
    const result = formatPlanForChannel(plan);
    expect(result).toContain("操作: Bash");
    expect(result).toContain("命令: ls /tmp");
    expect(result).toContain("🟡 中");
  });

  it("truncates Bash command longer than 120 chars", () => {
    const longCmd = "a".repeat(200);
    const plan = makePlan([{
      index: 0,
      description: `Bash: ${JSON.stringify({ command: longCmd })}`,
      toolsNeeded: ["Bash"],
      expectedOutput: "",
      riskLevel: "low",
    }]);
    const result = formatPlanForChannel(plan);
    expect(result).toContain("命令: " + "a".repeat(117) + "...");
    expect(result).toContain("🟢 低");
  });

  it("formats sandbox bypass step", () => {
    const plan = makePlan([{
      index: 0,
      description: "Execute task without OS sandbox — filesystem isolation not enforced",
      toolsNeeded: [],
      expectedOutput: "",
      riskLevel: "high",
    }]);
    const result = formatPlanForChannel(plan);
    expect(result).toContain("无沙箱执行");
    expect(result).toContain("🔴 高");
    expect(result).not.toContain("操作:");
  });

  it("formats a non-Bash step with description", () => {
    const plan = makePlan([{
      index: 0,
      description: `Read: ${JSON.stringify({ file_path: "/etc/hosts" })}`,
      toolsNeeded: ["Read"],
      expectedOutput: "",
      riskLevel: "medium",
    }]);
    const result = formatPlanForChannel(plan);
    expect(result).toContain("操作: Read");
    expect(result).toContain("详情:");
  });

  it("handles step with no colon delimiter (fallback to Operation)", () => {
    const plan = makePlan([{
      index: 0,
      description: "Analyze the codebase",
      toolsNeeded: ["Read"],
      expectedOutput: "",
      riskLevel: "low",
    }]);
    const result = formatPlanForChannel(plan);
    expect(result).toContain("操作: Operation");
  });

  it("formats multiple steps", () => {
    const plan = makePlan([
      { index: 0, description: `Bash: ${JSON.stringify({ command: "echo 1" })}`, toolsNeeded: ["Bash"], expectedOutput: "", riskLevel: "medium" },
      { index: 1, description: `Bash: ${JSON.stringify({ command: "echo 2" })}`, toolsNeeded: ["Bash"], expectedOutput: "", riskLevel: "medium" },
    ]);
    const result = formatPlanForChannel(plan);
    const bashCount = (result.match(/操作: Bash/g) ?? []).length;
    expect(bashCount).toBe(2);
  });
});
