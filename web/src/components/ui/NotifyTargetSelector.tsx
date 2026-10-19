import { useEffect, useState } from "react";
import { api } from "@/lib/api.ts";
import type { NotifyTarget } from "@/lib/types.ts";

interface ChannelSession {
  id: string;
  channelId: string;
  channelName: string;
  platform: string;
  chatId: string;
}

interface NotifyTargetSelectorProps {
  value: NotifyTarget[];
  onChange: (targets: NotifyTarget[]) => void;
  label?: string;
}

/**
 * Multi-select for notification targets.
 * Lists active channel conversations (sessions with source.type === "channel")
 * so we get both channelId and chatId for delivery.
 */
export function NotifyTargetSelector({ value, onChange, label = "Delivery Targets" }: NotifyTargetSelectorProps) {
  const [channelSessions, setChannelSessions] = useState<ChannelSession[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Fetch both channels (for names) and sessions (for chatIds)
    let ignore = false;
    Promise.all([
      api<{ channels: Array<{ id: string; name: string; platform: string; enabled: boolean; config: Record<string, unknown> }> }>("/channels").catch(() => ({ channels: [] })),
      api<{ sessions: Array<{ id: string; source: { type: string; channelId?: string; chatId?: string } }> }>("/chat/sessions").catch(() => ({ sessions: [] })),
    ]).then(([channelData, sessionData]) => {
      if (ignore) return;
      const channelMap = new Map(channelData.channels.map((c) => [c.id, c]));
      const results: ChannelSession[] = [];

      for (const s of sessionData.sessions) {
        if (s.source.type === "channel" && s.source.channelId && s.source.chatId) {
          const ch = channelMap.get(s.source.channelId);
          results.push({
            id: s.id,
            channelId: s.source.channelId,
            channelName: ch?.name ?? s.source.channelId.slice(0, 8),
            platform: ch?.platform ?? "unknown",
            chatId: s.source.chatId,
          });
        }
      }
      for (const ch of channelData.channels) {
        if (ch.enabled && ch.platform === "email" && typeof ch.config.address === "string") {
          results.push({
            id: `email:${ch.id}`,
            channelId: ch.id,
            channelName: ch.name,
            platform: ch.platform,
            chatId: ch.config.address,
          });
        }
      }

      // Deduplicate by channelId + chatId
      const seen = new Set<string>();
      const deduped = results.filter((r) => {
        const key = `${r.channelId}:${r.chatId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      setChannelSessions(deduped);
    });
    return () => { ignore = true; };
  }, []);

  const isSelected = (channelId: string, chatId: string) =>
    value.some((t) => t.type === "channel" && t.channelId === channelId && t.chatId === chatId);

  const toggle = (channelId: string, chatId: string) => {
    if (isSelected(channelId, chatId)) {
      onChange(value.filter((t) => !(t.type === "channel" && t.channelId === channelId && t.chatId === chatId)));
    } else {
      onChange([...value, { type: "channel", channelId, chatId }]);
    }
  };

  const selectedCount = value.filter((t) => t.type === "channel").length;

  return (
    <div className="relative">
      <label className="text-xs text-[var(--app-text-muted)]">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-left text-sm text-[var(--app-text)] hover:border-[var(--app-border-strong)] focus:border-[var(--app-accent)] focus:outline-none"
      >
        {selectedCount === 0
          ? "Default (current session)"
          : `${selectedCount} channel${selectedCount > 1 ? "s" : ""} selected`}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] py-1 shadow-lg">
          {channelSessions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--app-text-subtle)]">
              No channel delivery targets available.
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-xs text-[var(--app-text-subtle)]">Channel conversations</div>
              {channelSessions.map((cs) => (
                <label
                  key={`${cs.channelId}:${cs.chatId}`}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-[var(--app-text)] hover:bg-[var(--app-panel-muted)]"
                >
                  <input
                    type="checkbox"
                    checked={isSelected(cs.channelId, cs.chatId)}
                    onChange={() => toggle(cs.channelId, cs.chatId)}
                    className="rounded border-[var(--app-border-strong)] bg-[var(--app-panel-muted)]"
                  />
                  <span className="truncate font-medium">{cs.channelName}</span>
                  <span className="text-[var(--app-text-subtle)]">({cs.platform})</span>
                </label>
              ))}
            </>
          )}
          {selectedCount > 0 && (
            <button
              type="button"
              onClick={() => { onChange([]); setOpen(false); }}
              className="mt-1 w-full border-t border-[var(--app-border)] px-3 py-1 text-left text-xs text-[var(--app-danger)] hover:bg-[var(--app-panel-muted)]"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="w-full border-t border-[var(--app-border)] px-3 py-1 text-left text-xs text-[var(--app-text-subtle)] hover:bg-[var(--app-panel-muted)]"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
