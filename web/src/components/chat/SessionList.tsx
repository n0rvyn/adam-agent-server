import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button.tsx";
import { SessionItem } from "./SessionItem.tsx";
import type { ChatSessionInfo } from "@/store/useChatStore.ts";
import { useMemo } from "react";

interface SessionListProps {
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onArchiveSession: (id: string) => void;
  onRestoreSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onClose?: () => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteSession,
  onClose,
}: SessionListProps) {
  const { recentSessions, earlierSessions, archivedSessions, activeSessions } = useMemo(() => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const active = sessions.filter((s) => s.status === "active");
    return {
      recentSessions: active.filter((s) => now - s.lastActiveAt < oneDay),
      earlierSessions: active.filter((s) => now - s.lastActiveAt >= oneDay),
      archivedSessions: sessions.filter((s) => s.status === "archived"),
      activeSessions: active,
    };
  }, [sessions]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
        <div>
          <span className="text-section-label">Sessions</span>
          <p className="mt-1 text-xs text-[var(--app-text-subtle)]">Switch context or reopen archived work.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onNewSession} aria-label="New session">
          <Plus size={14} />
          <span className="hidden sm:inline">New</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {activeSessions.length === 0 && archivedSessions.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-[var(--app-text-subtle)]">
            No sessions yet
          </div>
        )}

        {recentSessions.length > 0 && (
          <>
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--app-text-subtle)]">
              Today
            </div>
            <div className="space-y-1">
              {recentSessions.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  isActive={s.id === activeSessionId}
                  onSelect={() => {
                    onSelectSession(s.id);
                    onClose?.();
                  }}
                  onArchive={() => onArchiveSession(s.id)}
                  onRestore={() => onRestoreSession(s.id)}
                  onDelete={() => onDeleteSession(s.id)}
                />
              ))}
            </div>
          </>
        )}

        {earlierSessions.length > 0 && (
          <>
            <div className="mb-2 mt-4 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--app-text-subtle)]">
              Earlier
            </div>
            <div className="space-y-1">
              {earlierSessions.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  isActive={s.id === activeSessionId}
                  onSelect={() => {
                    onSelectSession(s.id);
                    onClose?.();
                  }}
                  onArchive={() => onArchiveSession(s.id)}
                  onRestore={() => onRestoreSession(s.id)}
                  onDelete={() => onDeleteSession(s.id)}
                />
              ))}
            </div>
          </>
        )}

        {archivedSessions.length > 0 && (
          <>
            <div className="mb-2 mt-4 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--app-text-subtle)]">
              Archived
            </div>
            <div className="space-y-1">
              {archivedSessions.map((s) => (
                <SessionItem
                key={s.id}
                session={s}
                isActive={s.id === activeSessionId}
                onSelect={() => {
                  onSelectSession(s.id);
                  onClose?.();
                }}
                onArchive={() => onArchiveSession(s.id)}
                onRestore={() => onRestoreSession(s.id)}
                onDelete={() => onDeleteSession(s.id)}
              />
            ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
