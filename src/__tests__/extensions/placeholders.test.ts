import { describe, it, expect } from "vitest";
import { substitutePlaceholders, substitutePlaceholdersDeep, UnresolvedPlaceholderError } from "../../extensions/placeholders.js";

describe("substitutePlaceholders", () => {
  it("replaces ${HOME} with ctx.HOME", () => {
    expect(substitutePlaceholders("${HOME}/foo", { HOME: "/home/user" })).toBe("/home/user/foo");
  });

  it("replaces ${__dirname} with ctx.__dirname", () => {
    expect(substitutePlaceholders("${__dirname}/dist", { __dirname: "/opt/ext" })).toBe("/opt/ext/dist");
  });

  it("replaces ${user_config.api_key} with ctx.user_config.api_key", () => {
    expect(
      substitutePlaceholders("Bearer ${user_config.api_key}", {
        user_config: { api_key: "abc123" },
      }),
    ).toBe("Bearer abc123");
  });

  it("throws UnresolvedPlaceholderError when ${user_config.missing} has no value", () => {
    expect(() =>
      substitutePlaceholders("${user_config.missing}", { user_config: {} }),
    ).toThrow(UnresolvedPlaceholderError);
  });

  it("leaves unrelated text untouched", () => {
    expect(substitutePlaceholders("hello world", {})).toBe("hello world");
    expect(substitutePlaceholders("${UNRECOGNIZED}", {})).toBe("${UNRECOGNIZED}");
  });

  it("coerces user_config number/boolean to string", () => {
    expect(
      substitutePlaceholders("port=${user_config.port}", { user_config: { port: 8080 } }),
    ).toBe("port=8080");
    expect(
      substitutePlaceholders("debug=${user_config.enabled}", { user_config: { enabled: true } }),
    ).toBe("debug=true");
  });
});

describe("substitutePlaceholdersDeep", () => {
  it("walks nested env object replacing placeholders in string leaves", () => {
    const env = {
      HOME_PATH: "${HOME}/data",
      NESTED_KEY: "${user_config.key}",
      PASS_THROUGH: "static",
    };
    const result = substitutePlaceholdersDeep(env, {
      HOME: "/root",
      user_config: { key: "secret" },
    });
    expect(result).toEqual({
      HOME_PATH: "/root/data",
      NESTED_KEY: "secret",
      PASS_THROUGH: "static",
    });
  });
});
