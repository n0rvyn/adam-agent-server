import { useState } from "react";
import { Circle } from "lucide-react";
import { Badge } from "@/components/ui/Badge.tsx";
import type { StepLog } from "@/lib/types.ts";
import { timeAgo } from "@/lib/format.ts";

const DOT_COLORS: Record<string, string> = {
  reasoning: "text-[var(--app-accent)]",
  tool_call: "text-[var(--app-accent-strong)]",
  tool_result: "text-[var(--app-success)]",
  approval_request: "text-[var(--app-warning)]",
  approval_response: "text-[var(--app-warning-strong)]",
  permission_denied: "text-[var(--app-indicator-alert)]",
  error: "text-[var(--app-danger)]",
  plugin_error: "text-[var(--app-danger)]",
};

export function ExecutionTimeline({ logs }: { logs: StepLog[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const statusMarkerSize = 10;

  if (logs.length === 0) {
    return <p className="text-sm text-[var(--app-text-subtle)]">No execution steps yet.</p>;
  }

  return (
    <div className="space-y-0">
      {logs.map((log, i) => {
        const prevTs = i > 0 ? logs[i - 1].timestamp : null;
        const duration = prevTs ? log.timestamp - prevTs : null;
        const isPluginError = log.type === "plugin_error";
        const isExpanded = expanded.has(i);
        const displayContent = isExpanded
          ? log.content
          : log.content.length > 200
            ? log.content.slice(0, 200) + "..."
            : log.content;

        return (
          <div key={log.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <Circle
                size={statusMarkerSize}
                className={`mt-1.5 flex-shrink-0 fill-current ${DOT_COLORS[log.type] ?? "text-[var(--app-text-subtle)]"} ${isPluginError ? "rounded-full ring-2 ring-[var(--app-danger)]" : ""}`}
              />
              {i < logs.length - 1 && <div className="mt-0.5 w-0.5 flex-1 bg-[var(--app-border)]" />}
            </div>

            <div className={`flex-1 pb-4 ${isPluginError ? "rounded-lg border border-[var(--app-danger)]/40 bg-[var(--app-danger-soft-bg-subtle)] p-3" : ""}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-[var(--app-text-subtle)]">#{log.index}</span>
                <span className="text-sm font-medium text-[var(--app-text)]">
                  {log.toolName ?? log.type}
                </span>
                {isPluginError && <Badge variant="destructive">Plugin Error</Badge>}
                <span className="text-xs text-[var(--app-text-subtle)]">
                  {timeAgo(log.timestamp)}
                </span>
                {duration != null && duration > 0 && (
                  <span className="text-xs text-[var(--app-text-subtle)]">+{duration}ms</span>
                )}
                {log.truncated && <Badge variant="outline">truncated</Badge>}
              </div>
              {displayContent && (
                <button
                  className="mt-2 w-full rounded-lg border border-[var(--app-border)] bg-white/[0.03] px-3 py-3 text-left font-mono text-xs text-[var(--app-text-muted)] transition-colors hover:border-[var(--app-border-strong)] hover:text-[var(--app-text)]"
                  onClick={() => {
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  }}
                >
                  {displayContent}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
