import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft,  Plug, Clock, Hash, MessageSquare } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { api } from "@/lib/api.ts";
import { formatDateTime } from "@/lib/format.ts";

interface ChannelDetail {
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

interface DeliveryRule {
  id: string;
  eventType: string;
  target: { type: string; channelId?: string; chatId?: string };
  maxPerMinute: number;
  enabled: boolean;
}

interface DeliveryLogEntry {
  id: string;
  taskId: string;
  status: string;
  createdAt: number;
  deliveredAt?: number;
}

export function ChannelDetail() {
  const { id } = useParams<{ id: string }>();
  const [channel, setChannel] = useState<ChannelDetail | null>(null);
  const [deliveryRules, setDeliveryRules] = useState<DeliveryRule[]>([]);
  const [deliveryLog, setDeliveryLog] = useState<DeliveryLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        const data = await api<{ channel: ChannelDetail }>(`/channels/${id}`);
        setChannel(data.channel);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load channel");
      }
    };
    void load();
    api<DeliveryRule[]>(`/delivery-rules`)
      .then((rules) => setDeliveryRules(rules.filter((r) => r.target.type === "channel" && r.target.channelId === id)))
      .catch(() => setDeliveryRules([]));
    // Fetch delivery log entries for rules targeting this channel
    api<DeliveryRule[]>(`/delivery-rules`)
      .then(async (rules) => {
        const channelRules = rules.filter((r) => r.target.type === "channel" && r.target.channelId === id);
        const logs: DeliveryLogEntry[] = [];
        for (const rule of channelRules.slice(0, 3)) {
          try {
            const logData = await api<{ log: DeliveryLogEntry[] }>(`/delivery-rules/${rule.id}/log`);
            logs.push(...(logData.log ?? []));
          } catch { /* skip */ }
        }
        logs.sort((a, b) => b.createdAt - a.createdAt);
        setDeliveryLog(logs.slice(0, 20));
      })
      .catch(() => setDeliveryLog([]));
  }, [id]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/channels" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Channels
        </Link>
        <Card className="text-center text-[var(--app-danger)]">{error}</Card>
      </div>
    );
  }

  if (!channel) {
    return (
      <div className="space-y-4">
        <Link to="/channels" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
          <ArrowLeft size={14} /> Back to Channels
        </Link>
        <Card className="text-center text-[var(--app-text-subtle)]">Loading...</Card>
      </div>
    );
  }

  const statusVariant = (s: string) => {
    if (s === "connected") return "success";
    if (s === "connecting") return "warning";
    if (s === "error") return "destructive";
    return "secondary";
  };

  const platformLabel = (p: string) => {
    switch (p) {
      case "wechat": return "WeChat";
      case "telegram": return "Telegram";
      case "slack": return "Slack";
      case "discord": return "Discord";
      default: return p.charAt(0).toUpperCase() + p.slice(1);
    }
  };

  const maskedConfig = { ...channel.config };
  const sensitiveKeys = ["botToken", "apiKey", "secret", "password", "token"];
  for (const key of sensitiveKeys) {
    if (key in maskedConfig) {
      (maskedConfig as Record<string, unknown>)[key] = "********";
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/channels" className="flex items-center gap-1.5 text-sm text-[var(--app-text-muted)] hover:text-[var(--app-text)]">
        <ArrowLeft size={14} /> Back to Channels
      </Link>

      <PageHeader
        eyebrow="Channel"
        title={channel.name}
        compact
        description="Connectivity, delivery policy, and recent outbound activity."
        metrics={[
          { label: "Status", value: <Badge variant={statusVariant(channel.status) as "success" | "warning" | "destructive" | "secondary"}>{channel.status}</Badge> },
          { label: "Platform", value: platformLabel(channel.platform) },
          { label: "Enabled", value: channel.enabled ? "Yes" : "No" },
          { label: "Messages", value: channel.messageCount },
        ]}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <Card className="surface-panel-muted">
          <p className="text-section-label">Channel ID</p>
          <p className="mt-2 truncate font-mono text-sm text-[var(--app-text)]">{channel.id}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Linked role</p>
          <p className="mt-2 text-sm font-medium text-[var(--app-text)]">{channel.linkedRoleId ? `${channel.linkedRoleId.slice(0, 8)}...` : "None"}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Delivery rules</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{deliveryRules.length}</p>
        </Card>
        <Card className="surface-panel-muted">
          <p className="text-section-label">Recent delivery events</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--app-text)]">{deliveryLog.length}</p>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetaCard icon={Clock} label="Created" value={formatDateTime(channel.createdAt)} mono />
        <MetaCard icon={MessageSquare} label="Messages" value={String(channel.messageCount)} mono />
        {channel.lastMessageAt && (
          <MetaCard icon={Clock} label="Last Message" value={formatDateTime(channel.lastMessageAt)} mono />
        )}
        {channel.linkedRoleId && (
          <MetaCard icon={Plug} label="Linked Role" value={channel.linkedRoleId.slice(0, 8) + "..."} mono />
        )}
      </div>

      <SectionHeader
        title="Configuration"
        compact
        description="Raw config stays available below, but status and traffic stay first."
      />

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        {Object.keys(maskedConfig).length > 0 && (
          <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(maskedConfig).slice(0, 6).map(([key, value]) => (
              <div key={key} className="rounded-xl border border-[var(--app-border)] bg-black/10 px-3 py-2">
                <p className="text-[10px] uppercase tracking-[0.14em] text-[var(--app-text-subtle)]">{key}</p>
                <p className="mt-1 truncate text-sm text-[var(--app-text)]">{String(value)}</p>
              </div>
            ))}
          </div>
        )}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--app-panel-elevated)] p-3 font-mono text-xs text-[var(--app-text)]">
          {JSON.stringify(maskedConfig, null, 2)}
        </pre>
      </Card>

      <SectionHeader
        title="Delivery Activity"
        compact
        description="Rules and log entries stay grouped as one operational block."
      />

      {deliveryRules.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Hash size={14} /> Delivery Rules ({deliveryRules.length})</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            {deliveryRules.map((rule) => (
              <div key={rule.id} className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-elevated)]/50 p-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{rule.eventType}</Badge>
                  {rule.enabled ? (
                    <Badge variant="success">active</Badge>
                  ) : (
                    <Badge variant="secondary">disabled</Badge>
                  )}
                  <span className="text-xs text-[var(--app-text-subtle)]">max {rule.maxPerMinute}/min</span>
                </div>
                <p className="mt-1 text-xs text-[var(--app-text-muted)] font-mono">Rule: {rule.id}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {deliveryLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><MessageSquare size={14} /> Delivery Log ({deliveryLog.length})</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            {deliveryLog.slice(0, 10).map((entry) => (
              <div key={entry.id} className="flex items-center justify-between rounded-md border border-[var(--app-border)] p-2">
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="text-sm text-[var(--app-text)] font-mono">{entry.taskId.slice(0, 8)}</span>
                  <span className="text-xs text-[var(--app-text-subtle)]">{formatDateTime(entry.createdAt)}</span>
                </div>
                <Badge variant={entry.status === "delivered" ? "default" : entry.status === "failed" ? "destructive" : "outline"}>
                  {entry.status}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function MetaCard({
  icon: Icon,
  label,
  value,
  mono,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[var(--app-text-subtle)]">
        <Icon size={12} />
        <span className="text-xs">{label}</span>
      </div>
      <span className={`text-sm text-[var(--app-text)] truncate ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </span>
    </Card>
  );
}
