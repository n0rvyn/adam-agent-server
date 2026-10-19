import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { SectionHeader } from "@/components/layout/SectionHeader.tsx";
import { api } from "@/lib/api.ts";

type SourceType = "webhook" | "directory_watch" | "cron" | "manual";

interface EventDef {
  id: string;
  name: string;
  sourceType: SourceType;
  sourceConfig: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

interface Event {
  id: string;
  eventDefId: string;
  occurredAt: string;
  ingestedAt: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  dedupKey: string;
  confidence: number;
}

const SOURCE_COLORS: Record<SourceType, "info" | "warning" | "success" | "muted"> = {
  webhook: "info",
  directory_watch: "warning",
  cron: "success",
  manual: "muted",
};

type Tab = "config" | "firings" | "dispatches";

interface Dispatch {
  executionId: string;
  templateId: string;
  templateName: string | null;
  status: "running" | "completed" | "failed" | "partial" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  eventId: string;
  eventOccurredAt: string | null;
  eventPayload: Record<string, unknown> | null;
}

const DISPATCH_STATUS_VARIANT: Record<Dispatch["status"], "info" | "success" | "destructive" | "warning" | "muted"> = {
  running: "info",
  completed: "success",
  failed: "destructive",
  partial: "warning",
  cancelled: "muted",
};

export function EventDefDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [eventDef, setEventDef] = useState<EventDef | null>(null);
  const [loadingDef, setLoadingDef] = useState(true);
  const [firings, setFirings] = useState<Event[]>([]);
  const [loadingFirings, setLoadingFirings] = useState(false);
  const [firingPage, setFiringPage] = useState(0);
  const [hasMoreFirings, setHasMoreFirings] = useState(false);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [loadingDispatches, setLoadingDispatches] = useState(false);
  const [dispatchPage, setDispatchPage] = useState(0);
  const [hasMoreDispatches, setHasMoreDispatches] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("config");

  const fetchEventDef = useCallback(async () => {
    if (!id) return;
    setLoadingDef(true);
    try {
      const data = await api<EventDef>(`/event-defs/${id}`);
      setEventDef(data);
    } catch {
      toast.error("Event not found");
      navigate("/events");
    } finally {
      setLoadingDef(false);
    }
  }, [id, navigate]);

  const fetchFirings = useCallback(async (page = 0) => {
    if (!id) return;
    setLoadingFirings(true);
    try {
      const since = page === 0 ? undefined : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({ limit: "20", ...(since ? { since } : {}) });
      const data = await api<Event[]>(`/event-defs/${id}/firings?${params}`);
      if (page === 0) {
        setFirings(data);
      } else {
        setFirings((prev) => [...prev, ...data]);
      }
      setHasMoreFirings(data.length === 20);
      setFiringPage(page);
    } catch {
      toast.error("Failed to load firings");
    } finally {
      setLoadingFirings(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchEventDef();
  }, [fetchEventDef]);

  useEffect(() => {
    if (activeTab === "firings" && firings.length === 0) {
      void fetchFirings(0);
    }
  }, [activeTab, fetchFirings, firings.length]);

  const fetchDispatches = useCallback(async (page = 0) => {
    if (!id) return;
    setLoadingDispatches(true);
    try {
      const params = new URLSearchParams({ limit: "20", offset: String(page * 20) });
      const data = await api<Dispatch[]>(`/event-defs/${id}/dispatches?${params}`);
      if (page === 0) {
        setDispatches(data);
      } else {
        setDispatches((prev) => [...prev, ...data]);
      }
      setHasMoreDispatches(data.length === 20);
      setDispatchPage(page);
    } catch {
      toast.error("Failed to load dispatches");
    } finally {
      setLoadingDispatches(false);
    }
  }, [id]);

  useEffect(() => {
    if (activeTab === "dispatches" && dispatches.length === 0) {
      void fetchDispatches(0);
    }
  }, [activeTab, fetchDispatches, dispatches.length]);

  const copyWebhookUrl = () => {
    if (!eventDef) return;
    const url = `${window.location.origin}/webhooks/events/${eventDef.id}`;
    void navigator.clipboard.writeText(url);
    toast.success("Webhook URL copied to clipboard");
  };

  if (loadingDef) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
      </div>
    );
  }

