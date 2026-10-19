import { useState, useEffect, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import type { ChatMessageInfo } from "@/store/useChatStore.ts";
import { roleColorToken, taskShortId } from "@/lib/chatRendering.ts";

const FOLD_KEY = (sessionId: string, threadRoot: string) =>
  `chat:thread-fold:${sessionId}:${threadRoot}`;

interface ThreadContainerProps {
  sessionId: string;
  threadRoot: string;
  messages: ChatMessageInfo[];
  children: ReactNode;
}

/** Determine if a thread is "active": has non-terminal status_report OR open approval_prompt without resolution. */
function isActiveThread(messages: ChatMessageInfo[]): boolean {
  const hasResultDelivery = messages.some((m) => m.kind === "result_delivery");
  const hasOpenApproval = messages.some((m) => m.kind === "approval_prompt");
  return !hasResultDelivery || hasOpenApproval;
}

export function ThreadContainer({
  sessionId,
  threadRoot,
  messages,
  children,
}: ThreadContainerProps) {
  const active = isActiveThread(messages);
  const storageKey = FOLD_KEY(sessionId, threadRoot);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return !active;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return !active; // D-005: closed thread defaults to collapsed
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, collapsed ? "1" : "0");
    } catch {
      // localStorage may be unavailable; ignore.
    }
  }, [collapsed, storageKey]);

  // Derive thread header from first message (originating user_message preferred)
  const originating = messages.find((m) => m.kind === "user_message") ?? messages[0];
  const taskId = messages.find((m) => m.taskId)?.taskId;
  const roleId = messages.find((m) => m.roleId)?.roleId;
  const color = roleColorToken(roleId);
  const shortId = taskShortId(taskId);
  const excerpt =
    (originating?.content ?? "").slice(0, 30) +
    ((originating?.content?.length ?? 0) > 30 ? "..." : "");

  return (
    <div
      className={clsx(
        "chat-thread-container relative rounded-xl border border-[var(--app-border)] bg-white/[0.015] pl-3",
      )}
      data-testid="thread-container"
      data-thread-root={threadRoot}
      data-collapsed={collapsed ? "1" : "0"}
    >
      {/* Color gutter — 4px left bar */}
      <div
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ background: color }}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs uppercase tracking-[0.16em] text-[var(--app-text-muted)] transition-colors hover:text-[var(--app-text)]"
        aria-expanded={!collapsed}
        data-testid="thread-toggle"
      >
        <ChevronDown
          size={12}
          className={clsx("transition-transform", collapsed && "-rotate-90")}
          aria-hidden="true"
        />
        <span style={{ color }}>{shortId || "Thread"}</span>
        <span className="text-[var(--app-text-subtle)] normal-case tracking-normal">
          {excerpt}
        </span>
      </button>
      {!collapsed ? <div className="space-y-2 px-3 pb-3">{children}</div> : null}
    </div>
  );
}
