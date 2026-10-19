import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api.ts";
import { redeliverArtifact } from "@/lib/api/artifacts.ts";

interface Channel {
  id: string;
  name: string;
  platform: string;
}

interface ChannelPickerProps {
  artifactId: string;
  onRedelivered: () => void;
  onClose: () => void;
}

export function ChannelPicker({ artifactId, onRedelivered, onClose }: ChannelPickerProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ channels: Channel[] }>("/channels")
      .then((r) => setChannels(r.channels))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleSelect(channelId: string) {
    setSubmitting(true);
    try {
      await redeliverArtifact(artifactId, { channelId });
      onRedelivered();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="channel-picker-backdrop"
    >
      <div
        className="bg-[var(--app-bg)] border border-[var(--app-border)] rounded-lg shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="channel-picker"
      >
        <h2 className="text-base font-semibold mb-4">Redeliver to channel</h2>
        {loading && <div className="text-sm text-[var(--app-muted)]">Loading channels…</div>}
        {error && <div className="text-sm text-red-500">{error}</div>}
        {!loading && !error && channels.length === 0 && (
          <div className="text-sm text-[var(--app-muted)]">No channels configured.</div>
        )}
        <ul className="flex flex-col gap-2">
          {channels.map((ch) => (
            <li key={ch.id}>
              <button
                type="button"
                disabled={submitting}
                onClick={() => handleSelect(ch.id)}
                className="w-full text-left px-3 py-2 rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)] text-sm disabled:opacity-50 transition-colors"
                data-testid={`channel-option-${ch.id}`}
              >
                <span className="font-medium">{ch.name}</span>
                <span className="ml-2 text-xs text-[var(--app-muted)]">{ch.platform}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1 rounded border border-[var(--app-border)] hover:bg-[var(--app-hover)]"
            data-testid="channel-picker-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
