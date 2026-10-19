import { useEffect, useState } from "react";
import { Webhook, Play, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { api } from "@/lib/api.ts";

interface WebhookInfo {
  name: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  trigger: string;
}

interface WebhookListResponse {
  webhooks: WebhookInfo[];
  auth: string;
}

export function Webhooks() {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [auth, setAuth] = useState("");
  const [loading, setLoading] = useState(true);
  const [triggeringName, setTriggeringName] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadWebhooks = async () => {
    try {
      const data = await api<WebhookListResponse>("/webhooks");
      setWebhooks(data.webhooks);
      setAuth(data.auth);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to load" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWebhooks();
  }, []);

  const handleTrigger = async (name: string) => {
    setTriggeringName(name);
    setMessage(null);
    try {
      await api(`/webhooks/${name}`, { method: "POST" });
      setMessage({ type: "success", text: `Triggered: ${name}` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Trigger failed" });
    } finally {
      setTriggeringName(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--app-text)]">Webhooks</h1>
        <Button variant="ghost" size="sm" onClick={() => void loadWebhooks()}>
          <RefreshCw size={14} />
        </Button>
      </div>

      {auth && (
        <div className="rounded bg-[var(--app-panel)] px-3 py-2 text-xs text-[var(--app-text-muted)]">
          Auth: <Badge variant="muted">{auth}</Badge>
        </div>
      )}

      {message && (
        <div className={`rounded px-3 py-2 text-sm ${message.type === "success" ? "bg-[var(--app-success-soft-bg)] text-[var(--app-success)]" : "bg-[var(--app-danger-soft-bg)] text-[var(--app-danger)]"}`}>
          {message.text}
        </div>
      )}

      <Card padding={false}>
        {webhooks.length === 0 ? (
          <EmptyState
            icon={<Webhook size={32} />}
            title="No webhooks"
            description="Webhooks are derived from task templates with webhook triggers"
          />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Description</Th>
                <Th>Trigger</Th>
                <Th>Tags</Th>
                <Th></Th>
              </Tr>
            </Thead>
            <Tbody>
              {webhooks.map((wh) => (
                <Tr key={wh.name}>
                  <Td className="font-medium text-[var(--app-text)]">{wh.displayName ?? wh.name}</Td>
                  <Td className="text-sm text-[var(--app-text-muted)]">{wh.description ?? "\u2014"}</Td>
                  <Td>
                    <Badge variant="muted">{wh.trigger}</Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {wh.tags?.map((t) => (
                        <span key={t} className="rounded bg-[var(--app-panel-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--app-text-muted)]">{t}</span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleTrigger(wh.name)}
                      disabled={triggeringName === wh.name}
                      title="Trigger webhook"
                    >
                      <Play size={12} className="text-[var(--app-success)]" />
                      {triggeringName === wh.name ? "..." : ""}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
