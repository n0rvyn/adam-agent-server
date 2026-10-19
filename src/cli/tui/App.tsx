import { Box, Text, useInput } from "ink";
import React, { useState, useEffect, useRef, useReducer } from "react";
import { TuiProvider, useTuiState, type TuiState } from "./hooks/useTuiState.js";
import { useGlobalEvents } from "./hooks/useGlobalEvents.js";
import { useTaskStream } from "./hooks/useTaskStream.js";
import { useChatSession } from "./hooks/useChatSession.js";
import { useChatStream } from "./hooks/useChatStream.js";
import { StatusBar } from "./components/StatusBar.js";
import { InputBar } from "./components/InputBar.js";
import { StreamView } from "./components/StreamView.js";
import { MessageHistory, type Message } from "./components/MessageHistory.js";
import { ApprovalBanner } from "./components/ApprovalBanner.js";
import { PlanApprovalBanner } from "./components/PlanApprovalBanner.js";
import { TaskList } from "./components/TaskList.js";
import { ConfigView } from "./components/ConfigView.js";
import { EvolutionView } from "./components/EvolutionView.js";
// AgentList removed in Phase 2 — replaced by PluginList
import { GoalDashboard } from "./components/GoalDashboard.js";
import { StrategyLab } from "./components/StrategyLab.js";
import { TemplateList } from "./components/TemplateList.js";
import { WebhookList } from "./components/WebhookList.js";
import { MemoryList } from "./components/MemoryList.js";
import { SettingsView } from "./components/SettingsView.js";
import { PluginList } from "./components/PluginList.js";
import { WorkView } from "./components/WorkView.js";
import { ChannelList } from "./components/ChannelList.js";
import { RolesList } from "./components/RolesList.js";
import { FooterBar } from "./components/FooterBar.js";
import { FeatureRequests } from "./components/FeatureRequests.js";
import { Mistakes } from "./components/Mistakes.js";
import { ArtifactsList } from "./components/ArtifactsList.js";

