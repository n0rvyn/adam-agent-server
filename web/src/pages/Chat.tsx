import { useEffect, useRef, useState } from "react";
import { Clock3, Menu, MessageCircle, Plus, Sparkles, TerminalSquare, X } from "lucide-react";
import { useChatStore } from "@/store/useChatStore.ts";
import { ChatMessage } from "@/components/chat/ChatMessage.tsx";
import { ChatInput } from "@/components/chat/ChatInput.tsx";
import { SessionList } from "@/components/chat/SessionList.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { ICON_SIZE } from "@/lib/ui.ts";
import { Button } from "@/components/ui/Button.tsx";
import { useIsMobileLayout } from "@/lib/useIsMobileLayout.ts";
import { ThreadContainer } from "@/components/chat/ThreadContainer.tsx";
import { StatusReportGroup } from "@/components/chat/StatusReport.tsx";
import { groupByThread, groupConsecutiveStatusReports } from "@/lib/chatRendering.ts";

const starterActions = [
  { label: "Debug a failure", value: "Review the most recent failed task and explain the next fix." },
  { label: "Summarize status", value: "Summarize the current system status, blockers, and active work." },
  { label: "Plan a task", value: "Break down the next implementation task into a concrete execution plan." },
];

export function Chat() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const fetchSessions = useChatStore((s) => s.fetchSessions);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const createSession = useChatStore((s) => s.createSession);
  const archiveSession = useChatStore((s) => s.archiveSession);
  const restoreSession = useChatStore((s) => s.restoreSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const setActiveSession = useChatStore((s) => s.setActiveSession);

  const connectChatStream = useChatStore((s) => s.connectChatStream);
  const disconnectChatStream = useChatStore((s) => s.disconnectChatStream);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const isMobile = useIsMobileLayout(1024);
  const activeSessions = sessions.filter((session) => session.status === "active");
  const archivedSessions = sessions.filter((session) => session.status === "archived");
  const hasAnySessions = sessions.length > 0;
  const hasActiveMessages = messages.length > 0;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  // Connect to /chat/stream WebSocket for real-time messages
  useEffect(() => {
    connectChatStream();
    return () => disconnectChatStream();
  }, [connectChatStream, disconnectChatStream]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isMobile) {
      setMobileSessionsOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (activeSessionId || sessions.length === 0) {
      return;
    }
    const preferredSession = [...sessions]
      .filter((session) => session.status === "active")
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
      ?? [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (preferredSession) {
      setActiveSession(preferredSession.id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  const handleSend = async (content: string) => {
    await sendMessage(content);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <PageHeader
        title="Chat"
        description={
          hasAnySessions
            ? "Resume the latest session, inspect context, and keep the composer in view."
            : "Start the first session and use Adam as the working surface for review, debugging, and planning."
        }
        compact
        className="px-4 py-3 lg:px-4 lg:py-3"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void createSession()}>
              <Plus size={14} />
              New Session
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="lg:hidden"
              onClick={() => setMobileSessionsOpen(true)}
              aria-label="Manage sessions"
            >
              <Menu size={16} />
              Sessions
            </Button>
          </div>
        }
      />

      {mobileSessionsOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Session manager">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileSessionsOpen(false)} />
          <div className="relative z-50 h-full w-full max-w-sm border-r border-[var(--app-border)] bg-[var(--app-canvas)] shadow-[var(--app-shadow-lg)]">
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3">
              <div>
                <p className="text-section-label">Sessions</p>
                <p className="mt-1 text-xs text-[var(--app-text-subtle)]">Switch, archive, restore, or start a new conversation.</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileSessionsOpen(false)}
                aria-label="Close session manager"
              >
                <X size={16} />
              </Button>
            </div>
            <SessionList
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={setActiveSession}
              onNewSession={() => {
                void createSession();
                setMobileSessionsOpen(false);
              }}
              onArchiveSession={(id) => void archiveSession(id)}
              onRestoreSession={(id) => void restoreSession(id)}
              onDeleteSession={(id) => void deleteSession(id)}
              onClose={() => setMobileSessionsOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[color-mix(in_oklch,var(--app-canvas)_88%,transparent)] shadow-[var(--app-shadow-lg)]">
        {/* Session sidebar */}
        <div className="hidden w-72 flex-shrink-0 border-r border-[var(--app-border)] bg-[color-mix(in_oklch,var(--app-canvas)_90%,transparent)] lg:block">
          <SessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={setActiveSession}
            onNewSession={() => void createSession()}
            onArchiveSession={(id) => void archiveSession(id)}
            onRestoreSession={(id) => void restoreSession(id)}
            onDeleteSession={(id) => void deleteSession(id)}
          />
        </div>

        {/* Main chat area */}
        <div className="flex flex-1 flex-col">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6">
            {hasActiveMessages ? (
              <div className="mx-auto max-w-4xl space-y-3">
                {groupByThread(messages).map((bucket) => {
                  if (bucket.threadRoot === null) {
                    // Free conversation: render flat
                    return bucket.messages.map((m) => <ChatMessage key={m.id} message={m} />);
                  }
                  // Thread: wrap in ThreadContainer with consecutive status_report grouping
                  const segments = groupConsecutiveStatusReports(bucket.messages);
                  return (
                    <ThreadContainer
                      key={bucket.threadRoot}
                      sessionId={activeSessionId ?? ""}
                      threadRoot={bucket.threadRoot}
                      messages={bucket.messages}
                    >
                      {segments.map((seg, idx) => {
                        if (seg.type === "single") {
                          return <ChatMessage key={seg.message.id} message={seg.message} />;
                        }
                        return (
                          <StatusReportGroup
                            key={`status-group-${idx}-${seg.messages[0]?.id ?? ""}`}
                            messages={seg.messages}
                          />
                        );
                      })}
                    </ThreadContainer>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            ) : !hasAnySessions ? (
              <EmptyState
                icon={<MessageCircle size={ICON_SIZE.hero} />}
                title="Start a conversation with Adam"
                description="Use the starter prompts below to inspect recent work, diagnose failures, or create an execution plan."
                className="h-full min-h-[24rem]"
                action={
                  <div className="grid gap-3 text-left sm:grid-cols-3">
                    <StarterCard icon={Sparkles} title="Inspect live status" description="Summarize active work, risk, and recent changes." />
                    <StarterCard icon={TerminalSquare} title="Dig into a task" description="Review recent execution output and the next concrete step." />
                    <StarterCard icon={Clock3} title="Recover context" description="Continue from the latest session without losing history." />
                  </div>
                }
              />
            ) : (
              <div className="mx-auto flex h-full w-full max-w-4xl items-start">
                <div className="surface-panel-muted flex w-full flex-col gap-4 rounded-xl p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-kicker">Working Surface</p>
                      <h2 className="text-xl font-semibold text-[var(--app-text)]">
                        {activeSession ? `Session ${activeSession.title ?? activeSession.id.slice(0, 8)}` : "Pick a session to continue"}
                      </h2>
                      <p className="max-w-2xl text-sm leading-6 text-[var(--app-text-muted)]">
                        {activeSession
                          ? "This session has no loaded transcript yet. Continue here or start a new thread without leaving the page."
                          : "Archived history exists, but no session is active. Select one from the rail or start a new conversation."}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--app-text-subtle)]">
                      <span>{activeSessions.length} active</span>
                      <span>{archivedSessions.length} archived</span>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    {starterActions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        onClick={() => void handleSend(action.value)}
                        className="rounded-xl border border-[var(--app-border)] bg-white/[0.03] p-4 text-left transition-colors hover:border-[var(--app-border-strong)] hover:bg-white/[0.05]"
                      >
                        <div className="text-sm font-semibold text-[var(--app-text)]">{action.label}</div>
                        <div className="mt-1 text-sm leading-6 text-[var(--app-text-muted)]">{action.value}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div className="mx-auto w-full max-w-4xl px-4 pb-4 lg:px-6">
            <ChatInput
              onSend={handleSend}
              disabled={sending}
              starterActions={starterActions}
              showStarterActions={!hasAnySessions && !hasActiveMessages}
              compact={hasAnySessions}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StarterCard({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof MessageCircle;
  title: string;
  description: string;
}) {
  return (
    <div className="surface-panel-muted rounded-lg p-4">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.05] text-[var(--app-kicker)]">
        <Icon size={ICON_SIZE.lg} />
      </div>
      <div className="text-sm font-semibold text-[var(--app-text)]">{title}</div>
      <div className="mt-1 text-sm leading-6 text-[var(--app-text-muted)]">{description}</div>
    </div>
  );
}
