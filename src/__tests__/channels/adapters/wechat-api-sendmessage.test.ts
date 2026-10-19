import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { sendMessage } from "../../../channels/adapters/wechat/api.js";

describe("sendMessage ret check and retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds on empty JSON response", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "{}" });

    await expect(sendMessage({
      baseUrl: "https://example.com",
      token: "test",
      body: { msg: { to_user_id: "u1", item_list: [{ type: 1, text_item: { text: "hi" } }] } },
    })).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on ret:-2 and succeeds on second attempt", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => '{"ret":-2}' })
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" });

    await expect(sendMessage({
      baseUrl: "https://example.com",
      token: "test",
      body: { msg: { to_user_id: "u1", item_list: [{ type: 1, text_item: { text: "retry" } }] } },
    })).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after 2 attempts on persistent ret:-2", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '{"ret":-2}' });

    await expect(sendMessage({
      baseUrl: "https://example.com",
      token: "test",
      body: { msg: { to_user_id: "u1", item_list: [{ type: 1, text_item: { text: "fail" } }] } },
    })).rejects.toThrow("iLink ret=-2");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after 3 attempts on persistent ret:-3", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '{"ret":-3}' });

    await expect(sendMessage({
      baseUrl: "https://example.com",
      token: "test",
      body: { msg: { to_user_id: "u1", item_list: [{ type: 1, text_item: { text: "fail3" } }] } },
    })).rejects.toThrow("iLink ret=-3");

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on non-retriable ret codes", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '{"ret":-14}' });

    await expect(sendMessage({
      baseUrl: "https://example.com",
      token: "test",
      body: { msg: { to_user_id: "u1", item_list: [{ type: 1, text_item: { text: "expire" } }] } },
    })).rejects.toThrow("iLink ret=-14");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
