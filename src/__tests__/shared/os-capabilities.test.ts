import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getResolvedOsCapabilityRegistry,
  resolveOsCapabilityMeta,
  validateRoleOsCapabilitiesForStorage,
} from "../../shared/os-capabilities.js";

describe("shared/os-capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks runtime-enforced capabilities unavailable when macOS sandbox backend is missing", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const automation = resolveOsCapabilityMeta(
      {
        id: "automation",
        label: "Automation",
        description: "Launch and control other apps via Apple Events.",
        platform: "darwin",
        status: "runtime-enforced",
        supportsTargets: true,
      },
      "none",
      false,
    );

    expect(automation.availability).toBe("runtime-unavailable");
    expect(automation.editable).toBe(false);
    expect(automation.effectiveDisabledReason).toContain("no macOS sandbox backend");
  });

  it("returns platform-unsupported on non-macOS hosts", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    const registry = getResolvedOsCapabilityRegistry("landlock", true);
    expect(registry.find((entry) => entry.id === "automation")).toEqual(
      expect.objectContaining({
        availability: "platform-unsupported",
        editable: false,
      }),
    );
  });

  it("validates stored role osCapabilities", () => {
    expect(
      validateRoleOsCapabilitiesForStorage([
        { id: "automation", targets: ["com.apple.mail"] },
        { id: "accessibility" },
      ]),
    ).toEqual([
      { id: "accessibility" },
      { id: "automation", targets: ["com.apple.mail"] },
    ]);

    expect(() => validateRoleOsCapabilitiesForStorage([{ id: "full-disk-access" }]))
      .toThrow("not editable");
    expect(() => validateRoleOsCapabilitiesForStorage([{ id: "automation", targets: ["Mail App"] }]))
      .toThrow("Invalid automation target bundle id");
  });

  it("rejects unknown capability ids during normalization", async () => {
    const { normalizeRoleOsCapabilities } = await import("../../shared/os-capabilities.js");
    expect(() =>
      normalizeRoleOsCapabilities([{ id: "unknown-capability" as never }]),
    ).toThrow("Unknown OS capability");
  });
});
