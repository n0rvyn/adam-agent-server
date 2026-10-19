import { describe, it, expect } from "vitest";
import { handlers } from "../../validators/handlers.js";
import { HandlerRuntimeError } from "../../validators/errors.js";
import { resolve } from "node:path";

const FIXTURES = resolve(
  import.meta.dirname,
  "../fixtures/validators",
);

async function handler(key: string, file: string, args?: unknown) {
  return handlers[key]!(resolve(FIXTURES, file), args);
}

// ---------------------------------------------------------------------------
// Audio — duration
// ---------------------------------------------------------------------------

describe("handlers — audio.duration_s", () => {
  it("returns approximately 5.0 for silence_5s.mp3 (±0.1)", async () => {
    const dur = await handler("audio.duration_s", "silence_5s.mp3");
    expect(dur).toBeGreaterThanOrEqual(4.9);
    expect(dur).toBeLessThanOrEqual(5.2);
  });
});

// ---------------------------------------------------------------------------
// Audio — zero-crossing rate
// ---------------------------------------------------------------------------

describe("handlers — audio.zc_rate_per_s", () => {
  it("sine_440hz is low (~880/s, MP3 may add some)", async () => {
    const zc = await handler("audio.zc_rate_per_s", "sine_440hz_5s.mp3");
    expect(zc).toBeGreaterThan(600);
    expect(zc).toBeLessThan(2000);
  });

  it("white_noise is high (>5000/s)", async () => {
    const zc = await handler("audio.zc_rate_per_s", "white_noise_5s.mp3");
    expect(zc).toBeGreaterThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Audio — RMS
// ---------------------------------------------------------------------------

describe("handlers — audio.rms", () => {
  it("silence has near-zero RMS (<0.01)", async () => {
    const rms = await handler("audio.rms", "silence_5s.mp3");
    expect(rms).toBeLessThan(0.01);
  });

  it("sine wave has moderate RMS (>0.05)", async () => {
    const rms = await handler("audio.rms", "sine_440hz_5s.mp3");
    expect(rms).toBeGreaterThan(0.05);
  });

  it("white noise has high RMS (>0.3)", async () => {
    const rms = await handler("audio.rms", "white_noise_5s.mp3");
    expect(rms).toBeGreaterThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

describe("handlers — markdown.word_count", () => {
  it("counts 50 words in tiny_markdown.md", async () => {
    const count = await handler("markdown.word_count", "tiny_markdown.md");
    expect(count).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

describe("handlers — image dimensions", () => {
  it("image.width_px returns 64 for tiny_png_64x32.png", async () => {
    const w = await handler("image.width_px", "tiny_png_64x32.png");
    expect(w).toBe(64);
  });

  it("image.height_px returns 32 for tiny_png_64x32.png", async () => {
    const h = await handler("image.height_px", "tiny_png_64x32.png");
    expect(h).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe("handlers — pdf.page_count", () => {
  it("returns 1 for one_page.pdf", async () => {
    const pages = await handler("pdf.page_count", "one_page.pdf");
    expect(pages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// JSON schema
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

const validSchema = JSON.parse(
  readFileSync(resolve(FIXTURES, "schema.json"), "utf-8"),
);

const stricterSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number", minimum: 100 },
  },
  required: ["name", "age"],
};

describe("handlers — json.schema_valid", () => {
  it("returns true when data matches schema", async () => {
    const result = await handler(
      "json.schema_valid",
      "tiny_schema.json",
      { schema: validSchema },
    );
    expect(result).toBe(true);
  });

  it("returns false when data violates stricter schema", async () => {
    const result = await handler(
      "json.schema_valid",
      "tiny_schema.json",
      { schema: stricterSchema },
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime errors
// ---------------------------------------------------------------------------

describe("handlers — runtime errors", () => {
  it("throws HandlerRuntimeError for missing file", async () => {
    await expect(handlers["audio.duration_s"]("/nonexistent/path.mp3")).rejects.toThrow(
      HandlerRuntimeError,
    );
  });

  it("throws HandlerRuntimeError for non-JSON file via json.schema_valid", async () => {
    await expect(
      handlers["json.schema_valid"](resolve(FIXTURES, "tiny_markdown.md"), {
        schema: validSchema,
      }),
    ).rejects.toThrow(HandlerRuntimeError);
  });

  it("throws HandlerRuntimeError when schema arg is missing", async () => {
    await expect(
      handlers["json.schema_valid"](resolve(FIXTURES, "tiny_schema.json")),
    ).rejects.toThrow(HandlerRuntimeError);
  });

  it("rejects schema with remote $ref (defense-in-depth)", async () => {
    const remoteRefSchema = {
      type: "object",
      properties: { foo: { $ref: "https://example.com/schemas/foo.json" } },
    };
    await expect(
      handlers["json.schema_valid"](resolve(FIXTURES, "tiny_schema.json"), {
        schema: remoteRefSchema,
      }),
    ).rejects.toThrow(/remote \$ref not supported/);
  });

  it("accepts schema with local $ref (no rejection)", async () => {
    const localRefSchema = {
      type: "object",
      definitions: { age: { type: "number" } },
      properties: { name: { type: "string" }, age: { $ref: "#/definitions/age" } },
      required: ["name", "age"],
    };
    const result = await handlers["json.schema_valid"](
      resolve(FIXTURES, "tiny_schema.json"),
      { schema: localRefSchema },
    );
    expect(result).toBe(true);
  });
});
