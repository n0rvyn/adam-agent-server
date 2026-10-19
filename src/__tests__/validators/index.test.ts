import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  validateArtifact,
  DslParseError,
  NoHandlerError,
  AssertionFailedError,
  HandlerRuntimeError,
} from "../../validators/index.js";

const FIXTURES = resolve(
  import.meta.dirname,
  "../fixtures/validators",
);

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("validateArtifact — success cases", () => {
  it("audio.duration_s > 4 resolves for silence_5s.mp3", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "silence_5s.mp3"), [
        "audio.duration_s > 4",
      ]),
    ).resolves.toBeUndefined();
  });

  it("audio.zc_rate_per_s < 2000 resolves for sine wave", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "sine_440hz_5s.mp3"), [
        "audio.zc_rate_per_s < 2000",
      ]),
    ).resolves.toBeUndefined();
  });

  it("two passing assertions both resolve", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "silence_5s.mp3"), [
        "audio.duration_s between 4 and 6",
        "audio.rms < 0.05",
      ]),
    ).resolves.toBeUndefined();
  });

  it("markdown.word_count >= 10 resolves for tiny_markdown.md", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "tiny_markdown.md"), [
        "markdown.word_count >= 10",
      ]),
    ).resolves.toBeUndefined();
  });

  it("image.width_px in [...] resolves for tiny_png_64x32.png", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "tiny_png_64x32.png"), [
        "image.width_px in [32, 64, 128]",
      ]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe("validateArtifact — failure cases", () => {
  it("white_noise zc_rate > 5000 throws AssertionFailedError with correct message", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "white_noise_5s.mp3"), [
        "audio.zc_rate_per_s < 5000",
      ]),
    ).rejects.toThrow(AssertionFailedError);
  });

  it("AssertionFailedError message contains key and expected", async () => {
    try {
      await validateArtifact(resolve(FIXTURES, "white_noise_5s.mp3"), [
        "audio.zc_rate_per_s < 5000",
      ]);
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as AssertionFailedError).message;
      expect(msg).toContain("audio.zc_rate_per_s=");
      expect(msg).toContain("expected < 5000");
    }
  });

  it("unknown handler key throws NoHandlerError", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "silence_5s.mp3"), [
        "nonexistent.handler.key > 0",
      ]),
    ).rejects.toThrow(NoHandlerError);
  });

  it("malformed assertion string throws DslParseError", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "silence_5s.mp3"), [
        "malformed_input",
      ]),
    ).rejects.toThrow(DslParseError);
  });

  it("script with /nonexistent path throws HandlerRuntimeError", async () => {
    await expect(
      validateArtifact(resolve(FIXTURES, "silence_5s.mp3"), [
        { script: "/nonexistent.sh" },
      ]),
    ).rejects.toThrow(HandlerRuntimeError);
  });

  it("injected handler that throws raw Error propagates through (not re-wrapped)", async () => {
    await expect(
      validateArtifact(
        resolve(FIXTURES, "silence_5s.mp3"),
        ["audio.duration_s > 0"],
        {
          handlerRegistry: {
            "audio.duration_s": () => Promise.reject(new Error("ffmpeg missing")),
          },
        },
      ),
    ).rejects.toThrow("ffmpeg missing");
  });

  it("json.schema_valid with handler args works", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };
    await expect(
      validateArtifact(
        resolve(FIXTURES, "tiny_schema.json"),
        ["json.schema_valid == true"],
        { handlerArgsByIndex: [{ schema }] },
      ),
    ).resolves.toBeUndefined();
  });
});
