import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionItem } from "@/components/chat/SessionItem";

const baseSession = {
  id: "s1",
  title: "Test session",
  status: "active" as const,
  messageCount: 3,
  lastActiveAt: Date.now(),
  source: { type: "web" as const },
  createdAt: Date.now() - 1000,
};

function getOuterSessionButton(container: HTMLElement) {
  try {
    return screen.getByRole("button", { name: /Test session/i });
  } catch {
    const outer = container.querySelector('[role="button"][tabindex="0"]');
    if (!outer) throw new Error("Outer session button not found");
    return outer as HTMLElement;
  }
}

describe("SessionItem a11y", () => {
  it("activates onSelect when Enter is pressed on outer element", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SessionItem
        session={baseSession}
        isActive={false}
        onSelect={onSelect}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.keyDown(getOuterSessionButton(container), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("activates onSelect when Space is pressed on outer element", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <SessionItem
        session={baseSession}
        isActive={false}
        onSelect={onSelect}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.keyDown(getOuterSessionButton(container), { key: " " });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("inner archive button click does not bubble to onSelect", () => {
    const onSelect = vi.fn();
    const onArchive = vi.fn();

    render(
      <SessionItem
        session={baseSession}
        isActive={false}
        onSelect={onSelect}
        onArchive={onArchive}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Archive session" }));

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("exposes explicit labels for session actions", () => {
    render(
      <SessionItem
        session={baseSession}
        isActive
        onSelect={vi.fn()}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Archive session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete session" })).toBeInTheDocument();
  });
});
