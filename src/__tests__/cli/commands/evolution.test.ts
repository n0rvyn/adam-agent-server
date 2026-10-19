import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequest } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
}));

vi.mock("../../../cli/client.js", () => ({
  request: mockRequest,
}));

import { evolutionHandler } from "../../../cli/commands/evolution.js";

describe("evolution command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exit = vi.fn() as never;
  });

  it("shows empty message when no records", async () => {
    mockRequest.mockResolvedValueOnce([]);
    await evolutionHandler({ limit: "20" });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No evolution records"));
  });

  it("displays records with diff lines", async () => {
    mockRequest.mockResolvedValueOnce([
      {
        id: "evo-1",
        timestamp: Date.now(),
        oldRules: "old",
        newRules: "new",
        diff: "+added line\n-removed line\ncontext line",
        triggerTaskId: "task-abcdefgh",
      },
    ]);

    await evolutionHandler({});

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Evolution Audit Log"));
    // + line in green, - line in red, context in dim
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("+added line"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("-removed line"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("context line"));
  });

  it("shows record without triggerTaskId", async () => {
    mockRequest.mockResolvedValueOnce([
      {
        id: "evo-2",
        timestamp: Date.now(),
        oldRules: "old",
        newRules: "new",
        diff: "line",
      },
    ]);

    await evolutionHandler({});

    // No "task:" in output when triggerTaskId is missing
    const calls = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const headerCall = calls.find((c: string) => c.includes("["));
    expect(headerCall).toBeDefined();
  });

  it("uses default limit when not specified", async () => {
    mockRequest.mockResolvedValueOnce([]);
    await evolutionHandler({});
    expect(mockRequest).toHaveBeenCalledWith("/evolution-audit?limit=20");
  });

  it("uses custom limit parameter", async () => {
    mockRequest.mockResolvedValueOnce([]);
    await evolutionHandler({ limit: "5" });
    expect(mockRequest).toHaveBeenCalledWith("/evolution-audit?limit=5");
  });

  it("handles API error", async () => {
    mockRequest.mockRejectedValueOnce(new Error("connection failed"));
    await evolutionHandler({});
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("connection failed"));
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
