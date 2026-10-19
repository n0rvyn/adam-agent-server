// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForInputReady } from "../../helpers/tui.js";

// Mock fs and yaml at module level with hoisted mocks
const { mockExistsSync, mockReadFileSync, mockParse } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockParse: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  default: { existsSync: mockExistsSync, readFileSync: mockReadFileSync },
}));

vi.mock("yaml", () => ({
  parse: mockParse,
  default: { parse: mockParse },
}));

import { ConfigView } from "../../../cli/tui/components/ConfigView.js";

const wait = () => new Promise((r) => setTimeout(r, 100));

describe("ConfigView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state before useEffect runs", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue(null);
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    expect(lastFrame()).toContain("Loading config...");
  });

  it("shows error when config file not found", async () => {
    mockExistsSync.mockReturnValue(false);
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("Config file not found");
  });

  it("shows error when file read fails", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error("Permission denied"); });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("Permission denied");
  });

  it("displays simple config values", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("port: 3000");
    mockParse.mockReturnValue({ port: 3000, host: "localhost" });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    const frame = lastFrame()!;
    expect(frame).toContain("Configuration");
    expect(frame).toContain("port");
    expect(frame).toContain("3000");
  });

  it("displays nested config objects", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({
      server: { port: 3000, host: "0.0.0.0" },
    });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("server");
    expect(lastFrame()).toContain("port");
  });

  it("displays array config values", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({
      tools: ["bash", "editor", "grep"],
    });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("tools");
    expect(lastFrame()).toContain("bash");
  });

  it("masks sensitive config values containing 'key'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({ apiKey: "sk-1234567890abcdef" });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("sk-1****");
    expect(lastFrame()).not.toContain("1234567890abcdef");
  });

  it("masks sensitive config values containing 'token'", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({ authToken: "tok-abcdefghijk" });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("tok-****");
  });

  it("masks short sensitive values entirely", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({ apiKey: "abc" });
    const { lastFrame } = render(<ConfigView onBack={vi.fn()} />);
    await wait();
    expect(lastFrame()).toContain("****");
  });

  it("calls onBack when Escape is pressed", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");
    mockParse.mockReturnValue({ port: 3000 });
    const onBack = vi.fn();
    const { stdin } = render(<ConfigView onBack={onBack} />);
    await waitForInputReady();
    stdin.write("\x1B");
    expect(onBack).toHaveBeenCalled();
  });
});
