import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { artifactBlobUrl } from "@/lib/api/artifacts.ts";
import type { Artifact } from "@/lib/types.ts";

interface ArtifactPreviewProps {
  artifact: Artifact;
}

export function ArtifactPreview({ artifact }: ArtifactPreviewProps) {
  const mime = artifact.mime ?? "";
  const blobUrl = artifactBlobUrl(artifact.id);

  if (mime.startsWith("audio/")) {
    return (
      <audio
        controls
        className="w-full"
        src={blobUrl}
        aria-label={artifact.originalFilename ?? "audio"}
      />
    );
  }

  if (mime.startsWith("image/")) {
    return (
      <img
        src={blobUrl}
        style={{ maxHeight: "80vh" }}
        alt={artifact.originalFilename ?? "image"}
        className="max-w-full object-contain"
      />
    );
  }

  if (mime === "text/markdown" || mime.startsWith("text/")) {
    return <TextPreview artifact={artifact} isMarkdown={mime === "text/markdown"} />;
  }

  return (
    <div className="flex flex-col items-center gap-4 p-6 text-center">
      <div className="text-sm text-[var(--app-muted)]">
        <div>{artifact.mime ?? "unknown type"}</div>
        {artifact.sizeBytes !== undefined && (
          <div>{(artifact.sizeBytes / 1024).toFixed(1)} KB</div>
        )}
      </div>
      <a
        href={blobUrl}
        download={artifact.originalFilename ?? artifact.id}
        className="px-4 py-2 rounded border border-[var(--app-border)] text-sm hover:bg-[var(--app-hover)] transition-colors"
        data-testid="preview-download-link"
      >
        Download
      </a>
    </div>
  );
}

interface TextPreviewProps {
  artifact: Artifact;
  isMarkdown: boolean;
}

function TextPreview({ artifact, isMarkdown }: TextPreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [safeHtml, setSafeHtml] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const blobUrl = artifactBlobUrl(artifact.id);

  useEffect(() => {
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    fetch(blobUrl, { signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        setContent(text);
        if (isMarkdown) {
          try {
            const html = marked.parse(text, { async: false }) as string;
            // DOMPurify.sanitize removes event handlers and script tags before injection
            const clean = DOMPurify.sanitize(html);
            setSafeHtml(clean);
          } catch {
            setFetchError(true);
          }
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setFetchError(true);
        }
      });

    return () => {
      abortRef.current?.abort();
    };
  }, [blobUrl, isMarkdown]);

  if (fetchError) {
    return (
      <a
        href={blobUrl}
        download={artifact.originalFilename ?? artifact.id}
        className="text-sm px-4 py-2 rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)]"
        data-testid="preview-download-link"
      >
        Download (preview unavailable)
      </a>
    );
  }

  if (isMarkdown) {
    if (safeHtml === null) {
      return <div className="p-4 animate-pulse text-sm text-[var(--app-muted)]">Loading…</div>;
    }
    // safeHtml is the output of DOMPurify.sanitize — XSS-safe
    const sanitizedProps = { __html: safeHtml };
    return (
      <div
        className="prose prose-sm max-w-none p-4 overflow-auto"
        dangerouslySetInnerHTML={sanitizedProps}
        data-testid="markdown-render"
      />
    );
  }

  if (content === null) {
    return <div className="p-4 animate-pulse text-sm text-[var(--app-muted)]">Loading…</div>;
  }
  return (
    <pre
      className="p-4 overflow-auto whitespace-pre-wrap text-sm font-mono"
      data-testid="text-render"
    >
      {content}
    </pre>
  );
}
