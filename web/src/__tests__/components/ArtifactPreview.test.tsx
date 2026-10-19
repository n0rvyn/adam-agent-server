import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "../utils/test-utils";
import type { Artifact } from "@/lib/types.ts";

// Mock api/artifacts so blobUrl returns a predictable URL
vi.mock("@/lib/api/artifacts.ts", () => ({
  artifactBlobUrl: vi.fn((id: string) => `/artifacts/${id}/blob`),
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  redeliverArtifact: vi.fn(),
  downloadArtifactBlob: vi.fn(),
}));

// We do NOT mock `marked` or `DOMPurify` — real libraries are used per plan requirement

import { ArtifactPreview } from "@/components/artifacts/ArtifactPreview.tsx";

function makeArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "art-1",
    sourceKind: "task_published",
    kind: "file",
    sizeBytes: 1024,
    createdAt: Date.now(),
    ...overrides,
  };
}

// Helper to mock fetch returning text content
function mockFetch(text: string, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok,
    text: async () => text,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArtifactPreview", () => {
  it("audio — renders <audio> element with correct src", () => {
    const artifact = makeArtifact({ id: "aud-1", mime: "audio/mpeg", originalFilename: "track.mp3" });
    render(<ArtifactPreview artifact={artifact} />);
    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute("src")).toContain("/artifacts/aud-1/blob");
    expect(audio?.getAttribute("aria-label")).toBe("track.mp3");
  });

  it("image — renders <img> element with correct src", () => {
    const artifact = makeArtifact({ id: "img-1", mime: "image/png", originalFilename: "photo.png" });
    render(<ArtifactPreview artifact={artifact} />);
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("/artifacts/img-1/blob");
    expect(img?.getAttribute("alt")).toBe("photo.png");
  });

  it("markdown — fetches blob and renders sanitized HTML", async () => {
    const artifact = makeArtifact({ id: "md-1", mime: "text/markdown" });
    mockFetch("## Hello\n\nWorld paragraph.");
    render(<ArtifactPreview artifact={artifact} />);
    await waitFor(() => {
      const el = document.querySelector("[data-testid='markdown-render']");
      expect(el).not.toBeNull();
      expect(el?.innerHTML).toContain("<h2");
      expect(el?.innerHTML).toContain("Hello");
    });
  });

  it("text/plain — renders content in <pre>", async () => {
    const artifact = makeArtifact({ id: "txt-1", mime: "text/plain" });
    mockFetch("plain text content");
    render(<ArtifactPreview artifact={artifact} />);
    await waitFor(() => {
      expect(screen.getByTestId("text-render")).toBeInTheDocument();
      expect(screen.getByTestId("text-render").textContent).toContain("plain text content");
    });
  });

  it("other mime — renders Download link", () => {
    const artifact = makeArtifact({ id: "zip-1", mime: "application/zip", originalFilename: "archive.zip" });
    render(<ArtifactPreview artifact={artifact} />);
    expect(screen.getByTestId("preview-download-link")).toBeInTheDocument();
    expect(screen.getByTestId("preview-download-link").getAttribute("href")).toContain("/artifacts/zip-1/blob");
  });

  it("XSS payload — <img onerror> attribute is stripped by DOMPurify", async () => {
    const artifact = makeArtifact({ id: "xss-1", mime: "text/markdown" });
    // Payload: img with onerror + script injection
    const xssPayload = '## Heading\n\n<img src=x onerror="alert(1)">\n\n<script>evil()</script>';
    mockFetch(xssPayload);

    const { container } = render(<ArtifactPreview artifact={artifact} />);

    await waitFor(() => {
      const el = container.querySelector("[data-testid='markdown-render']");
      expect(el).not.toBeNull();
    });

    const markdownEl = container.querySelector("[data-testid='markdown-render']");
    expect(markdownEl).not.toBeNull();

    // The img element should exist (DOMPurify allows img tags) but onerror must be stripped
    const img = markdownEl?.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();

    // script tag must not appear in rendered output
    const scriptTags = markdownEl?.querySelectorAll("script");
    expect(scriptTags?.length ?? 0).toBe(0);

    // Heading should render correctly — proves real marked ran (not mock)
    expect(markdownEl?.innerHTML).toContain("<h2");
  });
});
