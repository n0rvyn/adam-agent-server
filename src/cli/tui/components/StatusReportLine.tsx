import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React from "react";

export type StatusReportPhase = "running" | "completed" | "failed" | "retrying" | "blocked";

interface StatusReportLineProps {
  content: string;
  phase: StatusReportPhase;
  taskShortId?: string;
}

const ICON: Record<StatusReportPhase, { glyph: string; color: string }> = {
  running:   { glyph: "",  color: "blue" },    // spinner instead of static glyph
  completed:  { glyph: "✓", color: "green" },
  failed:     { glyph: "✗", color: "red" },
  retrying:   { glyph: "↻", color: "yellow" },
  blocked:    { glyph: "⏸", color: "yellow" },
};

export function StatusReportLine({ content, phase, taskShortId }: StatusReportLineProps) {
  const ic = ICON[phase];
  return (
    <Box>
      <Text color={ic.color}>
        {phase === "running" ? <Spinner type="dots" /> : ic.glyph}
      </Text>
      <Text> </Text>
      {taskShortId && <Text dimColor>[{taskShortId}] </Text>}
      <Text dimColor>{content}</Text>
    </Box>
  );
}
