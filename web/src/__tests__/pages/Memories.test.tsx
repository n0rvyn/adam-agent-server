import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "../utils/test-utils";
import { Memories } from "@/pages/Memories";
import { useAppStore } from "@/store/useAppStore";
import { mockRoles } from "../fixtures";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

import { api } from "@/lib/api";
const mockApi = api as ReturnType<typeof vi.fn>;

const mockMemories = [
  {
    id: "mem-1", agentId: "agent-001", type: "event", content: "Completed deployment task",
    keywords: ["deploy", "task"], importance: 4, sourceType: "task_complete",
    createdAt: Date.now() - 3600000, lastAccessed: Date.now() - 1800000, retrievedCount: 3,
  },
  {
    id: "mem-2", agentId: "agent-001", type: "reflection", content: "Should use type guards more often",
    keywords: ["types", "guard"], importance: 3, sourceType: "reflection",
    createdAt: Date.now() - 7200000, lastAccessed: Date.now() - 3600000, retrievedCount: 1,
  },
];

describe("Memories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ roles: mockRoles });
    // Handle different API endpoints
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/memories/")) return Promise.resolve({ memories: mockMemories });
      if (url === "/roles") return Promise.resolve({ roles: mockRoles });
      return Promise.resolve({});
    });
  });

  it("renders page title", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("Memories")).toBeInTheDocument();
    });
  });

  it("shows role selector", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toHaveValue("role-001");
      expect(screen.getByRole("option", { name: "Engineer" })).toBeInTheDocument();
    });
  });

  it("renders memory cards", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("Completed deployment task")).toBeInTheDocument();
      expect(screen.getByText("Should use type guards more often")).toBeInTheDocument();
    });
  });

  it("shows memory type badges", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("event")).toBeInTheDocument();
      // "reflection" appears in both type badge and sourceType badge
      expect(screen.getAllByText("reflection").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows importance filter buttons", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("all")).toBeInTheDocument();
      expect(screen.getByText("high")).toBeInTheDocument();
      expect(screen.getByText("medium")).toBeInTheDocument();
      expect(screen.getByText("low")).toBeInTheDocument();
    });
  });

  it("shows search input", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search memories...")).toBeInTheDocument();
    });
  });

  it("shows empty state when no memories", async () => {
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/memories/")) return Promise.resolve({ memories: [] });
      if (url === "/roles") return Promise.resolve({ roles: mockRoles });
      return Promise.resolve({});
    });
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("No memories")).toBeInTheDocument();
    });
  });

  it("shows memory count", async () => {
    render(<Memories />);
    await waitFor(() => {
      expect(screen.getByText("2 memories")).toBeInTheDocument();
    });
  });
});
