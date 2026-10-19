import { describe, it, expect } from "vitest";
import { roleColor, taskShortId } from "../../../cli/tui/role-colors.js";

describe("roleColor", () => {
  it("returns one of 6 palette colors for any roleId", () => {
    const valid = ["cyan", "magenta", "green", "yellow", "blue", "red"];
    expect(valid).toContain(roleColor("role-1"));
    expect(valid).toContain(roleColor("审慎者"));
    expect(valid).toContain(roleColor("xyz123"));
  });

  it("is deterministic — same roleId → same color", () => {
    expect(roleColor("role-1")).toBe(roleColor("role-1"));
    expect(roleColor("审慎者")).toBe(roleColor("审慎者"));
  });

  it("returns cyan default for null/undefined/empty", () => {
    expect(roleColor(undefined)).toBe("cyan");
    expect(roleColor(null)).toBe("cyan");
    expect(roleColor("")).toBe("cyan");
  });

  it("distributes across palette (different roleIds → likely different colors)", () => {
    const colors = new Set();
    for (let i = 0; i < 100; i++) {
      colors.add(roleColor(`role-${i}`));
    }
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });
});

describe("taskShortId", () => {
  it("produces T-XXXXXXXX format from UUID-like taskId", () => {
    expect(taskShortId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("T-A1B2C3D4");
  });

  it("uppercases and strips dashes", () => {
    expect(taskShortId("a1b2c3d4")).toBe("T-A1B2C3D4");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(taskShortId(undefined)).toBe("");
    expect(taskShortId(null)).toBe("");
    expect(taskShortId("")).toBe("");
  });

  it("handles short taskId (< 8 chars)", () => {
    expect(taskShortId("abc")).toBe("T-ABC");
  });
});
