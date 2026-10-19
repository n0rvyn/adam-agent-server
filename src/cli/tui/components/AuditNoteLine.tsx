import { Box, Text } from "ink";
import React from "react";
import { AUDIT_SIDECAR_LABEL } from "../../../shared/constants.js";

interface AuditNoteLineProps {
  content: string;
}

/**
 * Self-check guardrail note (Option A) for the TUI. Rendered distinctly from a neutral
 * system note (yellow ⚠️ + label) so the user can tell the audit sidecar is speaking,
 * while ChatManager's real reply stays intact above.
 */
export function AuditNoteLine({ content }: AuditNoteLineProps) {
  return (
    <Box flexDirection="column">
      <Text color="yellow">⚠️ {AUDIT_SIDECAR_LABEL}</Text>
      <Text dimColor>{content}</Text>
    </Box>
  );
}
