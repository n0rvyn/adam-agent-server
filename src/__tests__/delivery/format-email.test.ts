import { describe, expect, it } from "vitest";
import { formatForChannel } from "../../delivery/format.js";

describe("formatForChannel email", () => {
  it("preserves Markdown for adapter rendering", () => {
    const markdown = "# Heading\n\n- item\n\n[Adam](https://example.com)";

    expect(formatForChannel(markdown, "email")).toBe(markdown);
  });
});
