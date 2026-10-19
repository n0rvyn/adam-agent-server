/**
 * UT: embedding module basic exports test (transformers.js backend).
 * The old tokenizer is gone; this suite verifies the module interface.
 */
import { describe, it, expect } from "vitest";

describe("embedding module exports (transformers.js backend)", () => {
  it("module exports generateEmbedding function", async () => {
    const mod = await import("../../lib/embedding.js");
    expect(typeof mod.generateEmbedding).toBe("function");
  });

  it("module exports isModelAvailable function", async () => {
    const mod = await import("../../lib/embedding.js");
    expect(typeof mod.isModelAvailable).toBe("function");
  });

  it("module exports EMBEDDING_DIMENSION = 512", async () => {
    const mod = await import("../../lib/embedding.js");
    expect(mod.EMBEDDING_DIMENSION).toBe(512);
  });
});
