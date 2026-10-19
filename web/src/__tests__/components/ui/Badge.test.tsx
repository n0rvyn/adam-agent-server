import { describe, it, expect } from "vitest";
import { render, screen } from "../../utils/test-utils";
import { Badge, badgeVariants, statusVariant } from "@/components/ui/Badge";

describe("statusVariant()", () => {
  it.each([
    ["completed", "success"],
    ["ready", "success"],
    ["idle", "success"],
  ])("maps '%s' to '%s'", (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });

  it.each([
    ["running", "info"],
    ["busy", "info"],
    ["executing", "info"],
    ["planning", "info"],
    ["evaluating", "info"],
    ["replanning", "info"],
  ])("maps '%s' to '%s'", (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });

  it.each([
    ["pending", "warning"],
    ["queued", "warning"],
    ["paused", "warning"],
  ])("maps '%s' to '%s'", (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });

  it.each([
    ["failed", "destructive"],
    ["cancelled", "destructive"],
    ["dead", "destructive"],
    ["not_ready", "destructive"],
  ])("maps '%s' to '%s'", (status, expected) => {
    expect(statusVariant(status)).toBe(expected);
  });

  it("maps unknown status to 'muted'", () => {
    expect(statusVariant("unknown")).toBe("muted");
    expect(statusVariant("")).toBe("muted");
  });
});

describe("Badge", () => {
  it("renders with default variant", () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText("Default");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("bg-[var(--app-panel-muted)]");
  });

  it.each([
    ["success", "bg-[var(--app-success-soft-bg)]"],
    ["warning", "bg-[var(--app-warning-soft-bg)]"],
    ["destructive", "bg-[var(--app-danger-soft-bg)]"],
    ["info", "bg-[var(--app-accent-soft-bg)]"],
    ["muted", "bg-[var(--app-panel-elevated)]"],
    ["secondary", "bg-[var(--app-panel-elevated)]"],
    ["outline", "border-[var(--app-border)]"],
  ] as const)("renders variant '%s' with class '%s'", (variant, expectedClass) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    const badge = screen.getByText(variant);
    expect(badge.className).toContain(expectedClass);
  });

  it("merges custom className", () => {
    render(<Badge className="custom-class">Test</Badge>);
    const badge = screen.getByText("Test");
    expect(badge.className).toContain("custom-class");
  });

  it("exports badgeVariants function", () => {
    expect(typeof badgeVariants).toBe("function");
    const classes = badgeVariants({ variant: "success" });
    expect(classes).toContain("bg-[var(--app-success-soft-bg)]");
  });

  it("renders as span (inline element, no forwardRef)", () => {
    render(<Badge>Inline</Badge>);
    expect(screen.getByText("Inline").tagName).toBe("SPAN");
  });
});
