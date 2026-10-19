/**
 * Task 8-tests: embedding backend assertions.
 *
 * Asserts:
 * 1. generateEmbedding returns Float32Array of length 512 (EMBEDDING_DIMENSION)
 * 2. Output is L2-normalized (Σx² ≈ 1)
 * 3. Semantically similar Chinese texts have higher cosine similarity than dissimilar pairs
 * 4. isModelAvailable() returns a boolean
 *
 * These tests must FAIL before Task 8-impl because:
 * - Current EMBEDDING_DIMENSION is 384 (not 512)
 * - Current backend uses onnxruntime-node which fails on darwin/x64
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

describe("generateEmbedding — transformers.js backend (Task 8)", () => {
  it("EMBEDDING_DIMENSION is 512", async () => {
    const { EMBEDDING_DIMENSION } = await import("../../lib/embedding.js");
    expect(EMBEDDING_DIMENSION).toBe(512);
  });

  it("returns Float32Array of length 512", async () => {
    const { generateEmbedding, EMBEDDING_DIMENSION } = await import("../../lib/embedding.js");
    const vec = await generateEmbedding("测试文本");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(EMBEDDING_DIMENSION);
  });

  it("output vector is L2-normalized (sum of squares ≈ 1.0)", async () => {
    const { generateEmbedding } = await import("../../lib/embedding.js");
    const vec = await generateEmbedding("归一化测试");

    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i] * vec[i];
    }
    // L2 norm should be close to 1.0
    expect(Math.abs(sumSq - 1.0)).toBeLessThan(0.01);
  });

  it("semantically similar Chinese texts have higher cosine similarity than dissimilar pair", async () => {
    const { generateEmbedding } = await import("../../lib/embedding.js");

    const vecA = await generateEmbedding("周杰伦的播客很受欢迎");
    const vecB = await generateEmbedding("这期播客听众反响热烈");
    const vecC = await generateEmbedding("数据库迁移失败了");

    const simAB = cosine(vecA, vecB); // similar: both about popular podcast
    const simAC = cosine(vecA, vecC); // dissimilar: podcast vs DB migration

    expect(simAB).toBeGreaterThan(simAC);
  });

  it("isModelAvailable() returns a boolean", async () => {
    const { isModelAvailable } = await import("../../lib/embedding.js");
    const result = isModelAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("[UNK] count ≤ 1 for mixed CJK+Latin string (catches degenerate tokenizer)", async () => {
    // Load the tokenizer vocab directly — no ONNX session needed.
    // Requires the model cache to exist at ~/.adam/models/Xenova_bge-small-zh-v1.5/
    const tokenizerPath = path.join(
      homedir(),
      ".adam",
      "models",
      "Xenova_bge-small-zh-v1.5",
      "tokenizer.json",
    );
    if (!fs.existsSync(tokenizerPath)) {
      // Model not cached in this environment — skip rather than fail
      return;
    }
    const { tokenize } = await import("../../lib/embedding.js");
    const tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, "utf-8")) as {
      model: { vocab: Record<string, number> };
    };
    const vocab = tokenizerData.model.vocab;
    const unkId = vocab["[UNK]"] ?? 100;

    // Mixed CJK + Latin + punctuation — a typical real-world query
    const { inputIds } = tokenize("周杰伦的播客 podcast synth-auto MiniMax", vocab);
    const unkCount = Array.from(inputIds).filter((id) => id === BigInt(unkId)).length;
    expect(unkCount).toBeLessThanOrEqual(1);
  });
});
