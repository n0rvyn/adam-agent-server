import { useEffect, useRef, useState, useMemo } from "react";
import { Eraser, Pause, Play, Terminal } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { ICON_SIZE } from "@/lib/ui.ts";

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-[var(--app-text-subtle)]",
  info: "text-[var(--app-accent)]",
  warn: "text-[var(--app-warning)]",
  error: "text-[var(--app-danger)]",
};

const COMPONENT_COLORS: Record<string, string> = {
  adam: "text-[var(--app-log-adam)]",
  manager: "text-[var(--app-log-manager)]",
  worker: "text-[var(--app-success)]",
  scheduler: "text-[var(--app-log-scheduler)]",
  api: "text-[var(--app-accent)]",
  ws: "text-[var(--app-log-ws)]",
  store: "text-[var(--app-log-store)]",
  embedding: "text-[var(--app-log-embedding)]",
};

const ALL_COMPONENTS = ["adam", "manager", "worker", "scheduler", "api", "ws", "store", "embedding"];
const ALL_LEVELS = ["debug", "info", "warn", "error"];

export function Logs() {
  const logs = useAppStore((s) => s.logs);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [componentFilter, setComponentFilter] = useState<string | null>(null);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter && log.level !== levelFilter) return false;
      if (componentFilter && log.component !== componentFilter) return false;
      return true;
    });
  }, [logs, levelFilter, componentFilter]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  const handleClear = () => {
    // Clear logs by resetting the store
    useAppStore.setState({ logs: [] });
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <PageHeader
        title="Logs"
        compact
        description="Backend events with inline filters and a stable reading surface."
        metrics={[
          { label: "Visible", value: filteredLogs.length },
          { label: "Total", value: logs.length },
          { label: "Mode", value: autoScroll ? "Live" : "Paused" },
        ]}
        className="px-4 py-3 lg:px-4 lg:py-3"
        actions={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? "Pause auto-scroll" : "Resume auto-scroll"}
            >
              {autoScroll ? <Pause size={ICON_SIZE.sm} /> : <Play size={ICON_SIZE.sm} />}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClear} title="Clear logs">
              <Eraser size={ICON_SIZE.sm} />
            </Button>
          </div>
        }
      />

      <Card className="surface-panel-muted py-3">
        <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--app-text-subtle)]">Level:</span>
          <div className="flex gap-1">
            <FilterButton active={levelFilter === null} onClick={() => setLevelFilter(null)}>
              All
            </FilterButton>
            {ALL_LEVELS.map((level) => (
              <FilterButton
                key={level}
                active={levelFilter === level}
                onClick={() => setLevelFilter(levelFilter === level ? null : level)}
              >
                {level}
              </FilterButton>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--app-text-subtle)]">Component:</span>
          <div className="flex flex-wrap gap-1">
            <FilterButton active={componentFilter === null} onClick={() => setComponentFilter(null)}>
              All
            </FilterButton>
            {ALL_COMPONENTS.map((comp) => (
              <FilterButton
                key={comp}
                active={componentFilter === comp}
                onClick={() => setComponentFilter(componentFilter === comp ? null : comp)}
              >
                {comp}
              </FilterButton>
            ))}
          </div>
        </div>
        </div>
      </Card>

      {/* Log output */}
      <Card padding={false} className="flex-1 min-h-0">
        {filteredLogs.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Terminal size={32} />}
              title="No log entries"
              description="Log events will appear here in real-time via WebSocket."
              compact
              className="min-h-[10rem]"
            />
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="h-full max-h-[calc(100vh-280px)] overflow-y-auto p-3 font-mono text-xs leading-5"
          >
            {filteredLogs.map((log, i) => {
              const time = new Date(log.timestamp).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                fractionalSecondDigits: 3,
              });
              const levelColor = LEVEL_COLORS[log.level] ?? "text-[var(--app-text-muted)]";
              const compColor = COMPONENT_COLORS[log.component] ?? "text-[var(--app-text-muted)]";

              return (
                <div key={i} className="flex gap-2 hover:bg-[var(--app-panel-elevated)]/30 px-1 rounded">
                  <span className="text-[var(--app-text-subtle)] shrink-0">{time}</span>
                  <span className={`w-12 shrink-0 uppercase ${levelColor}`}>{log.level.padEnd(5)}</span>
                  <span className={`w-20 shrink-0 ${compColor}`}>[{log.component}]</span>
                  <span className="text-[var(--app-text)] break-all">{log.msg}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Status bar */}
      <div className="flex items-center justify-between text-xs text-[var(--app-text-subtle)]">
        <span>{filteredLogs.length} entries {filteredLogs.length !== logs.length && `(${logs.length} total)`}</span>
        <span>{autoScroll ? "Following live feed" : "Scroll paused"}</span>
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs transition-colors ${
        active ? "bg-[var(--app-panel-muted)] text-[var(--app-text)]" : "text-[var(--app-text-subtle)] hover:text-[var(--app-text)]"
      }`}
    >
      {children}
    </button>
  );
}
