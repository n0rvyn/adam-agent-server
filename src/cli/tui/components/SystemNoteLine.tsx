import { Box, Text } from "ink";
import React from "react";

interface SystemNoteLineProps {
  content: string;
}

export function SystemNoteLine({ content }: SystemNoteLineProps) {
  return (
    <Box>
      <Text dimColor>· {content}</Text>
    </Box>
  );
}
