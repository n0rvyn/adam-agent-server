import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "../../utils/test-utils";
import { Button } from "@/components/ui/Button";

describe("Button", () => {
  it("renders as a button element by default", () => {
    render(<Button>Click me</Button>);
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button.tagName).toBe("BUTTON");
  });

  it("renders default variant with accent surface styling", () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-[var(--app-accent)]");
    expect(button.className).toContain("rounded-md");
    expect(button.className).not.toContain("translate-y");
  });

  it.each([
    ["secondary", "bg-white/[0.06]"],
    ["destructive", "bg-[var(--app-danger)]"],
    ["ghost", "hover:bg-white/[0.06]"],
    ["outline", "border-[var(--app-border)]"],
    ["link", "underline-offset-4"],
  ] as const)("renders variant '%s' with class '%s'", (variant, expectedClass) => {
    render(<Button variant={variant}>{variant}</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain(expectedClass);
  });

  it.each([
    ["sm", "text-xs"],
    ["lg", "px-5"],
    ["icon", "h-8 w-8"],
  ] as const)("renders size '%s' with class '%s'", (size, expectedClass) => {
    render(<Button size={size}>btn</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain(expectedClass);
  });

  it("applies disabled attribute and styles", () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("renders child element with asChild", () => {
    render(
      <Button asChild>
        <a href="/test">Link Button</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Link Button" });
    expect(link.tagName).toBe("A");
    expect(link.className).toContain("bg-[var(--app-accent)]");
  });

  it("merges custom className", () => {
    render(<Button className="my-custom">Test</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("my-custom");
    expect(button.className).toContain("bg-[var(--app-accent)]");
  });

  it("forwards ref to button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("fires onClick handler", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
