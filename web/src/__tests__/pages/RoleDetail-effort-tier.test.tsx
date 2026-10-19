/**
 * Tests for the effortTier dropdown in RoleDetail ExecutionConfigCard (Task 7).
 *
 * Covers:
 * - Dropdown renders with current effortTier value
 * - Changing effortTier and saving sends correct PATCH body
 * - Empty/null effortTier is represented as "" in the dropdown
 *
 * Approach: mock `api` at module scope with shared mutable references so the mock
 * is in place BEFORE RoleDetail is imported. MSW handles the GET /roles/:id
 * intercept (overrides default fixture handler). No vi.doMock needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { Role } from "@/lib/types";
import { server } from "../msw/server";

// ---------------------------------------------------------------------------
// Shared mutable mock state — set by each test, read by the module-level mock
// ---------------------------------------------------------------------------
// roleToReturn: controls what GET /roles/:id returns
// patchBodyCapture: written by the PATCH handler in api mock
// deleteRoleImpl: controls deleteRole behavior in the store mock
// ---------------------------------------------------------------------------
const mockState = {
  roleToReturn: null as Role | null,
  patchBodyCapture: undefined as Record<string, unknown> | undefined,
  updateRoleImpl: vi.fn<[string, Record<string, unknown>], Promise<Role>>(),
  deleteRoleImpl: vi.fn<[string, boolean?], Promise<{ roleId: string; deleted: boolean }>>(),
};

beforeEach(() => {
  mockState.roleToReturn = null;
  mockState.patchBodyCapture = undefined;
  mockState.updateRoleImpl.mockImplementation(async () => (mockState.roleToReturn ?? baseRole) as Role);
  mockState.deleteRoleImpl.mockResolvedValue({ roleId: "role-001", deleted: true });
});

afterEach(() => {
  vi.clearAllMocks();
  server.resetHandlers();
});

// ---------------------------------------------------------------------------
// Module-level api mock — replaces the real api for ALL tests
// ---------------------------------------------------------------------------
// Must be declared at module scope (before the RoleDetail import below) so
// the mock is active when RoleDetail's top-level api import is resolved.
vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "PATCH" && path.startsWith("/roles/")) {
      if (options.body) {
        const raw = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        mockState.patchBodyCapture = JSON.parse(raw) as Record<string, unknown>;
      }
      return { role: mockState.roleToReturn ?? baseRole };
    }
    if (path === "/roles/role-001") {
      return {
        role: mockState.roleToReturn ?? baseRole,
        projectPlugins: [],
        workspacePath: "",
      };
    }
    if (path === "/tasks") return { tasks: [], total: 0 };
    if (path === "/goals") return { goals: [] };
    if (path === "/strategies") return { strategies: [] };
    if (path === "/evolution-audit") return [];
    if (path === "/roles/role-001/scores") {
      return {
        scores: [],
        latestEma: null,
        contractCompliance: { emaScore: null, recentViolations: [], contractsCheckedRowCount: 0 },
      };
    }
    if (path === "/config") {
      return {
        config: {},
        mutable: [],
        restartRequired: [],
        sandbox: { platform: "darwin", available: true },
        osCapabilities: { registry: [] },
      };
    }
    throw new Error(`api mock: unhandled path ${path}`);
  }),
  // Phase 2: BoundExtensionsCard calls these on mount — stub to empty so
  // the component renders without ECONNREFUSED.
  listRoleExtensions: vi.fn().mockResolvedValue([]),
  listExtensions: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Shared role data
// ---------------------------------------------------------------------------
const baseRole: Role = {
  id: "role-001",
  name: "Engineer",
  cagPrompt: "You are a senior engineer focused on clean code.",
  learnedRules: { stylePreferences: ["Write tests first"], avoidedActions: [], pinnedParameters: [] },
  memoryStreamId: "mem-001",
  status: "active",
  performanceScore: 0.92,
  preferences: { effort: "high" },
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 86_400_000,
  osCapabilities: [{ id: "automation", targets: ["com.apple.mail"] }],
};

// ---------------------------------------------------------------------------
// Store mock — replaces useAppStore so RoleDetail can render without a real store
// ---------------------------------------------------------------------------
vi.mock("@/store/useAppStore", () => ({
  useAppStore: Object.assign(
    (selector?: (state: ReturnType<typeof useAppStore.getState>) => unknown) => {
      const state = {
        updateRole: mockState.updateRoleImpl,
        deleteRole: mockState.deleteRoleImpl,
        setState: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        updateRole: mockState.updateRoleImpl,
        deleteRole: mockState.deleteRoleImpl,
      }),
      setState: vi.fn(),
    },
  ),
}));

// Import AFTER mocks are declared (vi.mock hoisting handles this)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { useAppStore } = vi.mocked(await import("@/store/useAppStore"));
void useAppStore;

// ---------------------------------------------------------------------------
// Import RoleDetail — AFTER module mocks are in place
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { RoleDetail } = await import("@/pages/RoleDetail");

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------
/**
 * Set the role that loadRole() will return for the current test.
 * MUST be called before render() in the test body.
 */
