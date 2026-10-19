import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { getRuntimeConfig, initRuntimeConfig, MUTABLE_PATHS, updateMutableConfig } from "../../config/runtime.js";
import type { ServerConfig } from "../../shared/types.js";

describe("config/runtime identity", () => {
  beforeEach(() => {
    initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
  });

  it("defaults identity.ownerViewerKey to local-owner", () => {
    expect(getRuntimeConfig().identity?.ownerViewerKey).toBe("local-owner");
  });

  it("allows identity.ownerViewerKey as a mutable path", () => {
    expect(MUTABLE_PATHS).toContain("identity.ownerViewerKey");
    const result = updateMutableConfig({ "identity.ownerViewerKey": "owner-updated" });
    expect(result).toEqual({ success: true, updated: ["identity.ownerViewerKey"], errors: [] });
    expect(getRuntimeConfig().identity?.ownerViewerKey).toBe("owner-updated");
  });

  it("rejects blank identity.ownerViewerKey values", () => {
    const result = updateMutableConfig({ "identity.ownerViewerKey": "" });
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual(["\"identity.ownerViewerKey\" must be a non-empty string."]);
  });
});

describe("config/runtime — framework config externalization (Task 2)", () => {
  beforeEach(() => {
    initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
  });

  it("MUTABLE_PATHS includes all new chat.commitmentDetection.* paths", () => {
    const expected = [
      "chat.artifactThresholdChars",
      "chat.commitmentDetection.locales",
      "chat.commitmentDetection.blockedText.zh",
      "chat.commitmentDetection.blockedText.en",
      "chat.commitmentDetection.unsupportedSuccessText.zh",
      "chat.commitmentDetection.unsupportedSuccessText.en",
      "chat.commitmentDetection.unsupportedFailureText.zh",
      "chat.commitmentDetection.unsupportedFailureText.en",
      "chat.commitmentDetection.unsupportedMutationText.zh",
      "chat.commitmentDetection.unsupportedMutationText.en",
      "storage.localProfile",
    ];
    for (const p of expected) {
      expect(MUTABLE_PATHS as readonly string[]).toContain(p);
    }
  });

  it("storage.localProfile rejects path separators via updateMutableConfig", () => {
    const r = updateMutableConfig({ "storage.localProfile": "../etc" });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/path separators|\[a-zA-Z0-9_-\]/);
  });

  it("storage.localProfile accepts valid profile names", () => {
    const r1 = updateMutableConfig({ "storage.localProfile": "default" });
    expect(r1.errors).toEqual([]);
    expect(r1.updated).toContain("storage.localProfile");
    const r2 = updateMutableConfig({ "storage.localProfile": "archive_v2" });
    expect(r2.errors).toEqual([]);
  });

  it("chat.artifactThresholdChars rejects non-positive", () => {
    const r1 = updateMutableConfig({ "chat.artifactThresholdChars": 0 });
    expect(r1.errors[0]).toMatch(/positive/);
    const r2 = updateMutableConfig({ "chat.artifactThresholdChars": -100 });
    expect(r2.errors[0]).toMatch(/positive/);
    const r3 = updateMutableConfig({ "chat.artifactThresholdChars": 1000 });
    expect(r3.errors).toEqual([]);
  });

  it("chat.commitmentDetection.locales rejects empty / invalid locale values", () => {
    const r1 = updateMutableConfig({ "chat.commitmentDetection.locales": [] });
    expect(r1.errors[0]).toMatch(/non-empty/);
    const r2 = updateMutableConfig({ "chat.commitmentDetection.locales": ["fr"] });
    expect(r2.errors[0]).toMatch(/zh.*en/);
    const r3 = updateMutableConfig({ "chat.commitmentDetection.locales": ["zh", "en"] });
    expect(r3.errors).toEqual([]);
  });

  it("unknown / non-mutable paths are rejected with the 'not a recognized config path' error", () => {
    const r = updateMutableConfig({ "chat.bogusField": "x" });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/not a recognized config path/);
  });
});
