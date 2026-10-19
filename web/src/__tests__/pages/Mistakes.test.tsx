import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "../utils/test-utils";
import userEvent from "@testing-library/user-event";
import { Mistakes } from "@/pages/Mistakes";
import { server } from "../msw/server";
import { http, HttpResponse } from "msw";

// The global MSW server is already started in setup.ts with the full handler set
// (including mistake-patterns handlers). We override handlers per-test using
// server.use() which patches handlers at runtime without module reload.

describe("Mistakes page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state on mount", async () => {
    render(<Mistakes />);
    // Loading state shown before fetch resolves
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders 2 mocked patterns after fetch resolves", async () => {
    render(<Mistakes />);
    await waitFor(() => {
      expect(screen.getByText("audit:score_degradation")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("file-read on /etc/passwd")).toBeInTheDocument();
    });
  });

  it("status filter click re-fetches with correct URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<Mistakes />);

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText("audit:score_degradation")).toBeInTheDocument();
    });

    // Reset spy after initial fetch
    fetchSpy.mockClear();

    // Click the "new" filter button
    const newBtn = screen.getByRole("button", { name: /^New$/ });
    await userEvent.click(newBtn);

    // Next fetch should have ?status=new
    await waitFor(() => {
      const newFetchCall = fetchSpy.mock.calls.find((call) =>
        String(call[0]).includes("/mistake-patterns"),
      );
      expect(newFetchCall).toBeDefined();
      expect(newFetchCall![0]).toContain("status=new");
    });

    fetchSpy.mockRestore();
  });

  it("row click expands to show evidence detail", async () => {
    render(<Mistakes />);
    await waitFor(() => {
      expect(screen.getByText("audit:score_degradation")).toBeInTheDocument();
    });

    // Click the first pattern row
    const firstRow = screen.getByText("audit:score_degradation").closest("[role='button']");
    expect(firstRow).toBeTruthy();
    await userEvent.click(firstRow!);

    await waitFor(() => {
      expect(screen.getByText("Affected Roles")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Evidence Items")).toBeInTheDocument();
    });
  });

  it("Acknowledge button calls PATCH with correct status", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<Mistakes />);
    await waitFor(() => {
      expect(screen.getByText("new")).toBeInTheDocument();
    });

    // Expand the first row and wait for it to fully render
    const firstRow = screen.getByText("audit:score_degradation").closest("[role='button']");
    expect(firstRow).toBeTruthy();
    await userEvent.click(firstRow!);

    // Wait for the expanded section to be visible (contains "Affected Roles" heading)
    await waitFor(() => {
      expect(screen.getByText("Affected Roles")).toBeInTheDocument();
    });

    // Find the "Acknowledged" action button (the one inside the expanded panel).
    // Both the status badge and action button say "Acknowledged" — pick the last one (the action button in the panel)
    const ackButtons = screen.getAllByRole("button", { name: "Acknowledged" });
    const panelButton = ackButtons[ackButtons.length - 1];
    await userEvent.click(panelButton);

    // PATCH should be called with correct body
    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        (call) =>
          String(call[0]).includes("/mistake-patterns/") &&
          (call[1] as { method?: string })?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(
        ((patchCall![1] as { body?: string })?.body ?? "{}"),
      );
      expect(body.status).toBe("acknowledged");
    });

    fetchSpy.mockRestore();
  });

  it("EmptyState renders when zero patterns", async () => {
    // Override the global handler to return empty list
    server.use(
      http.get("/mistake-patterns", () =>
        HttpResponse.json({ mistakePatterns: [] }),
      ),
    );

    render(<Mistakes />);
    await waitFor(() => {
      expect(screen.getByText("No mistake patterns")).toBeInTheDocument();
    });

    // Reset handler so other tests aren't affected
    server.resetHandlers();
  });
});
