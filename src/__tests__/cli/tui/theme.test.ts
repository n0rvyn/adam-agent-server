import { describe, it, expect } from "vitest";
import { colors, spacing, layout } from "../../../cli/tui/theme.js";

describe("theme", () => {
  it("exports color functions", () => {
    expect(typeof colors.connected).toBe("function");
    expect(typeof colors.disconnected).toBe("function");
    expect(typeof colors.warning).toBe("function");
    expect(typeof colors.reasoning).toBe("function");
    expect(typeof colors.toolCall).toBe("function");
    expect(typeof colors.toolResult).toBe("function");
    expect(typeof colors.error).toBe("function");
    expect(typeof colors.dim).toBe("function");
    expect(typeof colors.bold).toBe("function");
  });

  it("exports status indicators", () => {
    expect(typeof colors.statusUp).toBe("string");
    expect(typeof colors.statusDown).toBe("string");
  });

  it("exports spacing values", () => {
    expect(spacing.xs).toBe(1);
    expect(spacing.sm).toBe(2);
    expect(spacing.md).toBe(4);
    expect(spacing.lg).toBe(8);
  });

  it("exports layout values", () => {
    expect(layout.statusBarHeight).toBe(2);
    expect(layout.inputBarHeight).toBe(1);
  });
});
