import { describe, expect, it } from "vitest";
import { normalizeEmailAddress } from "../../../../channels/adapters/email/address.js";

describe("normalizeEmailAddress", () => {
  it("normalizes local part and domain", () => {
    expect(normalizeEmailAddress(" Test.User@Example.COM ")).toBe("test.user@example.com");
  });

  it("rejects empty string", () => {
    expect(() => normalizeEmailAddress("")).toThrow("required");
  });

  it("rejects comma-separated multi-address input", () => {
    expect(() => normalizeEmailAddress("a@example.com,b@example.com")).toThrow("exactly one");
  });

  it("rejects display-name lists for channel config", () => {
    expect(() => normalizeEmailAddress("Adam <a@example.com>")).toThrow("exactly one");
  });
});
