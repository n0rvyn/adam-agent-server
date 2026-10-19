import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render, screen } from "../../utils/test-utils";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/Card";

describe("Card", () => {
  it("renders with padding by default", () => {
    render(<Card data-testid="card">Content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).toContain("p-4");
  });

  it("renders without padding when padding={false}", () => {
    render(<Card data-testid="card" padding={false}>Content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).not.toContain("p-4");
  });

  it("uses semantic surface styling", () => {
    render(<Card data-testid="card">Content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).toContain("surface-panel");
    expect(card.className).toContain("rounded-xl");
  });

  it("merges custom className", () => {
    render(<Card data-testid="card" className="custom">Content</Card>);
    expect(screen.getByTestId("card").className).toContain("custom");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>Content</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("CardHeader", () => {
  it("renders with flex layout", () => {
    render(<CardHeader data-testid="header">Header</CardHeader>);
    expect(screen.getByTestId("header").className).toContain("flex");
    expect(screen.getByTestId("header").className).toContain("items-start");
  });
});

describe("CardTitle", () => {
  it("renders as h3", () => {
    render(<CardTitle>Title</CardTitle>);
    const title = screen.getByText("Title");
    expect(title.tagName).toBe("H3");
    expect(title.className).toContain("text-[var(--app-text)]");
  });
});

describe("CardDescription", () => {
  it("renders as p with muted text", () => {
    render(<CardDescription>Desc</CardDescription>);
    const desc = screen.getByText("Desc");
    expect(desc.tagName).toBe("P");
    expect(desc.className).toContain("text-[var(--app-text-muted)]");
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<CardContent>Inner</CardContent>);
    expect(screen.getByText("Inner")).toBeInTheDocument();
  });
});

describe("CardFooter", () => {
  it("renders with flex layout", () => {
    render(<CardFooter data-testid="footer">Footer</CardFooter>);
    expect(screen.getByTestId("footer").className).toContain("flex");
    expect(screen.getByTestId("footer").className).toContain("pt-3");
  });
});

describe("className merge on sub-components", () => {
  it("CardHeader merges custom className", () => {
    render(<CardHeader data-testid="h" className="custom">H</CardHeader>);
    const el = screen.getByTestId("h");
    expect(el.className).toContain("custom");
    expect(el.className).toContain("flex");
  });

  it("CardTitle merges custom className", () => {
    render(<CardTitle className="custom">T</CardTitle>);
    const el = screen.getByText("T");
    expect(el.className).toContain("custom");
    expect(el.className).toContain("text-[var(--app-text)]");
  });

  it("CardDescription merges custom className", () => {
    render(<CardDescription className="custom">D</CardDescription>);
    const el = screen.getByText("D");
    expect(el.className).toContain("custom");
  });

  it("CardContent merges custom className", () => {
    render(<CardContent data-testid="c" className="custom">C</CardContent>);
    expect(screen.getByTestId("c").className).toContain("custom");
  });

  it("CardFooter merges custom className", () => {
    render(<CardFooter data-testid="f" className="custom">F</CardFooter>);
    const el = screen.getByTestId("f");
    expect(el.className).toContain("custom");
    expect(el.className).toContain("flex");
  });
});

describe("displayName", () => {
  it.each([
    [Card, "Card"],
    [CardHeader, "CardHeader"],
    [CardTitle, "CardTitle"],
    [CardDescription, "CardDescription"],
    [CardContent, "CardContent"],
    [CardFooter, "CardFooter"],
  ])("%s has displayName '%s'", (component, name) => {
    expect(component.displayName).toBe(name);
  });
});
