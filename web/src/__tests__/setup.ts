import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, afterAll, vi, expect } from "vitest";
import { server } from "./msw/server";
import { installWebSocketMock } from "./utils/mock-websocket";

// Stub localStorage for JSDOM environment (connectWebSocket uses it)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Pre-populate auth key so the App's AuthGate doesn't redirect every test to the login page.
// Individual tests that exercise the login flow can clear it with localStorage.removeItem.
localStorageMock.setItem("adam_api_key", "test-api-key-for-tests");
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => {
    const maxWidthMatch = query.match(/max-width:\s*(\d+)px/);
    const maxWidth = maxWidthMatch ? Number(maxWidthMatch[1]) : Number.POSITIVE_INFINITY;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    return {
      matches: window.innerWidth <= maxWidth,
      media: query,
      onchange: null,
      addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      dispatchEvent: (event: Event) => {
        listeners.forEach((listener) => listener(event as MediaQueryListEvent));
        return true;
      },
    };
  },
});

// Extend vitest's expect with jest-dom matchers
expect.extend(matchers);

// Install WebSocket mock globally so store.connectWebSocket doesn't use real WebSocket
installWebSocketMock();

// Start MSW server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());
