import { describe, expect, it } from "vitest";
import { buildEmailSubject, renderEmailContent } from "../../../../channels/adapters/email/email-renderer.js";

describe("email renderer", () => {
  it("renders Markdown to HTML and plain text", () => {
    const rendered = renderEmailContent("# Heading\n\n- First\n- Second\n\n[Link](https://example.com)");

    expect(rendered.html).toContain("<h1>Heading</h1>");
    expect(rendered.html).toContain("<li>First</li>");
    expect(rendered.html).toContain('<a href="https://example.com">Link</a>');
    expect(rendered.text).toContain("Heading");
    expect(rendered.text).toContain("First");
    expect(rendered.text).toContain("Link");
  });

  it("escapes raw HTML in Markdown", () => {
    const rendered = renderEmailContent("<script>alert(1)</script>");

    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).not.toContain("<script>");
  });

  it("builds subjects by message type", () => {
    expect(buildEmailSubject({ prefix: "Adam", messageType: "report" })).toBe("[Adam Report]");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "deliver" })).toBe("[Adam Deliver]");
    expect(buildEmailSubject({ prefix: "Adam", messageType: "reply" })).toBe("[Adam]");
  });
});
