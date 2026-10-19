import type { ChatMessageInfo } from "@/store/useChatStore.ts";

interface SystemNoteProps {
  message: ChatMessageInfo;
}

export function SystemNote({ message }: SystemNoteProps) {
  return (
    <div
      className="chat-system-note flex items-center gap-2 rounded border-l-2 border-[var(--app-text-subtle)] bg-white/[0.02] px-3 py-1.5 text-xs italic text-[var(--app-text-subtle)]"
      data-testid="system-note"
      role="note"
    >
      <span className="select-none">●</span>
      <span className="whitespace-pre-wrap break-words">{message.content}</span>
    </div>
  );
}
