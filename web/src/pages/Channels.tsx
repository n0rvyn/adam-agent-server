import { useEffect, useState } from "react";
import { Radio, Plug, PlugZap, Trash2, Plus, X, Pencil, MessageSquare } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";
import { api } from "@/lib/api.ts";

interface Channel {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
  linkedRoleId?: string;
  allowedChatIds?: string[];
  createdAt: number;
  updatedAt?: number;
  lastMessageAt?: number;
  messageCount: number;
}

interface ChatMessageInfo {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

const PLATFORMS = ["telegram", "slack", "discord", "openclaw", "wechat", "whatsapp", "email"] as const;

const PLATFORM_CONFIG_TEMPLATES: Record<string, string> = {
  telegram: '{\n  "botToken": ""\n}',
  slack: '{\n  "botToken": "",\n  "signingSecret": ""\n}',
  discord: '{\n  "botToken": ""\n}',
  openclaw: '{\n  "gatewayUrl": "ws://127.0.0.1:18789"\n}',
  wechat: '{\n  "baseUrl": "https://ilinkai.weixin.qq.com"\n}',
  whatsapp: '{}',
  email: '{\n  "address": "test1@test.com"\n}',
};

const statusVariant = (status: string) => {
  switch (status) {
    case "connected": return "success" as const;
    case "connecting": return "warning" as const;
    case "degraded": return "warning" as const;
    case "error": return "destructive" as const;
    default: return "secondary" as const;
  }
};

// --- Channel Form (inline, for add and edit) ---

function ChannelForm({ initial, onSubmit, onCancel }: {
  initial?: Partial<Channel>;
  onSubmit: (data: { name: string; platform: string; config: Record<string, unknown>; enabled: boolean }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [platform, setPlatform] = useState(initial?.platform ?? "telegram");
  const [configJson, setConfigJson] = useState(
    initial?.config
      ? JSON.stringify(initial.config, null, 2)
      : PLATFORM_CONFIG_TEMPLATES[initial?.platform ?? "telegram"] ?? "{}",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configJson);
    } catch {
      setError("Invalid JSON in config"); return;
    }
    setError("");
    onSubmit({ name: name.trim(), platform, config, enabled });
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-[var(--app-text)]">{initial ? "Edit Channel" : "New Channel"}</CardTitle>
          <Button variant="ghost" size="icon" type="button" onClick={onCancel}><X size={14} /></Button>
        </div>

        {error && <div className="text-xs text-[var(--app-danger)]">{error}</div>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[var(--app-text-muted)]">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Telegram Bot"
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="channel-platform" className="text-xs text-[var(--app-text-muted)]">Platform</label>
            <select id="channel-platform" value={platform} onChange={(e) => {
              setPlatform(e.target.value);
              if (!initial) setConfigJson(PLATFORM_CONFIG_TEMPLATES[e.target.value] ?? "{}");
            }}
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 text-sm text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none">
              {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-[var(--app-text-muted)]">Config (JSON)</label>
          <textarea value={configJson} onChange={(e) => setConfigJson(e.target.value)} rows={4}
            className="resize-none rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)] px-3 py-1.5 font-mono text-xs text-[var(--app-text)] placeholder:text-[var(--app-text-subtle)] focus:border-[var(--app-accent)] focus:outline-none" />
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="ch-enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
            className="rounded border-[var(--app-border)] bg-[var(--app-panel-elevated)]" />
          <label htmlFor="ch-enabled" className="text-xs text-[var(--app-text-muted)]">Enabled</label>
        </div>

        {!initial && platform === "wechat" && (
          <div className="rounded bg-[var(--app-accent-soft-bg)] border border-[var(--app-accent-soft-border)] px-3 py-2 text-xs text-[var(--app-accent)]">
            Creating a WeChat channel will start a QR code scan. Have your WeChat app ready.
          </div>
        )}

        <div className="flex gap-2">
          <Button type="submit" size="sm">{initial ? "Save" : platform === "wechat" && !initial ? "Create & Connect" : "Create"}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

// --- Channel Messages View ---

function ChannelMessages({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ messages: ChatMessageInfo[] }>(`/channels/${channelId}/messages`);
        setMessages(data.messages);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [channelId]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <CardTitle>Channel Messages</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}><X size={14} /></Button>
      </div>
      {loading ? (
        <div className="text-xs text-[var(--app-text-subtle)]">Loading...</div>
      ) : messages.length === 0 ? (
        <div className="text-xs text-[var(--app-text-subtle)]">No messages yet</div>
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-2">
          {messages.map((m) => (
            <div key={m.id} className="rounded bg-[var(--app-panel-elevated)]/50 px-3 py-2 text-xs">
              <div className="flex items-baseline gap-2">
              <span className={m.role === "user" ? "text-[var(--app-accent)]" : "text-[var(--app-success)]"}>{m.role}</span>
              <span className="text-[var(--app-text-subtle)]">{new Date(m.createdAt).toLocaleTimeString()}</span>
              </div>
              <div className="mt-1 text-[var(--app-text)]">{m.content}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function getActionError(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim().length > 0 ? err.message : fallback;
}

// --- Main Page ---

export function Channels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [viewingMessages, setViewingMessages] = useState<string | null>(null);
  const [wechatQr, setWechatQr] = useState<{ channelId: string; qrcodeUrl: string; sessionKey: string } | null>(null);
  const [wechatConnecting, setWechatConnecting] = useState(false);

  useEffect(() => {
    void fetchChannels();
  }, []);

  async function fetchChannels() {
    try {
      const data = await api<{ channels: Channel[] }>("/channels");
      setChannels(data.channels);
    } catch { /* Failed */ }
    setLoading(false);
  }

  async function handleCreate(data: { name: string; platform: string; config: Record<string, unknown>; enabled: boolean }) {
    try {
      const result = await api<{ channel: Channel }>("/channels", { method: "POST", body: JSON.stringify(data) });
      setNotice(null);
      setShowForm(false);
      void fetchChannels();

      // Auto-start QR scan for WeChat channels
      if (data.platform === "wechat" && result.channel?.id) {
        void handleConnect(result.channel.id);
      }
    } catch (err) {
      setNotice({ type: "error", text: getActionError(err, "Failed to create channel") });
    }
  }

  async function handleEdit(data: { name: string; platform: string; config: Record<string, unknown>; enabled: boolean }) {
    if (!editingChannel) return;
    try {
      await api(`/channels/${editingChannel.id}`, { method: "PATCH", body: JSON.stringify(data) });
      setNotice(null);
      setEditingChannel(null);
      void fetchChannels();
    } catch (err) {
      setNotice({ type: "error", text: getActionError(err, "Failed to update channel") });
    }
  }

  async function handleConnect(id: string) {
    setNotice(null);
    const ch = channels.find((c) => c.id === id);
    if (ch?.platform === "wechat") {
      // WeChat QR login flow
      try {
        const result = await api<{ qrcodeUrl?: string; sessionKey?: string; message: string }>(
          `/channels/${id}/wechat/qr-start`, { method: "POST" },
        );
        if (result.qrcodeUrl && result.sessionKey) {
          setWechatQr({ channelId: id, qrcodeUrl: result.qrcodeUrl, sessionKey: result.sessionKey });
          // Start polling for scan result
          setWechatConnecting(true);
          try {
            const waitResult = await api<{ connected: boolean; message: string }>(
              `/channels/${id}/wechat/qr-wait`,
              { method: "POST", body: JSON.stringify({ sessionKey: result.sessionKey, timeoutMs: 120000 }) },
            );
            if (waitResult.connected) {
              void fetchChannels();
            }
          } catch (err) {
            setNotice({ type: "error", text: getActionError(err, "WeChat connection timed out") });
          }
          setWechatQr(null);
          setWechatConnecting(false);
        }
      } catch (err) {
        setNotice({ type: "error", text: getActionError(err, "Failed to start WeChat login") });
      }
    } else {
      try {
        await api<{ channelId: string; status: string }>(`/channels/${id}/connect`, { method: "POST" });
        void fetchChannels();
      } catch (err) {
        setNotice({ type: "error", text: getActionError(err, "Failed to connect channel") });
      }
    }
  }

  async function handleDisconnect(id: string) {
    try {
      await api(`/channels/${id}/disconnect`, { method: "POST" });
      void fetchChannels();
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/channels/${id}`, { method: "DELETE" });
      setChannels((prev) => prev.filter((c) => c.id !== id));
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Delivery"
        title="Channels"
        description="Connection status, volume, and edit access for every delivery endpoint."
        metrics={[
          { label: "Connected", value: channels.filter((channel) => channel.status === "connected").length },
          { label: "Enabled", value: channels.filter((channel) => channel.enabled).length },
          { label: "Messages", value: channels.reduce((total, channel) => total + channel.messageCount, 0) },
        ]}
        compact
        actions={
          <Button size="sm" onClick={() => { setShowForm(true); setEditingChannel(null); }}>
            <Plus size={14} />
            Add Channel
          </Button>
        }
      />

      {notice && (
        <div className={`rounded-md border px-3 py-2 text-sm ${
          notice.type === "error"
            ? "border-[var(--app-danger-soft-border)] bg-[var(--app-danger-soft-bg)] text-[var(--app-danger-soft-text)]"
            : "border-[var(--app-success-soft-border)] bg-[var(--app-success-soft-bg)] text-[var(--app-success-soft-text)]"
        }`}>
          {notice.text}
        </div>
      )}

      <SectionHeader
        title="Endpoints"
        description="Connect, disconnect, edit, inspect messages, or add a new endpoint."
        compact
        action={<div className="text-xs text-[var(--app-text-subtle)]">{channels.length} channel{channels.length === 1 ? "" : "s"}</div>}
      />

      {/* Inline form for add/edit */}
      {showForm && !editingChannel && (
        <ChannelForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
      )}
      {editingChannel && (
        <ChannelForm initial={editingChannel} onSubmit={handleEdit} onCancel={() => setEditingChannel(null)} />
      )}

      {/* Message history view */}
      {viewingMessages && (
        <ChannelMessages channelId={viewingMessages} onClose={() => setViewingMessages(null)} />
      )}

      {/* WeChat QR Code Modal */}
      {wechatQr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <Card className="max-w-sm text-center">
            <CardTitle className="mb-3 text-[var(--app-text)]">Scan QR Code with WeChat</CardTitle>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(wechatQr.qrcodeUrl)}`}
              alt="WeChat QR Code"
              className="mx-auto h-64 w-64 rounded bg-white p-2"
            />
            <p className="mt-3 text-xs text-[var(--app-text-muted)]">
              {wechatConnecting ? "Waiting for scan..." : "Open WeChat and scan the QR code"}
            </p>
            <a
              href={wechatQr.qrcodeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-[10px] text-[var(--app-accent)] hover:text-[var(--app-accent)] truncate max-w-[280px] mx-auto"
            >
              {wechatQr.qrcodeUrl}
            </a>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => { setWechatQr(null); setWechatConnecting(false); }}>
              Cancel
            </Button>
          </Card>
        </div>
      )}

      {channels.length === 0 && !showForm ? (
        <Card>
          <EmptyState
            icon={<Radio size={ICON_SIZE.hero} />}
            title="No channels"
            description="Add a channel to connect Adam to messaging platforms like Telegram, Slack, or Discord."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {channels.map((ch) => (
            <Card key={ch.id}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Radio size={16} className="text-[var(--app-text-muted)]" />
                  <CardTitle className="text-[var(--app-text)]">{ch.name}</CardTitle>
                </div>
                <Badge variant={statusVariant(ch.status)}>{ch.status}</Badge>
              </CardHeader>

              <div className="space-y-2 text-xs text-[var(--app-text-muted)]">
                <div className="flex justify-between">
                  <span>Platform</span>
                  <span className="text-[var(--app-text)]">{ch.platform}</span>
                </div>
                <div className="flex justify-between">
                  <span>Messages</span>
                  <span className="text-[var(--app-text)]">{ch.messageCount}</span>
                </div>
                <div className="flex justify-between">
                  <span>Enabled</span>
                  <span className={ch.enabled ? "text-[var(--app-success)]" : "text-[var(--app-text-subtle)]"}>
                    {ch.enabled ? "Yes" : "No"}
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-[var(--app-border)] pt-3">
                {ch.status === "connected" ? (
                  <Button variant="secondary" size="sm" onClick={() => void handleDisconnect(ch.id)}>
                    <PlugZap size={12} /> Disconnect
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void handleConnect(ch.id)}>
                    <Plug size={12} /> Connect
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => { setEditingChannel(ch); setShowForm(false); }}>
                  <Pencil size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setViewingMessages(ch.id)}>
                  <MessageSquare size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleDelete(ch.id)}>
                  <Trash2 size={12} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
