import { Box, Text, useInput } from "ink";
import React, { useState } from "react";

export interface StreamEvent {
  type: "reasoning" | "tool_call" | "tool_result" | "error" | "complete";
  content: string;
  timestamp?: number;
  metadata?: {
    toolName?: string;
    duration?: number;
    cost?: number;
    turns?: number;
  };
}

interface StreamViewProps {
  events: StreamEvent[];
  isStreaming: boolean;
}

function FoldableContent({ content, expanded }: { content: string; expanded: boolean }) {
  const lines = content.split("\n");

  if (lines.length <= 5) {
    return <Text color="green">{content}</Text>;
  }

  if (expanded) {
    return <Text color="green">{content}</Text>;
  }

  return (
    <Text color="green">
      {lines.slice(0, 3).join("\n")}
      {"\n"}
      <Text dimColor>({lines.length} lines) [Ctrl+O] expand</Text>
    </Text>
  );
}

function StreamEventItem({ event, expanded }: { event: StreamEvent; expanded: boolean }) {
  switch (event.type) {
    case "reasoning":
      return (
        <Box>
          <Text color="gray">{event.content}</Text>
        </Box>
      );
    case "tool_call":
      return (
        <Box>
          <Text color="blue">[tool] {event.metadata?.toolName ?? event.content}</Text>
        </Box>
      );
    case "tool_result":
      return (
        <Box flexDirection="column">
          <Text color="blue" dimColor>[result]</Text>
          <FoldableContent content={event.content} expanded={expanded} />
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text color="red">[error] {event.content}</Text>
        </Box>
      );
    case "complete":
      return (
        <Box flexDirection="column" marginTop={1}>
          {event.content && (
            <Text>{event.content}</Text>
          )}
          <Text dimColor>─── Task complete ───</Text>
          {event.metadata?.cost !== undefined && (
            <Text dimColor>Cost: ${event.metadata.cost.toFixed(4)}</Text>
          )}
          {event.metadata?.turns !== undefined && (
            <Text dimColor>Turns: {event.metadata.turns}</Text>
          )}
          {event.metadata?.duration !== undefined && (
            <Text dimColor>Duration: {(event.metadata.duration / 1000).toFixed(1)}s</Text>
          )}
        </Box>
      );
    default:
      return null;
  }
}

export function StreamView({ events, isStreaming }: StreamViewProps) {
  const [expanded, setExpanded] = useState(false);
  const hasFoldableContent = events.some(
    (event) => event.type === "tool_result" && event.content.split("\n").length > 5,
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") {
        setExpanded((current) => !current);
      }
    },
    { isActive: hasFoldableContent },
  );

  if (events.length === 0 && !isStreaming) return null;

  return (
    <Box flexDirection="column">
      {isStreaming && events.length === 0 && (
        <Text dimColor>Waiting for response...</Text>
      )}
      {events.map((event, i) => (
        <StreamEventItem key={i} event={event} expanded={expanded} />
      ))}
      {hasFoldableContent && (
        <Text dimColor>{expanded ? "[Ctrl+O] collapse full output" : "[Ctrl+O] expand full output"}</Text>
      )}
    </Box>
  );
}
