import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, RefreshCw, Trash2, ExternalLink } from "lucide-react";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import { DangerConfirmDialog } from "./DangerConfirmDialog.tsx";
import { ChannelPicker } from "./ChannelPicker.tsx";
import { deleteArtifact, downloadArtifactBlob } from "@/lib/api/artifacts.ts";
import { getDangerClass } from "@/lib/danger-class.ts";
import type { Artifact } from "@/lib/types.ts";

interface ArtifactDetailProps {
  artifact: Artifact;
  onDeleted: () => void;
  onRedelivered: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function filenameForArtifact(artifact: Artifact): string {
  return artifact.originalFilename ?? artifact.key ?? artifact.id;
}

export function ArtifactDetail({
  artifact,
  onDeleted,
  onRedelivered,
}: ArtifactDetailProps) {
  const navigate = useNavigate();
  const [showDangerDialog, setShowDangerDialog] = useState(false);
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const dangerClass = getDangerClass(artifact.mime);

  async function handleDownload() {
    try {
      await downloadArtifactBlob(artifact.id, filenameForArtifact(artifact));
    } catch (e) {
      // toast would go here; for now silently log
      console.error("Download failed:", e);
    }
  }

  async function confirmDelete(confirm: boolean) {
    setShowDangerDialog(false);
    try {
      await deleteArtifact(artifact.id, confirm);
      onDeleted();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleDelete() {
    if (dangerClass) {
      setShowDangerDialog(true);
    } else {
      confirmDelete(false);
    }
  }

  // Source Task button logic (DP-001)
  let sourceTaskButton: React.ReactNode = null;
  if (artifact.taskId) {
    sourceTaskButton = (
      <button
        type="button"
        onClick={() => navigate(`/tasks/${artifact.taskId}`)}
        className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)] transition-colors"
        data-testid="source-task-btn"
      >
        <ExternalLink className="w-4 h-4" aria-hidden />
        Source Task
      </button>
    );
  } else if (artifact.executionId) {
    sourceTaskButton = (
      <div className="relative group">
        <button
          type="button"
          disabled
          className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-[var(--app-border)] opacity-50 cursor-not-allowed"
          data-testid="source-task-btn-disabled"
        >
          <ExternalLink className="w-4 h-4" aria-hidden />
          Source Task
        </button>
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs bg-[var(--app-surface)] border border-[var(--app-border)] rounded shadow whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
          data-testid="source-task-tooltip"
        >
          This file came from a template execution — view it in the Work view.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="artifact-detail">
      {/* Metadata */}
      <div className="border-b border-[var(--app-border)] p-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div className="text-[var(--app-muted)]">Filename</div>
        <div className="truncate">{artifact.originalFilename ?? "—"}</div>
        <div className="text-[var(--app-muted)]">Type</div>
        <div>{artifact.mime ?? "—"}</div>
        <div className="text-[var(--app-muted)]">Size</div>
        <div>{formatBytes(artifact.sizeBytes)}</div>
        <div className="text-[var(--app-muted)]">Created</div>
        <div>{formatDate(artifact.createdAt)}</div>
        <div className="text-[var(--app-muted)]">Source</div>
        <div>{artifact.sourceKind}</div>
      </div>

      {/* Preview */}
      <div className="flex-1 overflow-auto p-4">
        <ArtifactPreview artifact={artifact} />
      </div>

      {/* Actions */}
      <div className="border-t border-[var(--app-border)] p-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleDownload}
          className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)] transition-colors"
          data-testid="download-btn"
        >
          <Download className="w-4 h-4" aria-hidden />
          Download
        </button>

        <button
          type="button"
          onClick={() => setShowChannelPicker(true)}
          className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)] transition-colors"
          data-testid="redeliver-btn"
        >
          <RefreshCw className="w-4 h-4" aria-hidden />
          Redeliver
        </button>

        <button
          type="button"
          onClick={handleDelete}
          className="flex items-center gap-1 px-3 py-2 text-sm rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
          data-testid="delete-btn"
        >
          <Trash2 className="w-4 h-4" aria-hidden />
          Delete
        </button>

        {sourceTaskButton}
      </div>

      {deleteError && (
        <div className="px-4 pb-2 text-sm text-red-500" data-testid="delete-error">
          {deleteError}
        </div>
      )}

      {showDangerDialog && dangerClass && (
        <DangerConfirmDialog
          open={showDangerDialog}
          dangerClass={dangerClass}
          originalFilename={artifact.originalFilename}
          onConfirm={() => confirmDelete(true)}
          onCancel={() => setShowDangerDialog(false)}
        />
      )}

      {showChannelPicker && (
        <ChannelPicker
          artifactId={artifact.id}
          onRedelivered={onRedelivered}
          onClose={() => setShowChannelPicker(false)}
        />
      )}
    </div>
  );
}
