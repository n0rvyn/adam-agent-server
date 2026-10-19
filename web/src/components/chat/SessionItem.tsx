import type { KeyboardEvent } from "react";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import type { ChatSessionInfo } from "@/store/useChatStore.ts";
import { clsx } from "clsx";
import { timeAgo } from "@/lib/format.ts";
import { Button } from "@/components/ui/Button.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";

interface SessionItemProps {
  session: ChatSessionInfo;
  isActive: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onSelect, onArchive, onRestore, onDelete }: SessionItemProps) {
  const isArchived = session.status === "archived";
  const handleActionKeyDown = (e: KeyboardEvent<HTMLButtonElement>, action: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      action();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={clsx(
        "group flex w-full flex-col gap-1 rounded-lg border px-3 py-3 text-left transition-colors",
        isActive
          ? "border-[var(--app-border-strong)] bg-white/[0.08] text-[var(--app-text)]"
          : "border-transparent text-[var(--app-text-muted)] hover:border-[var(--app-border)] hover:bg-white/[0.04] hover:text-[var(--app-text)]",
        isArchived && "opacity-60",
      )}
      aria-label={session.title ?? session.id.slice(0, 8)}
    >
      <div className="flex items-center justify-between">
        <span className="truncate text-sm font-medium">
          {session.title ?? session.id.slice(0, 8)}
        </span>
        <div
          className={clsx(
            "flex gap-0.5 transition-opacity",
            isActive ? "opacity-100" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100",
          )}
        >
          {isArchived ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-[var(--app-text-subtle)] hover:text-[var(--app-success)]"
              onClick={(e) => { e.stopPropagation(); onRestore(); }}
              onKeyDown={(e) => handleActionKeyDown(e, onRestore)}
              title="Restore session"
              aria-label="Restore session"
            >
              <RotateCcw size={ICON_SIZE.xs} />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-[var(--app-text-subtle)] hover:text-[var(--app-warning)]"
              onClick={(e) => { e.stopPropagation(); onArchive(); }}
              onKeyDown={(e) => handleActionKeyDown(e, onArchive)}
              title="Archive session"
              aria-label="Archive session"
            >
              <Archive size={ICON_SIZE.xs} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-[var(--app-text-subtle)] hover:text-[var(--app-danger)]"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onKeyDown={(e) => handleActionKeyDown(e, onDelete)}
            title="Delete session"
            aria-label="Delete session"
          >
            <Trash2 size={ICON_SIZE.xs} />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[var(--app-text-subtle)]">
        <span>{session.messageCount} turns</span>
        <span>{timeAgo(session.lastActiveAt)}</span>
        {isArchived && (
          <span className="rounded-full border border-[var(--app-border)] bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.16em]">archived</span>
        )}
      </div>
    </div>
  );
}
