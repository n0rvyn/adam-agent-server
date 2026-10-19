import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Layout } from "@/components/layout/Layout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Chat } from "@/pages/Chat";
import { MemoryRouter } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useChatStore } from "@/store/useChatStore";

describe("Responsive Behavior", () => {
  describe("Layout Structure", () => {
    it("should have desktop sidebar container with hidden lg:block classes", () => {
      const { container } = render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      const desktopSidebar = container.querySelector(".hidden.lg\\:block");
      expect(desktopSidebar).toBeInTheDocument();
    });

    it("should have hamburger button with lg:hidden class", () => {
      const { container } = render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      const hamburger = container.querySelector("button.lg\\:hidden");
      expect(hamburger).toBeInTheDocument();
    });

    it("should toggle mobile sidebar overlay on hamburger click", () => {
      const { container } = render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );

      // Initially no overlay
      expect(container.querySelector(".fixed.inset-0")).not.toBeInTheDocument();

      // Click hamburger
      const hamburger = screen.getByLabelText("Open menu");
      fireEvent.click(hamburger);

      // Overlay should appear
      expect(container.querySelector(".fixed.inset-0")).toBeInTheDocument();
    });

    it("should close mobile sidebar when overlay clicked", () => {
      const { container } = render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );

      // Open sidebar
      fireEvent.click(screen.getByLabelText("Open menu"));
      expect(container.querySelector(".fixed.inset-0")).toBeInTheDocument();

      // Click the backdrop overlay
      const backdrop = container.querySelector(".absolute.inset-0.bg-black\\/60");
      if (backdrop) {
        fireEvent.click(backdrop);
        expect(container.querySelector(".fixed.inset-0")).not.toBeInTheDocument();
      }
    });
  });

  describe("Connection Status", () => {
    it("should show Connected when wsConnected is true", () => {
      useAppStore.setState({ wsConnected: true });
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("should show Disconnected when wsConnected is false", () => {
      useAppStore.setState({ wsConnected: false });
      render(
        <MemoryRouter>
          <Layout />
        </MemoryRouter>,
      );
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });
  });

  describe("Page Shell Rhythm", () => {
    it("page headers keep stacked-to-row responsive classes and metric wraps", () => {
      const { container } = render(
        <PageHeader
          title="Responsive Header"
          description="Header content should wrap on small screens and align on large screens."
          metrics={[
            { label: "Active", value: 3 },
            { label: "Queued", value: 1 },
          ]}
        />,
      );

      expect(container.querySelector(".flex.flex-col.lg\\:flex-row.lg\\:justify-between")).toBeInTheDocument();
      expect(container.querySelector(".flex.flex-wrap.gap-x-4.gap-y-2.pt-1")).toBeInTheDocument();
    });

    it("chat keeps a dedicated desktop sidebar shell, mobile session action, and elevated composer container", () => {
      useChatStore.setState({
        sessions: [],
        activeSessionId: null,
        messages: [],
        sending: false,
        fetchSessions: async () => {},
        sendMessage: async () => {},
        createSession: async () => undefined as never,
        archiveSession: async () => undefined as never,
        restoreSession: async () => undefined as never,
        deleteSession: async () => undefined as never,
        setActiveSession: () => {},
        connectChatStream: () => {},
        disconnectChatStream: () => {},
      });

      const { container } = render(
        <MemoryRouter>
          <Chat />
        </MemoryRouter>,
      );

      expect(container.querySelector(".hidden.w-72.flex-shrink-0.border-r")).toBeInTheDocument();
      expect(container.querySelector(".surface-panel-elevated.rounded-xl.p-3")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manage sessions" })).toBeInTheDocument();
    });
  });
});
