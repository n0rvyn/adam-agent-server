// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForInputReady, waitForRender } from "../../helpers/tui.js";

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
}));

import { request } from "../../../cli/client.js";
import { RoleDetail } from "../../../cli/tui/components/RoleDetail.js";

const mockRequest = request as ReturnType<typeof vi.fn>;

const TEST_ROLE_ID = "role-1";
const TEST_ROLE = {
  id: TEST_ROLE_ID,
  name: "TestRole",
  cagPrompt: "",
  learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
  status: "active" as const,
  allowedTools: [],
  envVars: {},
  createdAt: Date.now(),
  importanceTriggerCurr: 0,
  permissionMode: "default" as const,
  executionMode: "inline" as const,
  inheritUserSettings: true,
  allowedBashPatterns: [],
  deniedBashPatterns: [],
};
const TEST_WORKSPACE = "/home/user/.adam/roles/TestRole";

describe("RoleDetail plugin binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("3.1 — renders bound plugins in view mode", () => {
    it("shows plugin names when projectPlugins are present", async () => {
      mockRequest.mockImplementation((path: string) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [
              { id: "pkos@indie-toolkit", name: "pkos", version: "0.6.0" },
              { id: "domain-intel@indie-toolkit", name: "domain-intel", version: "1.5.0" },
            ],
            workspacePath: TEST_WORKSPACE,
          });
        }
        return Promise.resolve({ config: {}, mutable: [], restartRequired: [] });
      });

      const { lastFrame } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForRender();

      const frame = lastFrame()!;
      expect(frame).toContain("pkos");
      expect(frame).toContain("domain-intel");
    });

    it("shows 'None' when no plugins are bound", async () => {
      mockRequest.mockImplementation((path: string) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [],
            workspacePath: TEST_WORKSPACE,
          });
        }
        return Promise.resolve({ config: {}, mutable: [], restartRequired: [] });
      });

      const { lastFrame } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForRender();

      expect(lastFrame()).toContain("None");
    });

    it("shows hint to press B to manage plugins", async () => {
      mockRequest.mockImplementation((path: string) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [],
            workspacePath: TEST_WORKSPACE,
          });
        }
        return Promise.resolve({ config: {}, mutable: [], restartRequired: [] });
      });

      const { lastFrame } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForRender();

      expect(lastFrame()).toContain("b:plugins");
    });
  });

  describe("3.2 — bind flow calls correct endpoint with correct body", () => {
    it("pressing b then a then Enter calls POST /plugins/install/:id with scope=project and cwd=workspacePath", async () => {
      const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];

      mockRequest.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
        // Capture all calls
        apiCalls.push({ method: opts?.method ?? "GET", path, body: opts?.body });

        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [],
            workspacePath: TEST_WORKSPACE,
          });
        }
        if (path === "/plugins") {
          return Promise.resolve({
            plugins: [
              { id: "pkos@indie-toolkit", name: "pkos", version: "0.6.0" },
            ],
          });
        }
        // Install call — resolve to trigger reload
        return Promise.resolve({ success: true });
      });

      const { stdin } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      // Press 'b' to enter edit-plugins mode
      stdin.write("b");
      await waitForRender();

      // Press 'a' to enter add mode (fetches /plugins)
      stdin.write("a");
      await waitForRender();
      // Give async fetch time to resolve
      await waitForRender();

      // Press Enter to install
      stdin.write("\r");
      await waitForRender();

      // Verify correct endpoint was called
      const installCalls = apiCalls.filter(
        (c) => c.method === "POST" && c.path.includes("/plugins/install/"),
      );
      expect(installCalls).toHaveLength(1);
      // Body is stringified by request()
      const expectedBody = JSON.stringify({ scope: "project", cwd: TEST_WORKSPACE });
      expect(installCalls[0]!.body).toEqual(expectedBody);

      // Regression guard: wrong endpoint NOT called
      const wrongCalls = apiCalls.filter(
        (c) =>
          (c.path.includes("/plugins/") && !c.path.includes("/plugins/install/") && !c.path.includes("/plugins/uninstall/")) ||
          c.method === "DELETE",
      );
      expect(wrongCalls).toHaveLength(0);
    });

    it("no install call when Esc is pressed in add mode", async () => {
      const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];

      mockRequest.mockImplementation((path: string) => {
        apiCalls.push({ method: "GET", path, body: undefined });
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [],
            workspacePath: TEST_WORKSPACE,
          });
        }
        if (path === "/plugins") {
          return Promise.resolve({ plugins: [{ id: "pkos", name: "pkos", version: "0.6.0" }] });
        }
        return Promise.resolve({ success: true });
      });

      const { stdin } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      stdin.write("b");
      await waitForRender();
      stdin.write("a");
      await waitForRender();
      await waitForRender();

      // Press Esc — should return to edit-plugins without installing
      stdin.write("\x1B");
      await waitForRender();

      const installCalls = apiCalls.filter(
        (c) => c.method === "POST" && c.path.includes("/plugins/install/"),
      );
      expect(installCalls).toHaveLength(0);
    });
  });

  describe("3.3 — unbind flow calls correct endpoint with correct body", () => {
    it("pressing b then x calls POST /plugins/uninstall/:id with scope=project and cwd=workspacePath", async () => {
      const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];

      mockRequest.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [
              { id: "pkos@indie-toolkit", name: "pkos", version: "0.6.0" },
            ],
            workspacePath: TEST_WORKSPACE,
          });
        }
        // Capture all calls including POST
        apiCalls.push({ method: opts?.method ?? "GET", path, body: opts?.body });
        return Promise.resolve({ success: true });
      });

      const { stdin } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      // Press 'b' to enter edit-plugins mode
      stdin.write("b");
      await waitForRender();

      // Press 'x' to uninstall first bound plugin
      stdin.write("x");
      await waitForRender();

      // Verify correct endpoint was called
      const uninstallCalls = apiCalls.filter(
        (c) => c.method === "POST" && c.path.includes("/plugins/uninstall/"),
      );
      expect(uninstallCalls).toHaveLength(1);
      // Body is stringified by request()
      const expectedBody = JSON.stringify({ scope: "project", cwd: TEST_WORKSPACE });
      expect(uninstallCalls[0]!.body).toEqual(expectedBody);

      // Regression guard: DELETE NOT used
      const deleteCalls = apiCalls.filter((c) => c.method === "DELETE");
      expect(deleteCalls).toHaveLength(0);
    });

    it("no uninstall call when Esc is pressed in edit-plugins mode", async () => {
      const apiCalls: Array<{ method: string; path: string }> = [];

      mockRequest.mockImplementation((path: string) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [
              { id: "pkos@indie-toolkit", name: "pkos", version: "0.6.0" },
            ],
            workspacePath: TEST_WORKSPACE,
          });
        }
        apiCalls.push({ method: "GET", path });
        return Promise.resolve({ success: true });
      });

      const { stdin } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      stdin.write("b");
      await waitForRender();

      // Press Esc — should return to view without uninstalling
      stdin.write("\x1B");
      await waitForRender();

      const uninstallCalls = apiCalls.filter(
        (c) => c.path.includes("/plugins/uninstall/"),
      );
      expect(uninstallCalls).toHaveLength(0);
    });
  });

  describe("3.4 — Esc returns to view mode without side effects", () => {
    it("Esc in edit-plugins returns to view without calling any plugin API", async () => {
      const apiCalls: Array<{ path: string }> = [];

      mockRequest.mockImplementation((path: string) => {
        apiCalls.push({ path });
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [
              { id: "pkos@indie-toolkit", name: "pkos", version: "0.6.0" },
            ],
            workspacePath: TEST_WORKSPACE,
          });
        }
        return Promise.resolve({ config: {}, mutable: [], restartRequired: [] });
      });

      const { stdin, lastFrame } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      stdin.write("b");
      await waitForRender();
      expect(lastFrame()).toContain("Plugins");

      stdin.write("\x1B");
      await waitForRender();
      expect(lastFrame()).toContain("TestRole");
      expect(lastFrame()).toContain("b:plugins");

      const pluginMutations = apiCalls.filter(
        (c) => c.path.includes("/plugins/install/") || c.path.includes("/plugins/uninstall/"),
      );
      expect(pluginMutations).toHaveLength(0);
    });
  });

  describe("3.5 — renders server projectPlugins field, not legacy boundPlugins", () => {
    it("shows plugins when server returns projectPlugins (no boundPlugins key in response)", async () => {
      mockRequest.mockImplementation((path: string) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          // Server returns projectPlugins — no boundPlugins key at all
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [
              { id: "session-reflect", name: "session-reflect", version: "2.0.1" },
            ],
            workspacePath: TEST_WORKSPACE,
          });
        }
        return Promise.resolve({ config: {}, mutable: [], restartRequired: [] });
      });

      const { lastFrame } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForRender();

      // If destructure used boundPlugins (old broken code), list would be empty
      expect(lastFrame()).toContain("session-reflect");
    });

    it("uses workspacePath from server response for install/uninstall body", async () => {
      const installBodies: unknown[] = [];

      mockRequest.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
        if (path === `/roles/${TEST_ROLE_ID}`) {
          return Promise.resolve({
            role: TEST_ROLE,
            projectPlugins: [],
            workspacePath: "/custom/workspace/path",
          });
        }
        if (path === "/plugins") {
          return Promise.resolve({
            plugins: [{ id: "test-plugin", name: "test-plugin", version: "1.0.0" }],
          });
        }
        if (opts?.method === "POST") {
          installBodies.push(opts.body);
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({});
      });

      const { stdin } = render(<RoleDetail roleId={TEST_ROLE_ID} onBack={vi.fn()} />);
      await waitForInputReady();
      await waitForRender();

      stdin.write("b");
      await waitForRender();
      stdin.write("a");
      await waitForRender();
      await waitForRender();
      stdin.write("\r");
      await waitForRender();

      expect(installBodies).toContainEqual(
        JSON.stringify({ scope: "project", cwd: "/custom/workspace/path" }),
      );
    });
  });
});
