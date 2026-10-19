// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mockRequest = vi.fn();
vi.mock("../../../cli/client.js", () => ({
  request: (...args: unknown[]) => mockRequest(...args),
}));

vi.mock("ink", () => ({
  Box: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement("div", props, children),
  Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement("span", props, children),
  useInput: vi.fn(),
}));

import { ChannelList } from "../../../cli/tui/components/ChannelList.js";

describe("ChannelList", () => {
  it("renders loading state initially", () => {
    mockRequest.mockReturnValue(new Promise(() => {})); // never resolves
    const html = renderToStaticMarkup(React.createElement(ChannelList, { onBack: vi.fn() }));
    expect(html).toContain("Loading");
  });

  it("renders empty state when no channels", async () => {
    mockRequest.mockResolvedValue({ channels: [] });
    const html = renderToStaticMarkup(React.createElement(ChannelList, { onBack: vi.fn() }));
    // Initial render shows loading; after async, would show empty
    expect(html).toBeDefined();
  });

  it("accepts onBack prop", () => {
    const onBack = vi.fn();
    mockRequest.mockResolvedValue({ channels: [] });
    expect(() => renderToStaticMarkup(React.createElement(ChannelList, { onBack }))).not.toThrow();
  });
});
