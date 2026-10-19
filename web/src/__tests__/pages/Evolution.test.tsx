import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "../utils/test-utils";
import { Evolution } from "@/pages/Evolution";
import { useAppStore } from "@/store/useAppStore";
import { mockRoles } from "../fixtures";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

import { api } from "@/lib/api";
const mockApi = api as ReturnType<typeof vi.fn>;

const mockEvolutionRecords = [
  {
    id: "evo-1", timestamp: Date.now() - 3600000,
    oldRules: "Be careful with imports", newRules: "Be careful with imports\nAlways check return types",
    diff: "+ Always check return types",
    triggerTaskId: "task-001", roleId: "role-001",
  },
  {
    id: "evo-2", timestamp: Date.now() - 7200000,
    oldRules: "", newRules: "Use structured logging",
    diff: "+ Use structured logging",
    roleId: "role-002",
  },
];

describe("Evolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ roles: mockRoles });
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/evolution-audit")) return Promise.resolve(mockEvolutionRecords);
      if (url === "/roles") return Promise.resolve({ roles: mockRoles });
      return Promise.resolve({});
    });
  });

  it("renders page title", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("Evolution Audit")).toBeInTheDocument();
    });
  });

  it("shows role filter dropdown", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("All roles")).toBeInTheDocument();
    });
  });

  it("renders evolution records with diffs", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("+ Always check return types")).toBeInTheDocument();
      expect(screen.getByText("+ Use structured logging")).toBeInTheDocument();
    });
  });

  it("shows role names for records", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("Engineer")).toBeInTheDocument();
      expect(screen.getByText("Reviewer")).toBeInTheDocument();
    });
  });

  it("shows record count", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("2 records")).toBeInTheDocument();
    });
  });

  it("shows empty state when no records", async () => {
    mockApi.mockImplementation((url: string) => {
      if (url.startsWith("/evolution-audit")) return Promise.resolve([]);
      if (url === "/roles") return Promise.resolve({ roles: mockRoles });
      return Promise.resolve({});
    });
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText("No evolution records")).toBeInTheDocument();
    });
  });

  it("shows trigger task ID", async () => {
    render(<Evolution />);
    await waitFor(() => {
      expect(screen.getByText(/task-001/)).toBeInTheDocument();
    });
  });
});
