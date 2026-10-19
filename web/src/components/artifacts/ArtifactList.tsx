import { Music, Video, Image, FileText, File } from "lucide-react";
import type { Artifact } from "@/lib/types.ts";

interface ArtifactListProps {
  artifacts: Artifact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}

function mimeIcon(mime: string | undefined) {
  if (!mime) return File;
  if (mime.startsWith("audio/")) return Music;
  if (mime.startsWith("video/")) return Video;
  if (mime.startsWith("image/")) return Image;
  if (
    mime.startsWith("text/") ||
    mime === "application/pdf" ||
    mime.startsWith("application/vnd.")
  )
    return FileText;
  return File;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArtifactList({ artifacts, selectedId, onSelect, loading, error }: ArtifactListProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 rounded bg-[var(--app-border)] animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-500" data-testid="artifact-list-error">
        {error}
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="p-4 text-sm text-[var(--app-muted)]" data-testid="artifact-list-empty">
        No artifacts found.
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-[var(--app-border)]" data-testid="artifact-list">
      {artifacts.map((artifact) => {
        const Icon = mimeIcon(artifact.mime);
        const isSelected = artifact.id === selectedId;
        return (
          <button
            key={artifact.id}
            type="button"
            className={`flex items-center gap-3 px-4 text-left cursor-pointer hover:bg-[var(--app-hover)] transition-colors ${
              isSelected ? "bg-[var(--app-selected)]" : ""
            }`}
            style={{ minHeight: "48px" }}
            onClick={() => onSelect(artifact.id)}
            data-testid={`artifact-row-${artifact.id}`}
          >
            <Icon className="w-4 h-4 shrink-0 text-[var(--app-muted)]" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {artifact.originalFilename ?? artifact.key ?? artifact.id}
              </div>
              <div className="text-xs text-[var(--app-muted)] flex gap-2">
                <span>{artifact.mime ?? "unknown"}</span>
                <span>{formatBytes(artifact.sizeBytes)}</span>
                <span>{formatDate(artifact.createdAt)}</span>
                {artifact.sourceKind && (
                  <span className="opacity-70">{artifact.sourceKind}</span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