  if (!eventDef) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/events")}>
          <ArrowLeft size={14} />
        </Button>
        <SectionHeader
          title={eventDef.name}
          description={eventDef.description}
          compact
          action={
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void fetchEventDef()}>
                <RefreshCw size={14} />
              </Button>
            </div>
          }
        />
      </div>

      {/* Source badge */}
      <div className="flex items-center gap-3">
        <Badge variant={SOURCE_COLORS[eventDef.sourceType]}>
          {eventDef.sourceType === "directory_watch" ? "file watcher" : eventDef.sourceType}
        </Badge>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${eventDef.enabled ? "bg-green-900/30 text-green-400" : "bg-gray-800/30 text-gray-400"}`}>
          {eventDef.enabled ? "Enabled" : "Disabled"}
        </span>
        <span className="text-xs text-[var(--app-text-muted)]">
          Created {new Date(eventDef.createdAt).toLocaleDateString()}
        </span>
      </div>

      {/* Webhook URL */}
      {eventDef.sourceType === "webhook" && (
        <Card className="space-y-2">
          <span className="text-xs font-medium text-[var(--app-text-muted)]">Webhook URL</span>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 font-mono text-xs text-[var(--app-text)] break-all">
              {window.location.origin}/webhooks/events/{eventDef.id}
            </code>
            <Button size="sm" variant="ghost" onClick={copyWebhookUrl}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-[var(--app-text-muted)]">
            Send a POST request with JSON body: <code className="rounded bg-[var(--app-panel)] px-1">{"{ \"type\": \"event.name\", \"payload\": {...} }"}</code>
          </p>
        </Card>
      )}

      {/* Cron source config */}
      {(() => {
        const cron = eventDef.sourceConfig?.["cron"] as string | undefined;
        return cron ? (
          <Card className="space-y-2">
            <span className="text-xs font-medium text-[var(--app-text-muted)]">Schedule</span>
            <code className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 font-mono text-sm text-[var(--app-text)]">
              {cron}
            </code>
          </Card>
        ) : null;
      })()}

      {/* Directory watch config */}
      {(() => {
        const path = eventDef.sourceConfig?.["path"] as string | undefined;
        return path ? (
          <Card className="space-y-2">
            <span className="text-xs font-medium text-[var(--app-text-muted)]">Watch Directory</span>
            <code className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 font-mono text-sm text-[var(--app-text)] break-all">
              {path}
            </code>
          </Card>
        ) : null;
      })()}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--app-border)]">
        <button
          type="button"
          onClick={() => setActiveTab("config")}
          className={`px-4 py-2 text-sm transition-colors ${activeTab === "config" ? "border-b-2 border-[var(--app-accent)] text-[var(--app-text)]" : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"}`}
        >
          Configuration
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("firings")}
          className={`px-4 py-2 text-sm transition-colors ${activeTab === "firings" ? "border-b-2 border-[var(--app-accent)] text-[var(--app-text)]" : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"}`}
        >
          Firings
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("dispatches")}
          className={`px-4 py-2 text-sm transition-colors ${activeTab === "dispatches" ? "border-b-2 border-[var(--app-accent)] text-[var(--app-text)]" : "text-[var(--app-text-muted)] hover:text-[var(--app-text)]"}`}
        >
          Dispatches
        </button>
      </div>

      {/* Firings tab */}
      {activeTab === "firings" && (
        <Card padding={false}>
          {loadingFirings && firings.length === 0 ? (
            <div className="flex items-center justify-center p-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
            </div>
          ) : firings.length === 0 ? (
            <EmptyState
              icon={<RefreshCw size={32} />}
              title="No firings yet"
              description="This event has not been triggered yet."
            />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Occurred At</Th>
                    <Th>Type</Th>
                    <Th>Source</Th>
                    <Th>Confidence</Th>
                    <Th>Payload</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {firings.map((event) => (
                    <Tr key={event.id}>
                      <Td className="text-xs text-[var(--app-text-muted)] whitespace-nowrap">
                        {new Date(event.occurredAt).toLocaleString()}
                      </Td>
                      <Td>
                        <code className="text-xs font-mono text-[var(--app-text)]">{event.type}</code>
                      </Td>
                      <Td className="text-xs text-[var(--app-text-muted)]">{event.source}</Td>
                      <Td className="text-xs">
                        <span className={event.confidence < 1 ? "text-yellow-400" : "text-[var(--app-text-muted)]"}>
                          {event.confidence}
                        </span>
                      </Td>
                      <Td className="max-w-[200px]">
                        <code className="text-xs font-mono text-[var(--app-text-muted)] truncate block">
                          {JSON.stringify(event.payload).slice(0, 60)}
                          {JSON.stringify(event.payload).length > 60 ? "..." : ""}
                        </code>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
              {hasMoreFirings && (
                <div className="flex justify-center p-3 border-t border-[var(--app-border)]">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void fetchFirings(firingPage + 1)}
                    disabled={loadingFirings}
                  >
                    {loadingFirings ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Dispatches tab */}
      {activeTab === "dispatches" && (
        <Card padding={false}>
          {loadingDispatches && dispatches.length === 0 ? (
            <div className="flex items-center justify-center p-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
            </div>
          ) : dispatches.length === 0 ? (
            <EmptyState
              icon={<RefreshCw size={32} />}
              title="No dispatches yet"
              description="No task template has been dispatched from this event. Bind a template (trigger=event, eventDefId=this event) to see dispatch history."
            />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Started At</Th>
                    <Th>Template</Th>
                    <Th>Status</Th>
                    <Th>Duration</Th>
                    <Th>Error</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {dispatches.map((d) => {
                    const duration = d.completedAt ? `${(d.completedAt - d.startedAt)}ms` : "—";
                    return (
                      <Tr key={d.executionId}>
                        <Td className="text-xs text-[var(--app-text-muted)] whitespace-nowrap">
                          {new Date(d.startedAt).toLocaleString()}
                        </Td>
                        <Td>
                          <button
                            type="button"
                            onClick={() => navigate(`/templates/${d.templateId}`)}
                            className="text-[var(--app-text)] hover:text-[var(--app-accent)] transition-colors text-left"
                          >
                            {d.templateName ?? d.templateId}
                          </button>
                        </Td>
                        <Td>
                          <Badge variant={DISPATCH_STATUS_VARIANT[d.status]}>{d.status}</Badge>
                        </Td>
                        <Td className="text-xs text-[var(--app-text-muted)]">{duration}</Td>
                        <Td className="max-w-[300px]">
                          {d.error ? (
                            <code className="text-xs font-mono text-[var(--app-danger)] truncate block" title={d.error}>
                              {d.error.length > 80 ? `${d.error.slice(0, 80)}…` : d.error}
                            </code>
                          ) : (
                            <span className="text-xs text-[var(--app-text-subtle)]">—</span>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
              {hasMoreDispatches && (
                <div className="flex justify-center p-3 border-t border-[var(--app-border)]">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void fetchDispatches(dispatchPage + 1)}
                    disabled={loadingDispatches}
                  >
                    {loadingDispatches ? "Loading..." : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
