import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

interface DangerConfirmDialogProps {
  open: boolean;
  dangerClass: string;
  originalFilename?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DangerConfirmDialog({
  open,
  dangerClass,
  originalFilename,
  onConfirm,
  onCancel,
}: DangerConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      data-testid="danger-dialog-backdrop"
    >
      <div
        className="relative bg-[var(--app-bg)] border-2 border-red-500 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="danger-dialog-title"
        data-testid="danger-dialog"
      >
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="w-6 h-6 text-red-500 shrink-0" aria-hidden />
          <h2
            id="danger-dialog-title"
            className="text-base font-semibold text-red-600"
          >
            Confirm Delete
          </h2>
        </div>

        <p className="text-sm mb-2" data-testid="danger-dialog-body">
          This is a <strong>{dangerClass}</strong> file. Confirm permanent delete?
        </p>

        {originalFilename && (
          <p className="text-sm text-[var(--app-muted)] mb-4 truncate" data-testid="danger-dialog-filename">
            {originalFilename}
          </p>
        )}

        <div className="flex gap-3 justify-end mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)] transition-colors"
            data-testid="danger-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
            data-testid="danger-dialog-confirm"
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
