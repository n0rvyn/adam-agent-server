import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AttachmentChip } from "@/components/chat/AttachmentChip.tsx";

describe("AttachmentChip", () => {
  it("renders filename and formatted size", () => {
    render(
      <AttachmentChip
        attachment={{
          artifactId: "art-001",
          locator: "/tmp/review.md",
          filename: "review.md",
          mimeType: "text/markdown",
          size: 4200,
          purpose: "report",
        }}
      />,
    );
    expect(screen.getByText("review.md")).toBeInTheDocument();
    expect(screen.getByText(/4\.1 KB/)).toBeInTheDocument();
  });

  it("sets data-purpose attribute", () => {
    render(
      <AttachmentChip
        attachment={{
          artifactId: "art-001",
          locator: "/tmp/review.md",
          filename: "review.md",
          mimeType: "text/markdown",
          size: 4200,
          purpose: "report",
        }}
      />,
    );
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute("data-purpose", "report");
  });

  it("calls onPreview with attachment on click", () => {
    const onPreview = vi.fn();
    render(
      <AttachmentChip
        attachment={{
          artifactId: "art-001",
          locator: "/tmp/review.md",
          filename: "review.md",
          mimeType: "text/markdown",
          size: 4200,
          purpose: "report",
        }}
        onPreview={onPreview}
      />,
    );
    screen.getByTestId("attachment-chip").click();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "review.md", purpose: "report" }),
    );
  });
});
