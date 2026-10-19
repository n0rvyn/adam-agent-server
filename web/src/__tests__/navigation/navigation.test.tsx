import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { Layout } from "@/components/layout/Layout";
import { App } from "@/App";

const ROUTE_RENDER_TIMEOUT_MS = 15000;

describe("Navigation", () => {
  describe("Sidebar", () => {
    it("should render brand name", () => {
      render(
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>,
      );
      expect(screen.getByText("Adam")).toBeInTheDocument();
    });

    it("should render all navigation links", () => {
      render(
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>,
      );
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.getByText("Work")).toBeInTheDocument();
      expect(screen.getByText("Plugins")).toBeInTheDocument();
      expect(screen.getByText("Strategies")).toBeInTheDocument();
      expect(screen.getByText("Logs")).toBeInTheDocument();
    });

    it("should have nav element with navigation role", () => {
      render(
        <MemoryRouter>
          <Sidebar />
        </MemoryRouter>,
      );
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });
  });

  describe("Layout", () => {
    it("should show connection status", () => {
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      // Default state is disconnected
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });

    it("should have hamburger menu button on mobile", () => {
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });

    it("should have skip to content link", () => {
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      expect(screen.getByText("Skip to content")).toBeInTheDocument();
    });

    it("should have main content area", () => {
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      expect(screen.getByRole("main")).toBeInTheDocument();
    });
  });

  describe("Route Integration", () => {
    const routeTests = [
      { path: "/", pageTitle: "Dashboard" },
      { path: "/work", pageTitle: "Work" },
      { path: "/strategies", pageTitle: "Strategies" },
      { path: "/goals", pageTitle: "Goals" },
      { path: "/plugins", pageTitle: "Plugins" },
      { path: "/logs", pageTitle: "Logs" },
      { path: "/roles", pageTitle: "Roles" },
    ];

    for (const { path, pageTitle } of routeTests) {
      it(`should render ${pageTitle} page at ${path}`, async () => {
        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );
        expect(
          await screen.findByRole("heading", { level: 1, name: pageTitle }, { timeout: ROUTE_RENDER_TIMEOUT_MS }),
        ).toBeInTheDocument();
      });
    }

    it("should render TaskDetail page at /tasks/:id", async () => {
      render(
        <MemoryRouter initialEntries={["/tasks/task-001"]}>
          <App />
        </MemoryRouter>,
      );
      expect(
        await screen.findByRole("heading", { level: 1, name: "Task Detail" }, { timeout: ROUTE_RENDER_TIMEOUT_MS }),
      ).toBeInTheDocument();
    });

    it("should render breadcrumb (section / title) in header and only one h1 per page", async () => {
      render(
        <MemoryRouter initialEntries={["/roles"]}>
          <App />
        </MemoryRouter>,
      );
      await screen.findByRole("heading", { level: 1, name: "Roles" }, { timeout: ROUTE_RENDER_TIMEOUT_MS });
      // Exactly one <h1> per page (header is breadcrumb only, PageHeader owns h1)
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      // Header breadcrumb shows section label "Identities" (route meta); both
      // PageHeader eyebrow and Layout header render it, so we expect at least one.
      expect(screen.getAllByText("Identities").length).toBeGreaterThan(0);
    });
  });
});
