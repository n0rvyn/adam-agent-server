import { describe, it, expect } from "vitest";
import { roleIdSchema, pluginIdSchema, localFilePathSchema, ID_REGEXES } from "../../lib/tool-schemas.js";

describe("tool-schemas regex safety", () => {
  it("roleId regex completes within 50ms on 10KB pathological input", () => {
    const pathological = "role-" + "a".repeat(10000) + "!";
    const t0 = Date.now();
    roleIdSchema.safeParse(pathological);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("pluginId regex completes within 50ms on 10KB pathological input", () => {
    const pathological = "a".repeat(5000) + "@" + "b".repeat(5000) + "!";
    const t0 = Date.now();
    pluginIdSchema.safeParse(pathological);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("localFilePath regex completes within 50ms on 10KB pathological input", () => {
    const pathological = "/" + "a".repeat(10000);
    const t0 = Date.now();
    localFilePathSchema.safeParse(pathological);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("UUID_ANY does not match obviously wrong shapes", () => {
    expect(ID_REGEXES.UUID_ANY.test("not-a-uuid")).toBe(false);
    expect(ID_REGEXES.UUID_ANY.test("12345")).toBe(false);
    expect(ID_REGEXES.UUID_ANY.test("a1b2c3d4-5e6f-4789-9abc-def012345678")).toBe(true);
  });
});
