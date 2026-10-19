import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "../../utils/test-utils";
import { Input } from "@/components/ui/Input";

describe("Input", () => {
  it("renders as an input element", () => {
    render(<Input data-testid="input" />);
    expect(screen.getByTestId("input").tagName).toBe("INPUT");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("has dark theme styling", () => {
    render(<Input data-testid="input" />);
    const input = screen.getByTestId("input");
    expect(input.className).toContain("border-[var(--app-border)]");
    expect(input.className).toContain("bg-[var(--app-panel-elevated)]");
  });

  it("applies disabled styles", () => {
    render(<Input data-testid="input" disabled />);
    expect(screen.getByTestId("input")).toBeDisabled();
  });

  it("merges custom className", () => {
    render(<Input data-testid="input" className="w-64" />);
    expect(screen.getByTestId("input").className).toContain("w-64");
  });

  it("passes type prop", () => {
    render(<Input data-testid="input" type="password" />);
    expect(screen.getByTestId("input")).toHaveAttribute("type", "password");
  });

  it("renders placeholder with muted styling", () => {
    render(<Input data-testid="input" placeholder="Enter text" />);
    expect(screen.getByPlaceholderText("Enter text")).toBeInTheDocument();
    expect(screen.getByTestId("input").className).toContain("placeholder:text-[var(--app-text-subtle)]");
  });

  it("has focus styles", () => {
    render(<Input data-testid="input" />);
    const input = screen.getByTestId("input");
    expect(input.className).toContain("focus:border-[var(--app-accent)]");
    expect(input.className).toContain("focus:ring-1");
    expect(input.className).toContain("focus:ring-blue-500");
  });
});