function AppContent() {
  const { state, dispatch } = useTuiState();
  const { session, sendMessage, createNewSession, archiveCurrentSession } = useChatSession();
  const [messages, setMessages] = useState<Message[]>([]);

  // Sync session to TuiState for StatusBar access
  useEffect(() => {
    dispatch({ type: "SET_SESSION", session });
  }, [session, dispatch]);

  // Global events (stats, worker status, task auto-attach)
  useGlobalEvents();

  // Chat stream: receive assistant messages via /chat/stream WebSocket
  const { latestMessage: chatStreamMessage } = useChatStream(session?.id ?? null);

  // Append chat stream messages to history (deduplicated)
  const lastChatStreamIdRef = useRef<string | null>(null);
  // DP-001: symmetric cross-path dedup refs
  const seenChatStreamTaskIdsRef = useRef<Set<string>>(new Set());
  const seenTaskStreamCompleteTaskIdsRef = useRef<Set<string>>(new Set());
  // Inline approval submitted/failed tracking refs
  const submittedPromptIdsRef = useRef<Set<string>>(new Set());
  const failedPromptIdsRef = useRef<Set<string>>(new Set());
  const [, forceRerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!chatStreamMessage) return;
    if (chatStreamMessage.id === lastChatStreamIdRef.current) return;
    lastChatStreamIdRef.current = chatStreamMessage.id;
    // DP-001: only terminal kinds participate in cross-path dedup;
    // status_report/system_note/approval_prompt share taskId but are not terminal
    const isTerminalKind =
      !chatStreamMessage.kind ||
      chatStreamMessage.kind === "result_delivery" ||
      chatStreamMessage.kind === "assistant_text";
    // DP-001: symmetric dedup — if task-stream complete path already pushed this taskId, noop
    if (isTerminalKind && chatStreamMessage.taskId && seenTaskStreamCompleteTaskIdsRef.current.has(chatStreamMessage.taskId)) {
      seenChatStreamTaskIdsRef.current.add(chatStreamMessage.taskId);
      return;
    }
    if (isTerminalKind && chatStreamMessage.taskId) {
      seenChatStreamTaskIdsRef.current.add(chatStreamMessage.taskId);
    }
    setMessages((prev) => [
      ...prev,
      {
        id: chatStreamMessage.id,
        role: "assistant",
        content: chatStreamMessage.content,
        taskId: chatStreamMessage.taskId,
        createdAt: chatStreamMessage.createdAt,
        kind: chatStreamMessage.kind,
        threadRoot: chatStreamMessage.threadRoot,
        parentMessageId: chatStreamMessage.parentMessageId,
        promptId: chatStreamMessage.promptId,
        approvalShape: chatStreamMessage.approvalShape,
        roleId: chatStreamMessage.roleId,
        attachments: chatStreamMessage.attachments,
        mirroredToTargets: chatStreamMessage.mirroredToTargets,
        platformMessageId: chatStreamMessage.platformMessageId,
        seq: chatStreamMessage.seq,
      },
    ]);
  }, [chatStreamMessage]);

  // Task stream
  const { events, isStreaming, clearEvents } = useTaskStream(state.activeTaskId);

  // When streaming completes, move result to message history
  const lastEvent = events[events.length - 1];
  const taskCompleted = lastEvent?.type === "complete" && !isStreaming;
  const processedTaskRef = useRef<string | null>(null);

  // Track accumulated reasoning text via ref (avoids dependency array re-render issues)
  const reasoningTextRef = useRef("");
  useEffect(() => {
    reasoningTextRef.current = events
      .filter((e) => e.type === "reasoning")
      .map((e) => e.content)
      .join("");
  }, [events]);

  useEffect(() => {
    if (taskCompleted && state.activeTaskId !== processedTaskRef.current) {
      processedTaskRef.current = state.activeTaskId;
      // DP-001: symmetric dedup — if chat_message path already pushed this taskId, noop
      if (state.activeTaskId && seenChatStreamTaskIdsRef.current.has(state.activeTaskId)) {
        return;
      }
      // Primary: result from complete event. Fallback: accumulated reasoning text.
      const resultText = lastEvent?.content || reasoningTextRef.current;
      if (resultText) {
        if (state.activeTaskId) {
          seenTaskStreamCompleteTaskIdsRef.current.add(state.activeTaskId);
        }
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: resultText,
            taskId: state.activeTaskId ?? undefined,
            kind: "assistant_text", // fallback: not treated as result_delivery; avoids thread pollution
          },
        ]);
      }
    }
  }, [taskCompleted, lastEvent, state.activeTaskId]);

  const handleSubmit = async (value: string) => {
    // Exit commands — match before any other processing
    const trimmed = value.trim().toLowerCase();
    if (["quit", "exit", "/quit", "/exit"].includes(trimmed)) { process.exit(0); }

    if (value.startsWith("/")) {
      const command = value.slice(1);
      const viewCommands: Record<string, TuiState["view"]> = {
        work: "work", tasks: "tasks", config: "config",
        evolution: "evolution", templates: "templates",
        memories: "memories", goals: "goals",
        strategies: "strategies", roles: "roles",
        settings: "settings", channels: "channels",
        plugins: "plugins", "feature-requests": "featureRequests",
        mistakes: "mistakes",
        artifacts: "artifacts",
        back: "chat",
      };
      const view = viewCommands[command];
      if (view) { dispatch({ type: "SET_VIEW", view }); return; }

      // Session commands
      if (command === "new") {
        const archived = await archiveCurrentSession();
        if (archived) {
          const newSession = await createNewSession();
          setMessages([]);
          clearEvents();
          // DP-001: clear dedup refs on session switch
          seenChatStreamTaskIdsRef.current.clear();
          seenTaskStreamCompleteTaskIdsRef.current.clear();
          submittedPromptIdsRef.current.clear();
          failedPromptIdsRef.current.clear();
          if (newSession) {
            setMessages([{ role: "assistant", content: `Session archived. New session started: ${newSession.id.slice(0, 8)}` }]);
          }
        }
        return;
      }
      if (command === "session") {
        const info = session
          ? `Session: ${session.id}\nTurns: ${session.messageCount}\nLast active: ${new Date(session.lastActiveAt).toLocaleString()}`
          : "No active session";
        setMessages((prev) => [...prev, { role: "assistant", content: info }]);
        return;
      }
    }

    // Add user message to history
    setMessages((prev) => [...prev, { role: "user", content: value }]);

    // Clear previous stream
    clearEvents();

    // Submit via chat API (wraps session + context + task creation)
    // Response arrives via useChatStream (Layer 1) and task stream auto-attach (Layer 2)
    const result = await sendMessage(value);
    if (!result) {
      setMessages((prev) => [...prev, { role: "assistant", content: "Failed to send message. Server may be disconnected." }]);
      return;
    }
  };

  const hasUnresolvedInlineApproval = messages.some(
    (m) =>
      m.kind === "approval_prompt" &&
      m.promptId &&
      !submittedPromptIdsRef.current.has(m.promptId) &&
      !failedPromptIdsRef.current.has(m.promptId),
  );
  const showComposer =
    state.view === "chat" &&
    !state.pendingPlanApproval &&
    !state.pendingApproval &&
    !hasUnresolvedInlineApproval;

  return (
    <Box flexDirection="column" paddingX={1}>
      <StatusBar />
      <Box flexGrow={1} flexDirection="column" paddingY={1}>
        {state.view === "chat" && (
          <>
            <MessageHistory
              messages={messages}
              onApprovalSubmitted={(promptId) => {
                submittedPromptIdsRef.current.add(promptId);
                forceRerender();
              }}
              onApprovalFailed={(promptId) => {
                failedPromptIdsRef.current.add(promptId);
                forceRerender();
              }}
            />
            <StreamView events={events} isStreaming={isStreaming} />
            {!state.connected && !state.serverUnreachable && (
              <Box>
                <Text color="red">Server disconnected. Attempting to reconnect...</Text>
              </Box>
            )}
            {state.serverUnreachable && (
              <Box flexDirection="column">
                <Text color="red" bold>Server unreachable after 15s.</Text>
                <Text dimColor>Check: adam server logs</Text>
                <Text dimColor>Type /quit to exit.</Text>
              </Box>
            )}
          </>
        )}
        {state.view === "work" && (
          <WorkView onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "tasks" && (
          <TaskList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "config" && (
          <ConfigView onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "evolution" && (
          <EvolutionView onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {/* AgentList removed in Phase 2; "plugins" view serves plugin management */}
        {state.view === "goals" && (
          <GoalDashboard onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "strategies" && (
          <StrategyLab onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "templates" && (
          <TemplateList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "webhooks" && (
          <WebhookList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "memories" && (
          <MemoryList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "plugins" && (
          <PluginList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "roles" && (
          <RolesList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "featureRequests" && (
          <FeatureRequests onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "mistakes" && (
          <Mistakes onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "settings" && (
          <SettingsView onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "channels" && (
          <ChannelList onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })} />
        )}
        {state.view === "artifacts" && (
          <ArtifactsList
            onBack={() => dispatch({ type: "SET_VIEW", view: "chat" })}
            onSelect={() => {}}
            onAction={() => {}}
          />
        )}
      </Box>
      {state.pendingPlanApproval ? (
        <PlanApprovalBanner
          approval={state.pendingPlanApproval}
          onResolved={() => dispatch({ type: "SET_PENDING_PLAN_APPROVAL", approval: null })}
          onTimeout={() => dispatch({ type: "SET_PLAN_TIMEOUT_NOTICE", planId: state.pendingPlanApproval!.planId })}
        />
      ) : state.pendingApproval ? (
        <ApprovalBanner
          approval={state.pendingApproval}
          onResolved={() => dispatch({ type: "SET_PENDING_APPROVAL", approval: null })}
        />
      ) : showComposer ? (
        <InputBar onSubmit={handleSubmit} />
      ) : (
        <FooterBar />
      )}
      {state.planTimeoutNotice && (
        <TimeoutNotice
          planId={state.planTimeoutNotice.planId}
          onDismiss={() => dispatch({ type: "SET_PLAN_TIMEOUT_NOTICE", planId: null })}
        />
      )}
    </Box>
  );
}

function TimeoutNotice({ planId, onDismiss }: { planId: string; onDismiss: () => void }) {
  useInput((input: string) => {
    if (input === "d") onDismiss();
  });
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Plan {planId} was auto-denied after 300s timeout.</Text>
      <Text dimColor>  [d] Dismiss</Text>
    </Box>
  );
}

export default function App() {
  return (
    <TuiProvider>
      <AppContent />
    </TuiProvider>
  );
}
