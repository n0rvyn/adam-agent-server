import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import React, { useState } from "react";
import { request } from "../../client.js";
import type { ApprovalShape } from "../../../shared/types.js";

interface ApprovalSelectProps {
  promptId: string;
  content: string;
  shape: ApprovalShape;
  /** Optional choice labels for `choose_one` shape; defaults inferred. */
  choices?: string[];
  /** Called after a successful POST so MessageHistory can update local state. */
  onSubmitted?: (value: string) => void;
  /**
   * Called when the POST fails. App.tsx adds the promptId to `failedPromptIdsRef`
   * so InputBar is restored — user can recover by typing `#PROMPTID value` token.
   */
  onSubmitFailure?: () => void;
}

const YES_NO_ITEMS = [
  { label: "批准 / Yes", value: "批准" },
  { label: "拒绝 / No", value: "拒绝" },
];

export function ApprovalSelect({
  promptId,
  content,
  shape,
  choices,
  onSubmitted,
  onSubmitFailure,
}: ApprovalSelectProps) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = (() => {
    if (shape === "yes_no") return YES_NO_ITEMS;
    if (shape === "choose_one" && choices && choices.length > 0) {
      return choices.map((c) => ({ label: c, value: c }));
    }
    // free_input: not yet supported in this phase — fallback hint
    return [];
  })();

  const handleSelect = async (item: { value: string }) => {
    try {
      await request("/chat/messages", {
        method: "POST",
        body: {
          content: item.value,
          source: { type: "tui" },
          buttonPayload: { promptId, value: item.value },
        },
      });
      setSubmitted(item.value);
      onSubmitted?.(item.value);
    } catch {
      setError(`Failed to submit. Try again or type "#${promptId} ${item.value}" in the input bar.`);
      onSubmitFailure?.();
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">⚠ #{promptId}</Text>
      <Box marginTop={1}><Text>{content}</Text></Box>
      {submitted ? (
        <Box marginTop={1}>
          <Text color="green">[已提交: {submitted} ✓]</Text>
        </Box>
      ) : shape === "free_input" ? (
        <Box marginTop={1}>
          <Text dimColor>Free-input shape: 请回复 #{promptId} 你的答复</Text>
        </Box>
      ) : items.length > 0 ? (
        <Box marginTop={1}>
          <SelectInput items={items} onSelect={handleSelect} />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="red" dimColor>(no choices configured for shape={shape})</Text>
        </Box>
      )}
      {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}
    </Box>
  );
}