function setRole(role: Role) {
  mockState.roleToReturn = role;
}

/**
 * Find the Effort Tier select using label traversal.
 * Labels have no `for` attribute so getByRole("combobox", { name }) does not work.
 */
function getEffortTierSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) => {
    const label = s.closest("div")?.querySelector("label");
    return label?.textContent?.includes("Tier");
  });
  if (!found) throw new Error("Effort Tier select not found in DOM");
  return found;
}

function getModeSelect(): HTMLSelectElement {
  const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
  const found = selects.find((s) => {
    const label = s.closest("div")?.querySelector("label");
    return label?.textContent?.includes("Mode");
  });
  if (!found) throw new Error("Mode select not found in DOM");
  return found;
}

/**
 * Wait for the ExecutionConfigCard to be visible and the effortTier state
 * to match the expected value. The effortTier state syncs via useEffect after
 * loadRole resolves (api mock is synchronous so this is nearly immediate).
 */
async function waitForEffortTierValue(user: ReturnType<typeof userEvent.setup>, expectedValue: string) {
  // Click the "Execution Config" card title to expand it
  const execConfigCard = await screen.findByText("Execution Config");
  await user.click(execConfigCard);
  // Wait for Mode select (card content visible)
  await waitFor(() => { getModeSelect(); });
  // Wait for effortTier to sync from role
  await waitFor(
    () => {
      const select = getEffortTierSelect();
      if (select.value !== expectedValue) {
        throw new Error(`effortTier="${select.value}", expected="${expectedValue}"`);
      }
    },
    { timeout: 3000 },
  );
}

function renderRoleDetail() {
  return render(
    <MemoryRouter initialEntries={["/roles/role-001"]}>
      <Routes>
        <Route path="/roles" element={<div>Roles</div>} />
        <Route path="/roles/:id" element={<RoleDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("RoleDetail ExecutionConfigCard effortTier", () => {
  it("renders effortTier dropdown with medium selected when role has effortTier: 'medium'", async () => {
    const user = userEvent.setup();
    setRole({ ...baseRole, effortTier: "medium" });
    renderRoleDetail();
    await waitForEffortTierValue(user, "medium");
    expect(getEffortTierSelect().value).toBe("medium");
  });

  it("renders effortTier dropdown with empty value when role has no effortTier", async () => {
    const user = userEvent.setup();
    setRole(baseRole); // baseRole has no effortTier
    renderRoleDetail();
    await waitForEffortTierValue(user, "");
    expect(getEffortTierSelect().value).toBe("");
  });

  it("changing effortTier from medium to high sends PATCH with effortTier: 'high'", async () => {
    const user = userEvent.setup();
    setRole({ ...baseRole, effortTier: "medium" });
    renderRoleDetail();
    await waitForEffortTierValue(user, "medium");

    // Change to "high"
    const effortSelect = getEffortTierSelect();
    expect(effortSelect.value).toBe("medium"); // sanity
    await user.selectOptions(effortSelect, "high");

    // Click Save
    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    // PATCH body captured by the api mock
    await waitFor(() => {
      expect(mockState.patchBodyCapture).toBeDefined();
    });
    expect(mockState.patchBodyCapture!.effortTier).toBe("high");
  });

  it("setting effortTier from low to empty sends PATCH with effortTier: null", async () => {
    const user = userEvent.setup();
    setRole({ ...baseRole, effortTier: "low" });
    renderRoleDetail();
    await waitForEffortTierValue(user, "low");

    const effortSelect = getEffortTierSelect();
    expect(effortSelect.value).toBe("low"); // sanity
    await user.selectOptions(effortSelect, "");

    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockState.patchBodyCapture).toBeDefined();
    });
    expect(mockState.patchBodyCapture!.effortTier).toBeNull();
  });

  it("setting effortTier from empty to low sends PATCH with effortTier: 'low'", async () => {
    const user = userEvent.setup();
    setRole(baseRole); // no effortTier → empty string
    renderRoleDetail();
    await waitForEffortTierValue(user, "");

    const effortSelect = getEffortTierSelect();
    expect(effortSelect.value).toBe(""); // sanity
    await user.selectOptions(effortSelect, "low");

    const saveButton = screen.getByRole("button", { name: /save/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockState.patchBodyCapture).toBeDefined();
    });
    expect(mockState.patchBodyCapture!.effortTier).toBe("low");
  });
});
