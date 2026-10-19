import { clsx } from "clsx";
import { FileText, Image as ImageIcon, Database, Trash2, Archive } from "lucide-react";
import type { ChatAttachmentInfo } from "@/store/useChatStore.ts";

const PURPOSE_ICON = {
  report: FileText,
  media: ImageIcon,
  data: Database,
  scratch: Trash2,
  archive: Archive,
} as const;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentChipProps {
  attachment: ChatAttachmentInfo;
  onPreview?: (a: ChatAttachmentInfo) => void;
}

export function AttachmentChip({ attachment, onPreview }: AttachmentChipProps) {
  const Icon = attachment.purpose ? PURPOSE_ICON[attachment.purpose] : FileText;
  return (
    <button
      type="button"
      onClick={() => onPreview?.(attachment)}
      className={clsx(
        "inline-flex items-center gap-2 rounded-md border border-[var(--app-border)] bg-white/[0.04] px-3 py-1.5 text-xs text-[var(--app-text-muted)] transition-colors hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]",
      )}
      title={`${attachment.filename} · ${formatBytes(attachment.size)} · ${attachment.mimeType}${attachment.purpose ? ` · purpose=${attachment.purpose}` : ""}`}
      data-testid="attachment-chip"
      data-purpose={attachment.purpose ?? "unknown"}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="font-medium text-[var(--app-text)]">{attachment.filename}</span>
      <span className="text-[var(--app-text-subtle)]">· {formatBytes(attachment.size)}</span>
    </button>
  );
}
