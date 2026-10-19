import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { clsx } from "clsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";
import { timeAgo } from "@/lib/format.ts";

interface StatusReportLineProps {
  message: ChatMessageInfo;
}

/** Single status_report — dimmed single-line (default). */
export function StatusReportLine({ message }: StatusReportLineProps) {
  return (
    <div
      className="chat-status-report flex items-center gap-2 px-3 py-1 text-xs text-[var(--app-text-subtle)] opacity-60"
      data-testid="status-report-line"
    >
      <span className="select-none">›</span>
      <span className="flex-1 truncate">{message.content}</span>
      <span className="text-[var(--app-text-subtle)]">
        {timeAgo(
          typeof message.createdAt === "number"
            ? message.createdAt
            : new Date(message.createdAt).getTime(),
        )}
      </span>
    </div>
  );
}

interface StatusReportGroupProps {
  messages: ChatMessageInfo[];
}

/** Collapsed group of >= 3 consecutive status_reports (D-004). */
export function StatusReportGroup({ messages }: StatusReportGroupProps) {
  const [open, setOpen] = useState(false);
  const count = messages.length;
  return (
    <div className="chat-status-report-group" data-testid="status-report-group">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={clsx(
          "flex w-full items-center gap-2 rounded border border-[var(--app-border)] bg-white/[0.02] px-3 py-1.5 text-xs text-[var(--app-text-muted)] transition-colors hover:border-[var(--app-border-strong)]",
        )}
        aria-expanded={open}
      >
        <ChevronRight
          size={12}
          className={clsx("transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
        <span>{count} 步进展</span>
      </button>
      {open ? (
        <div className="mt-1 space-y-0.5 border-l border-[var(--app-border)] pl-3">
          {messages.map((m) => (
            <StatusReportLine key={m.id} message={m} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
