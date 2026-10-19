import { Box, Text } from "ink";
import React from "react";
import { useTuiState } from "../hooks/useTuiState.js";

const NARROW_BREAKPOINT = 90;

function StatusRow({ children }: { children: React.ReactNode }) {
  return (
    <Box>
      {children}
    </Box>
  );
}

export function StatusBar() {
  const { state } = useTuiState();

  // Session indicator (chat view only)
  const session = state.session;
  const minutesSinceActive = session
    ? Math.floor((Date.now() - session.lastActiveAt) / 60000)
    : Infinity;
  const isNearTimeout = minutesSinceActive >= 25;
  const serverLabel = state.connected ? "up" : "down";
  const viewLabel = state.view === "chat"
    ? "Chat"
    : state.view.charAt(0).toUpperCase() + state.view.slice(1);
  const sessionLabel = session
    ? session.messageCount === 0
      ? "new session"
      : `${session.id.slice(0, 8)} · ${session.messageCount}t`
    : null;

  const columns = process.stdout.columns ?? 100;
  const isNarrow = columns < NARROW_BREAKPOINT;

  const brandBlock = (
    <>
      <Text bold>{state.version ? `Adam v${state.version}` : "Adam"}</Text>
      <Text dimColor> | </Text>
      <Text color={state.connected ? "green" : "red"}>{state.connected ? "●" : "●"}</Text>
      <Text>{` ${serverLabel}`}</Text>
      <Text dimColor> | </Text>
      <Text>{viewLabel.toLowerCase()}</Text>
    </>
  );

  const metricsBlock = (
    <>
      <Text>{`${state.activeTasks} run / ${state.queuedTasks} q`}</Text>
      <Text dimColor> | </Text>
      <Text>{`$${state.costToday.toFixed(2)}`}</Text>
      {state.view === "chat" && session && (
        <>
          <Text dimColor> | </Text>
          <Text>{sessionLabel}</Text>
          {isNearTimeout && (
            <>
              <Text dimColor> | </Text>
              <Text color="yellow">timeout</Text>
            </>
          )}
        </>
      )}
    </>
  );

  if (isNarrow) {
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <StatusRow>{brandBlock}</StatusRow>
        <StatusRow>{metricsBlock}</StatusRow>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderDimColor paddingX={1}>
      {brandBlock}
      <Text dimColor> | </Text>
      {metricsBlock}
    </Box>
  );
}
