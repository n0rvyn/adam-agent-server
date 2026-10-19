import { describe, it, expect, vi, beforeEach } from "vitest";
import { api, ApiError } from "@/lib/api";

describe("api()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sets Content-Type to application/json when body is provided", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await api("/test", { method: "POST", body: JSON.stringify({ data: 1 }) });

    const [, init] = mockFetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("does NOT set Content-Type when no body is provided", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await api("/test", { method: "POST" });

    const [, init] = mockFetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("does NOT set Content-Type for GET requests", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await api("/test");

    const [, init] = mockFetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("allows caller to override Content-Type", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await api("/test", {
      method: "POST",
      body: "plain text",
      headers: { "Content-Type": "text/plain" },
    });

    const [, init] = mockFetch.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("text/plain");
  });

  it("throws ApiError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })),
    );

    await expect(api("/missing")).rejects.toThrow(ApiError);
    await expect(api("/missing")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("returns undefined for 204 No Content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const result = await api("/empty");
    expect(result).toBeUndefined();
  });
});
