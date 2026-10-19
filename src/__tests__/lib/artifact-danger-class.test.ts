import { describe, it, expect } from "vitest";
import { getDangerClass, isDangerClass } from "../../lib/artifact-danger-class.js";

describe("getDangerClass", () => {
  it("returns 'audio' for audio/mpeg", () => {
    expect(getDangerClass("audio/mpeg")).toBe("audio");
  });

  it("returns 'audio' for any audio/* prefix", () => {
    expect(getDangerClass("audio/ogg")).toBe("audio");
    expect(getDangerClass("audio/wav")).toBe("audio");
  });

  it("returns 'video' for video/mp4", () => {
    expect(getDangerClass("video/mp4")).toBe("video");
  });

  it("returns 'video' for any video/* prefix", () => {
    expect(getDangerClass("video/webm")).toBe("video");
  });

  it("returns 'pdf' for application/pdf", () => {
    expect(getDangerClass("application/pdf")).toBe("pdf");
  });

  it("returns null for image/png", () => {
    expect(getDangerClass("image/png")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(getDangerClass(undefined)).toBeNull();
  });

  it("returns null for text/plain", () => {
    expect(getDangerClass("text/plain")).toBeNull();
  });

  it("returns null for application/json (not pdf)", () => {
    expect(getDangerClass("application/json")).toBeNull();
  });
});

describe("isDangerClass", () => {
  it("returns true for audio/anything", () => {
    expect(isDangerClass("audio/anything")).toBe(true);
  });

  it("returns false for text/plain", () => {
    expect(isDangerClass("text/plain")).toBe(false);
  });

  it("returns true for video/mp4", () => {
    expect(isDangerClass("video/mp4")).toBe(true);
  });

  it("returns true for application/pdf", () => {
    expect(isDangerClass("application/pdf")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isDangerClass(undefined)).toBe(false);
  });
});
