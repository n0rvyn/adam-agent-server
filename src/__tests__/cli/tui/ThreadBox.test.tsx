// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ThreadBox } from "../../../cli/tui/components/ThreadBox.js";

describe("ThreadBox", () => {
  it("renders header with task short id, role name, and brief", () => {
    const { lastFrame } = render(
      <ThreadBox threadRoot="t-uuid" taskShortIdLabel="T-2841" roleName="审慎者" brief="评审 PR #123">
        <></>
      </ThreadBox>,
    );
    expect(lastFrame()).toContain("[Thread");
    expect(lastFrame()).toContain("T-2841");
    expect(lastFrame()).toContain("审慎者");
    expect(lastFrame()).toContain("评审 PR #123");
  });

  it("falls back to thread root prefix when no metadata", () => {
    const { lastFrame } = render(
      <ThreadBox threadRoot="abcdef1234567890">
        <></>
      </ThreadBox>,
    );
    expect(lastFrame()).toContain("[Thread abcdef12");
  });

  it("renders children inside the box", () => {
    const { lastFrame } = render(
      <ThreadBox threadRoot="t1" taskShortIdLabel="T-1">
        <Text>child content</Text>
      </ThreadBox>,
    );
    expect(lastFrame()).toContain("child content");
  });
});
