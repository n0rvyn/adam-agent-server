import { describe, it, expect } from "vitest";
import { render, screen } from "../../utils/test-utils";
import { EmptyState } from "@/components/ui/EmptyState";

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="No items" />);
    expect(screen.getByText("No items")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<EmptyState title="Empty" description="Nothing here yet" />);
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("renders icon when provided", () => {
    render(<EmptyState title="Empty" icon={<span data-testid="icon">!</span>} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    render(<EmptyState title="Empty" action={<button>Add</button>} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<EmptyState title="Empty" className="my-class" />);
    expect(container.firstElementChild?.className).toContain("my-class");
  });

  it("has centered layout", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.firstElementChild?.className).toContain("items-center");
    expect(container.firstElementChild?.className).toContain("text-center");
  });

  it("renders icon above title", () => {
    const { container } = render(
      <EmptyState title="Empty" icon={<span data-testid="icon">!</span>} />,
    );
    const wrapper = container.firstElementChild!;
    const iconDiv = wrapper.children[0]!;
    const titleEl = wrapper.children[1]!;
    expect(iconDiv.querySelector('[data-testid="icon"]')).toBeTruthy();
    expect(titleEl.textContent).toBe("Empty");
  });
});
