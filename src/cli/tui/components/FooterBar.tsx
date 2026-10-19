import { Box, Text } from "ink";
import React from "react";
import { useTuiState } from "../hooks/useTuiState.js";

interface HintEntry {
  key: string;
  label: string;
}

const ESC_BACK: HintEntry = { key: "Esc", label: "back" };

const HINTS: Record<string, HintEntry[]> = {
  work: [
    { key: "1", label: "tasks" },
    { key: "2", label: "automations" },
    { key: "3", label: "goals" },
    ESC_BACK,
  ],
  tasks: [
    { key: "↑↓", label: "move" },
    { key: "Enter", label: "detail" },
    { key: "x", label: "cancel" },
    { key: "f", label: "filter" },
    { key: "r", label: "refresh" },
    ESC_BACK,
  ],
  config: [ESC_BACK],
  evolution: [ESC_BACK],
  goals: [
    { key: "c", label: "create" },
    { key: "r", label: "refresh" },
    ESC_BACK,
  ],
  strategies: [ESC_BACK],
  templates: [
    { key: "↑↓", label: "move" },
    { key: "t", label: "run" },
    { key: "s", label: "toggle" },
    { key: "e", label: "edit" },
    { key: "c", label: "create" },
    { key: "d", label: "delete" },
    { key: "r", label: "refresh" },
    ESC_BACK,
  ],
  webhooks: [ESC_BACK],
  memories: [ESC_BACK],
  plugins: [
    { key: "↑↓", label: "move" },
    { key: "r", label: "refresh" },
    ESC_BACK,
  ],
  roles: [ESC_BACK],
  settings: [ESC_BACK],
  channels: [ESC_BACK],
};

export function FooterBar() {
  const { state } = useTuiState();
  const hints = HINTS[state.view] ?? [ESC_BACK];

  return (
    <Box borderStyle="round" borderDimColor paddingX={1}>
      {hints.map((hint, index) => (
        <React.Fragment key={`${hint.key}-${hint.label}`}>
          {index > 0 && <Text dimColor>{"  "}</Text>}
          <Text color="cyan">{hint.key}</Text>
          <Text dimColor>{` ${hint.label}`}</Text>
        </React.Fragment>
      ))}
    </Box>
  );
}
