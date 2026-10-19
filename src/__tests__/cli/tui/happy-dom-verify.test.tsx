// @vitest-environment happy-dom
/**
 * Verification test: confirms happy-dom + ink-testing-library infrastructure works.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { render } from "ink-testing-library";
import {
  createMockTuiState,
  resetTuiMocks,
  mockDispatch,
  mockRequest,
  createMockApproval,
  MockWebSocket,
  simulateKey,
  waitForInputReady,
  createMockRequest,
  renderWithContext,
  getMockState,
} from "../../helpers/tui.js";

// --- Mock hooks ---
const mockUseTuiState = vi.fn();

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => mockUseTuiState(),
  TuiProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock("../../../cli/tui/hooks/useServerConnection.js", () => ({
  useServerConnection: () => ({ connected: true, submitPrompt: vi.fn() }),
}));

vi.mock("../../../cli/tui/hooks/useGlobalEvents.js", () => ({
  useGlobalEvents: vi.fn(),
}));

vi.mock("../../../cli/tui/hooks/useTaskStream.js", () => ({
  useTaskStream: () => ({ events: [], isStreaming: false, clearEvents: vi.fn() }),
}));

vi.mock("../../../cli/client.js", () => ({
  request: vi.fn(),
  EventSocket: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn(),
  })),
  TaskStreamSocket: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  })),
}));

import { StatusBar } from "../../../cli/tui/components/StatusBar.js";

describe("TUI happy-dom infrastructure", () => {
  beforeEach(() => {
    resetTuiMocks();
    mockUseTuiState.mockImplementation(() => ({
      state: getMockState(),
      dispatch: mockDispatch,
    }));
  });

  it("renders StatusBar via ink-testing-library", () => {
    const { lastFrame } = render(React.createElement(StatusBar));
    const frame = lastFrame();
    expect(frame).toContain("Adam");
  });

  it("reflects state changes in output", () => {
    mockUseTuiState.mockReturnValue({
      state: createMockTuiState({ connected: false }),
      dispatch: mockDispatch,
    });
    const { lastFrame } = render(React.createElement(StatusBar));
    expect(lastFrame()).toContain("down");
  });

  it("mockRequest is callable", () => {
    mockRequest.mockResolvedValue({ tasks: [] });
    return expect(mockRequest("/tasks")).resolves.toEqual({ tasks: [] });
  });

  it("createMockRequest returns isolated mock", () => {
    const req = createMockRequest();
    req.mockResolvedValue({ ok: true });
    expect(req).not.toBe(mockRequest);
    return expect(req()).resolves.toEqual({ ok: true });
  });

  it("createMockApproval produces valid approval", () => {
    const approval = createMockApproval({ toolName: "Read" });
    expect(approval.toolName).toBe("Read");
    expect(approval.taskId).toBe("task-1");
  });

  describe("MockWebSocket", () => {
    it("supports connect/close/isConnected lifecycle", async () => {
      const ws = new MockWebSocket();
      expect(ws.isConnected()).toBe(false);
      await ws.connect();
      expect(ws.isConnected()).toBe(true);
      ws.close();
      expect(ws.isConnected()).toBe(false);
    });

    it("supports on/off/emit event handling", () => {
      const ws = new MockWebSocket();
      const handler = vi.fn();
      ws.on("test", handler);
      ws.emit("test", { msg: "hello" });
      expect(handler).toHaveBeenCalledWith({ msg: "hello" });

      ws.off("test", handler);
      ws.emit("test", { msg: "world" });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("simulateError sets disconnected", async () => {
      const ws = new MockWebSocket();
      await ws.connect();
      ws.simulateError(new Error("fail"));
      expect(ws.isConnected()).toBe(false);
    });
  });

  describe("simulateKey", () => {
    it("triggers useInput callback with key press", async () => {
      const onKey = vi.fn();

      function TestComponent() {
        useInput((input, key) => {
          onKey(input, key);
        });
        return React.createElement(Text, null, "test");
      }

      const { stdin } = render(React.createElement(TestComponent));
      await waitForInputReady();
      simulateKey(stdin, "q");
      expect(onKey).toHaveBeenCalledWith("q", expect.objectContaining({ escape: false }));
    });

    it("maps escape key correctly", async () => {
      const onKey = vi.fn();

      function TestComponent() {
        useInput((input, key) => {
          onKey(input, key);
        });
        return React.createElement(Text, null, "test");
      }

      const { stdin } = render(React.createElement(TestComponent));
      await new Promise((r) => setTimeout(r, 50));
      simulateKey(stdin, "escape");
      expect(onKey).toHaveBeenCalledWith("", expect.objectContaining({ escape: true }));
    });
  });

  describe("renderWithContext", () => {
    it("renders component with default state", () => {
      const { lastFrame } = renderWithContext(React.createElement(StatusBar), { version: "0.2.1" });
      expect(lastFrame()).toContain("Adam v0.2.1");
    });

  it("renders component with custom state", () => {
    mockUseTuiState.mockReturnValue({
      state: createMockTuiState({ activeTasks: 5, queuedTasks: 3 }),
      dispatch: mockDispatch,
    });
    const { lastFrame } = renderWithContext(
      React.createElement(StatusBar),
      { activeTasks: 5, queuedTasks: 3 },
    );
    expect(lastFrame()).toContain("5 run / 3 q");
  });
});
});
