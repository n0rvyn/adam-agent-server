// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { waitForRender, waitForInputReady } from "../../helpers/tui.js";
import { InputBar } from "../../../cli/tui/components/InputBar.js";

describe("InputBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders input prompt", () => {
    const { lastFrame } = render(<InputBar onSubmit={vi.fn()} />);
    expect(lastFrame()).toContain("▸");
  });

  it("shows autocomplete when / is typed", async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    await waitForInputReady();

    stdin.write("/");
    await waitForRender();

    const frame = lastFrame()!;
    expect(frame).toContain("/work");
    expect(frame).toContain("/config");
    expect(frame).toContain("Tasks, Automations & Goals");
  });

  it("filters commands as user types", async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    await waitForInputReady();

    stdin.write("/wo");
    await waitForRender();

    const frame = lastFrame()!;
    expect(frame).toContain("/work");
    expect(frame).not.toContain("/config");
  });

  it("does not show autocomplete for non-slash input", async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    await waitForInputReady();

    stdin.write("hello");
    await waitForRender();

    expect(lastFrame()).not.toContain("/tasks");
  });

  it("submits command on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    await waitForInputReady();

    stdin.write("/work");
    await waitForRender();
    stdin.write("\r");
    await waitForRender();

    expect(onSubmit).toHaveBeenCalledWith("/work");
  });

  it("uses prefix match fallback on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    await waitForInputReady();

    stdin.write("/ev");
    await waitForRender();
    stdin.write("\r");
    await waitForRender();

    expect(onSubmit).toHaveBeenCalledWith("/evolution");
  });

  it("submits regular text on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<InputBar onSubmit={onSubmit} />);
    await waitForInputReady();

    stdin.write("hello world");
    await waitForRender();
    stdin.write("\r");
    await waitForRender();

    expect(onSubmit).toHaveBeenCalledWith("hello world");
  });

  it("highlights first item by default", async () => {
    const { lastFrame, stdin } = render(<InputBar onSubmit={vi.fn()} />);
    await waitForInputReady();

    stdin.write("/");
    await waitForRender();

    // First item should have the highlight indicator
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    const firstCommandLine = lines.find((l) => l.includes("/work"));
    expect(firstCommandLine).toContain("▸");
  });
});
