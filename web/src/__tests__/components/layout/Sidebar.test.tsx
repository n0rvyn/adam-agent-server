import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { navigationItems } from "@/lib/navigation";

describe("Sidebar", () => {
  it("renders 18 nav links in single-line structure (label only, no inline description)", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    expect(navigationItems).toHaveLength(18);

    for (const { label, description } of navigationItems) {
      // label is visible
      expect(screen.getByText(label)).toBeInTheDocument();
      // description is NOT rendered inline (it only appears in tooltip on hover)
      expect(screen.queryByText(description)).not.toBeInTheDocument();
    }
  });

  it("exposes description via Radix tooltip on hover", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const firstItem = navigationItems[0];
    const link = screen.getByText(firstItem.label);

    await user.hover(link);

    await waitFor(() => {
      // Radix Tooltip renders into a portal; the description text appears after delay
      const matches = screen.queryAllByText(firstItem.description);
      expect(matches.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
  });

  it("uses w-64 width (DP-002)", () => {
    const { container } = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain("w-64");
  });

  it("does not use hardcoded ring-offset-slate-950 (uses app-canvas token)", () => {
    const { container } = render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );

    // Dump all nav link classes; none should contain the old slate-950 offset.
    const links = container.querySelectorAll("a[href]");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).not.toContain("ring-offset-slate-950");
    }
  });
});
