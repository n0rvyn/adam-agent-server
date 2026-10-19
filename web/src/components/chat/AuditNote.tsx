import type { ChatMessageInfo } from "@/store/useChatStore.ts";

interface AuditNoteProps {
  message: ChatMessageInfo;
}

/**
 * Self-check guardrail note (Option A). The commitment audit no longer replaces the
 * assistant reply; when a claim lacks evidence it surfaces here as a distinctly-labeled,
 * non-destructive warning so the real reply stays intact above this note.
 */
export function AuditNote({ message }: AuditNoteProps) {
  return (
    <div
      className="chat-audit-note flex items-start gap-2 rounded border-l-2 border-amber-500/70 bg-amber-500/[0.06] px-3 py-2 text-xs text-[var(--app-text-subtle)]"
      data-testid="audit-note"
      role="note"
    >
      <span className="select-none text-amber-500">⚠️</span>
      <div className="min-w-0">
        <div className="mb-0.5 font-medium uppercase tracking-[0.12em] text-amber-500/90">
          自检 · 审计边车
        </div>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
      </div>
    </div>
  );
}
