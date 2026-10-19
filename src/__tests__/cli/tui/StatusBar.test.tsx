// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockState: Record<string, unknown> = {};

vi.mock("../../../cli/tui/hooks/useTuiState.js", () => ({
  useTuiState: () => ({ state: mockState, dispatch: vi.fn() }),
}));

vi.mock("../../../cli/tui/theme.js", () => ({
  colors: { statusUp: "●", statusDown: "○" },
}));

import { StatusBar } from "../../../cli/tui/components/StatusBar.js";

// Ink components render to React elements in tests
vi.mock("ink", () => ({
  Box: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement("div", props, children),
  Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement("span", props, children),
}));

describe("StatusBar", () => {
  beforeEach(() => {
    Object.assign(mockState, {
      connected: true,
      workers: [{ id: "w1", status: "idle" }],
      activeTasks: 0,
      queuedTasks: 0,
      costToday: 1.23,
      view: "chat",
      session: null,
      version: "0.2.1",
    });
  });

  it("shows session indicator when in chat view with active session", () => {
    mockState.session = { id: "abcdef12-3456-7890", status: "active", messageCount: 5, createdAt: Date.now(), lastActiveAt: Date.now() };
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).toContain("abcdef12");
    expect(html).toContain("5t");
  });

  it("shows (new) for 0-turn session", () => {
    mockState.session = { id: "abcdef12-3456-7890", status: "active", messageCount: 0, createdAt: Date.now(), lastActiveAt: Date.now() };
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).toContain("new session");
  });

  it("does not show session indicator when not in chat view", () => {
    mockState.view = "tasks";
    mockState.session = { id: "abc", status: "active", messageCount: 3, createdAt: Date.now(), lastActiveAt: Date.now() };
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).not.toContain("Session:");
  });

  it("does not show session indicator when no session", () => {
    mockState.session = null;
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).not.toContain("Session:");
  });

  it("shows timeout warning when session near timeout", () => {
    mockState.session = {
      id: "abc",
      status: "active",
      messageCount: 3,
      createdAt: Date.now() - 30 * 60 * 1000,
      lastActiveAt: Date.now() - 26 * 60 * 1000, // 26 min ago (>= 25 min threshold)
    };
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).toContain("timeout");
  });

  it("does not show timeout warning when session recently active", () => {
    mockState.session = {
      id: "abc",
      status: "active",
      messageCount: 3,
      createdAt: Date.now(),
      lastActiveAt: Date.now(), // just now
    };
    const html = renderToStaticMarkup(React.createElement(StatusBar));
    expect(html).not.toContain("timeout");
  });

  it("renders single-row layout when terminal is wide (>= 90 cols)", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    try {
      const html = renderToStaticMarkup(React.createElement(StatusBar));
      // flexDirection only appears on narrow; wide uses default (row)
      expect(html).not.toContain('flexDirection="column"');
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
    }
  });

  it("falls back to two-row layout when terminal is narrow (< 90 cols)", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    try {
      const html = renderToStaticMarkup(React.createElement(StatusBar));
      expect(html).toContain('flexDirection="column"');
    } finally {
      Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
    }
  });
});
