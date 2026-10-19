/**
 * Shared TUI test utilities for ink-testing-library based tests.
 *
 * Usage in test files:
 *   // @vitest-environment happy-dom
 *   import { createMockTuiState, mockDispatch, mockRequest, renderWithContext, simulateKey } from "../helpers/tui.js";
 *
 * NOTE: vi.mock() calls must live in the test file itself because mock paths
 * are resolved relative to the importing file. This module exports factories,
 * state helpers, and rendering utilities only.
 */
import { vi, type Mock } from "vitest";
import React, { type ReactNode } from "react";
import { render as inkRender } from "ink-testing-library";
import type { TuiState, ApprovalRequest } from "../../cli/tui/hooks/useTuiState.js";
import { TuiProvider } from "../../cli/tui/hooks/useTuiState.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = Mock<(...args: any[]) => any>;

// ---------------------------------------------------------------------------
// Dispatch mock
// ---------------------------------------------------------------------------
export const mockDispatch: AnyMock = vi.fn();

// ---------------------------------------------------------------------------
// Request mock
// ---------------------------------------------------------------------------
/** Shared mock for the request() function from cli/client.ts. */
export const mockRequest: AnyMock = vi.fn();

/** Factory returning a fresh vi.fn() mock for tests needing isolated request mocks. */
export function createMockRequest(): AnyMock {
  return vi.fn();
}

// ---------------------------------------------------------------------------
// State factory & mutable state
// ---------------------------------------------------------------------------
export function createMockTuiState(overrides: Partial<TuiState> = {}): TuiState {
  return {
    connected: true,
    serverInfo: null,
    activeTasks: 0,
    queuedTasks: 0,
    costToday: 0,
    activeTaskId: null,
    activeTaskSubmitted: false,
    pendingApproval: null,
    pendingPlanApproval: null,
    planTimeoutNotice: null,
    serverUnreachable: false,
    view: "chat",
    selectedTaskId: null,
    configVersion: 0,
    session: null,
    version: null,
    ...overrides,
  };
}

let _mockState: TuiState = createMockTuiState();

export const getMockState = () => _mockState;
export const setMockState = (s: TuiState) => { _mockState = s; };

/** Reset all mocks and state to defaults. Call in beforeEach. */
export function resetTuiMocks() {
  vi.clearAllMocks();
  _mockState = createMockTuiState();
}

// ---------------------------------------------------------------------------
// Socket factories (simple vi.fn-based mocks)
// ---------------------------------------------------------------------------
export function createMockEventSocket(): { connect: AnyMock; on: AnyMock; close: AnyMock } {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn(),
  };
}

export function createMockTaskStreamSocket(): { connect: AnyMock; on: AnyMock; off: AnyMock; close: AnyMock } {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// MockWebSocket class — simulates EventSocket / TaskStreamSocket with emit()
// ---------------------------------------------------------------------------
export class MockWebSocket {
  private callbacks: Map<string, Set<(data: unknown) => void>> = new Map();
  private _isConnected = false;

  connect(): Promise<void> {
    this._isConnected = true;
    return Promise.resolve();
  }

  on(event: string, callback: (data: unknown) => void): void {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    this.callbacks.get(event)!.add(callback);
  }

  off(event: string, callback: (data: unknown) => void): void {
    this.callbacks.get(event)?.delete(callback);
  }

  close(): void {
    this._isConnected = false;
    this.callbacks.clear();
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  /** Emit an event to all registered listeners. */
  emit(event: string, data: unknown): void {
    this.callbacks.get(event)?.forEach((cb) => cb(data));
  }

  /** Simulate connection failure. */
  simulateError(_error: Error): void {
    this._isConnected = false;
  }
}

// ---------------------------------------------------------------------------
// Approval factory
// ---------------------------------------------------------------------------
export function createMockApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    taskId: "task-1",
    approvalId: "apr-1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    matchedPattern: ".*",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderWithContext — render a component with mocked TuiProvider + state
// ---------------------------------------------------------------------------
/**
 * Render a component wrapped in (mocked) TuiProvider with the given initial state.
 * Test files must still vi.mock("useTuiState.js") to point useTuiState() at getMockState().
 *
 * Returns ink-testing-library's render result plus the dispatch mock and state.
 */
export function renderWithContext(
  component: ReactNode,
  initialState: Partial<TuiState> = {},
): { lastFrame: () => string | undefined; frames: string[]; stdin: { write: (s: string) => void }; unmount: () => void; rerender: (tree: React.ReactElement) => void; dispatch: AnyMock; state: TuiState } {
  const state = createMockTuiState(initialState);
  setMockState(state);
  const result = inkRender(React.createElement(TuiProvider, null, component));
  return { ...result, dispatch: mockDispatch, state };
}

// ---------------------------------------------------------------------------
// simulateKey — trigger useInput callbacks via stdin.write
// ---------------------------------------------------------------------------
/**
 * Simulate a key press for useInput testing.
 *
 * Common keys: 'q', 'escape' (\x1B), 'return' (\r), 'tab' (\t),
 * arrow keys: '\x1B[A' (up), '\x1B[B' (down), '\x1B[C' (right), '\x1B[D' (left)
 */
export function simulateKey(
  stdin: { write: (input: string) => void },
  key: string,
  opts?: { ctrl?: boolean; meta?: boolean; shift?: boolean },
): void {
  const keyMap: Record<string, string> = {
    escape: "\x1B",
    return: "\r",
    enter: "\r",
    tab: "\t",
    up: "\x1B[A",
    down: "\x1B[B",
    right: "\x1B[C",
    left: "\x1B[D",
    backspace: "\x7F",
    delete: "\x1B[3~",
    space: " ",
  };

  let input = keyMap[key] ?? key;

  if (opts?.ctrl && input.length === 1) {
    // Ctrl+<letter> = char code 1-26 (a=1, b=2, ..., z=26)
    input = String.fromCharCode(input.toLowerCase().charCodeAt(0) - 96);
  }
  if (opts?.meta) {
    input = `\x1B${input}`;
  }

  stdin.write(input);
}

/**
 * Wait for useInput's useEffect to register the stdin listener.
 * Call after render() and before simulateKey().
 */
export function waitForInputReady(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

/**
 * Wait for useEffect + async state updates to flush (e.g., after request() resolves).
 * Call after render() to let component settle into its final state.
 */
export function waitForRender(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}
