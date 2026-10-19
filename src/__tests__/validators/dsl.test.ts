import { describe, it, expect } from "vitest";
import { parseAssertion, DslParseError, type ParsedAssertion } from "../../validators/dsl.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function assertKind<T extends ParsedAssertion["kind"]>(
  input: string | { script: string },
  kind: T,
  expected: Omit<Extract<ParsedAssertion, { kind: T }>, "kind">,
): void {
  const result = parseAssertion(input);
  expect(result.kind).toBe(kind);
  expect(result as unknown).toMatchObject({ kind, ...expected });
}

// ---------------------------------------------------------------------------
// Success — comparison operators
// ---------------------------------------------------------------------------

describe("DSL parser — success cases", () => {
  describe("comparison operators", () => {
    it("parses '<'", () => {
      assertKind("audio.duration_s < 60", "comparison", {
        key: "audio.duration_s",
        op: "<",
        value: 60,
      });
    });

    it("parses '>'", () => {
      assertKind("audio.zc_rate_per_s > 5000", "comparison", {
        key: "audio.zc_rate_per_s",
        op: ">",
        value: 5000,
      });
    });

    it("parses '<='", () => {
      assertKind("markdown.word_count <= 5000", "comparison", {
        key: "markdown.word_count",
        op: "<=",
        value: 5000,
      });
    });

    it("parses '>='", () => {
      assertKind("pdf.page_count >= 1", "comparison", {
        key: "pdf.page_count",
        op: ">=",
        value: 1,
      });
    });

    it("parses '=='", () => {
      assertKind("image.width_px == 1920", "comparison", {
        key: "image.width_px",
        op: "==",
        value: 1920,
      });
    });

    it("parses '!='", () => {
      assertKind("json.schema_valid != false", "comparison", {
        key: "json.schema_valid",
        op: "!=",
        value: false,
      });
    });

    it("parses comparison with string value", () => {
      assertKind("audio.codec == \"mp3\"", "comparison", {
        key: "audio.codec",
        op: "==",
        value: "mp3",
      });
    });

    it("parses comparison with bare float", () => {
      assertKind("audio.rms < 0.5", "comparison", {
        key: "audio.rms",
        op: "<",
        value: 0.5,
      });
    });
  });

  describe("between operator", () => {
    it("parses 'between A and B' with integers", () => {
      assertKind("audio.duration_s between 60 and 1800", "between", {
        key: "audio.duration_s",
        min: 60,
        max: 1800,
      });
    });

    it("parses 'between A and B' with floats", () => {
      assertKind("audio.rms between -0.5 and 0.9", "between", {
        key: "audio.rms",
        min: -0.5,
        max: 0.9,
      });
    });
  });

  describe("in operator", () => {
    it("parses 'in [...]' with numbers", () => {
      assertKind("image.width_px in [320, 640, 1280]", "in", {
        key: "image.width_px",
        values: [320, 640, 1280],
      });
    });

    it("parses 'in [...]' with strings", () => {
      assertKind("audio.codec in [\"mp3\", \"aac\", \"flac\"]", "in", {
        key: "audio.codec",
        values: ["mp3", "aac", "flac"],
      });
    });

    it("parses 'in [...]' with mixed values", () => {
      assertKind("json.status in [200, \"ok\", true]", "in", {
        key: "json.status",
        values: [200, "ok", true],
      });
    });
  });

  describe("matches operator", () => {
    it("parses 'matches /pattern/'", () => {
      assertKind("audio.codec matches /^(mp3|aac)$/", "matches", {
        key: "audio.codec",
        regexSource: "^(mp3|aac)$",
        regexFlags: "",
      });
    });

    it("parses 'matches /pattern/flags'", () => {
      assertKind("audio.codec matches /^(mp3|aac)$/i", "matches", {
        key: "audio.codec",
        regexSource: "^(mp3|aac)$",
        regexFlags: "i",
      });
    });
  });

  describe("script escape hatch", () => {
    it("accepts { script: '/absolute/path' }", () => {
      assertKind({ script: "/usr/local/bin/check.sh" }, "script", {
        scriptPath: "/usr/local/bin/check.sh",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("DSL parser — error cases", () => {
  it("throws on empty string", () => {
    expect(() => parseAssertion("")).toThrow(DslParseError);
  });

  it("throws on whitespace-only string", () => {
    expect(() => parseAssertion("   ")).toThrow(DslParseError);
  });

  it("throws on unknown operator", () => {
    expect(() => parseAssertion("audio.duration_s ~~ 5000")).toThrow(DslParseError);
  });

  it("throws on missing operand after operator", () => {
    expect(() => parseAssertion("audio.duration_s <")).toThrow(DslParseError);
  });

  it("throws on malformed regex (unclosed)", () => {
    expect(() => parseAssertion("audio.codec matches /[unclosed")).toThrow(DslParseError);
  });

  it("throws on non-absolute script path", () => {
    expect(() => parseAssertion({ script: "relative/path.sh" })).toThrow(DslParseError);
  });

  it("throws on invalid key format", () => {
    expect(() => parseAssertion("9invalid < 5000")).toThrow(DslParseError);
  });

  it("throws on key with '..'", () => {
    expect(() => parseAssertion("audio..duration_s < 5000")).toThrow(DslParseError);
  });

  it("DslParseError has the right name", () => {
    try {
      parseAssertion("");
    } catch (e) {
      expect((e as DslParseError).name).toBe("DslParseError");
    }
  });
});
