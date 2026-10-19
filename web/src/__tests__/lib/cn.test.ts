import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn()", () => {
  it("merges multiple class strings", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("resolves tailwind-merge conflicts (last wins)", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("filters falsy values", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
    expect(cn("a", undefined, null, "b")).toBe("a b");
  });

  it("handles array input", () => {
    expect(cn(["a", "b"])).toBe("a b");
  });

  it("handles object input", () => {
    expect(cn({ a: true, b: false })).toBe("a");
  });

  it("handles mixed inputs", () => {
    const result = cn("a", ["b"], { c: true, d: false }, "e");
    expect(result).toBe("a b c e");
  });

  it("returns empty string for no input", () => {
    expect(cn()).toBe("");
  });

  it("merges custom className with base classes", () => {
    expect(cn("rounded-md bg-blue-500", "bg-red-500")).toBe("rounded-md bg-red-500");
  });
});
