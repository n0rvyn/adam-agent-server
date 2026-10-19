import { describe, it, expect } from "vitest";
import {
  hasNonEmptyRequirements,
  validateTaskInstructionContract,
  TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY,
} from "../../manager/dispatch-contract.js";

describe("hasNonEmptyRequirements", () => {
  it("returns false for undefined", () => {
    expect(hasNonEmptyRequirements(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(hasNonEmptyRequirements({})).toBe(false);
  });

  it("returns true when tools has entries", () => {
    expect(hasNonEmptyRequirements({ tools: ["Read"] })).toBe(true);
  });

  it("returns true when paths has entries", () => {
    expect(hasNonEmptyRequirements({ paths: [{ path: "/tmp", access: "rw" }] })).toBe(true);
  });

  it("returns true when osCapabilities has entries", () => {
    expect(hasNonEmptyRequirements({ osCapabilities: [{ id: "camera" }] })).toBe(true);
  });

  it("returns true when plugins has entries", () => {
    expect(hasNonEmptyRequirements({ plugins: ["some-plugin"] })).toBe(true);
  });

  it("returns true when network is true", () => {
    expect(hasNonEmptyRequirements({ network: true })).toBe(true);
  });

  it("returns false when network is false", () => {
    expect(hasNonEmptyRequirements({ network: false })).toBe(false);
  });
});

describe("validateTaskInstructionContract", () => {
  it("rejects empty string", () => {
    const result = validateTaskInstructionContract("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TASK_INSTRUCTION_EMPTY");
    }
  });

  it("rejects whitespace-only string", () => {
    const result = validateTaskInstructionContract("   ");
    expect(result.ok).toBe(false);
  });

  it("rejects Chinese identity directive — 你是", () => {
    const result = validateTaskInstructionContract("你是Boris。查邮件");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("rejects Chinese identity directive — 你是 with space", () => {
    const result = validateTaskInstructionContract("你是 Boris。查邮件");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("rejects Chinese identity directive — 作为", () => {
    const result = validateTaskInstructionContract("作为分析师。分析数据");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("rejects Chinese identity directive — 扮演", () => {
    const result = validateTaskInstructionContract("扮演老师。教我数学");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("rejects English identity directive — You are", () => {
    const result = validateTaskInstructionContract("You are Boris. Check mail");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("rejects English identity directive — Act as", () => {
    const result = validateTaskInstructionContract("Act as a senior engineer. Review this PR.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(TASK_INSTRUCTION_CONTAINS_ROLE_IDENTITY);
    }
  });

  it("accepts plain work instruction in Chinese", () => {
    expect(validateTaskInstructionContract("查今天的邮件并总结")).toEqual({ ok: true });
  });

  it("accepts plain work instruction in English", () => {
    expect(validateTaskInstructionContract("Check today's emails and summarize")).toEqual({ ok: true });
  });

  it("only scans first sentence — identity later in text is not rejected", () => {
    // "你是" appears after the first sentence boundary (。), so it should pass
    expect(validateTaskInstructionContract("读取邮件并总结。注意：你是不能直接回复的")).toEqual({ ok: true });
  });

  it("accepts instruction with newlines", () => {
    expect(
      validateTaskInstructionContract("查收件箱\n提取关键信息\n总结为三点"),
    ).toEqual({ ok: true });
  });
});
