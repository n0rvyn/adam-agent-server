import { Box, Text, useInput } from "ink";
import React from "react";
import { request } from "../../client.js";
import type { ApprovalRequest } from "../hooks/useTuiState.js";

interface ApprovalBannerProps {
  approval: ApprovalRequest;
  onResolved: () => void;
}

export function ApprovalBanner({ approval, onResolved }: ApprovalBannerProps) {
  useInput((input) => {
    if (input === "a") {
      request(`/tasks/${approval.taskId}/approve`, {
        method: "POST",
        body: { approvalId: approval.approvalId },
      }).then(() => onResolved()).catch(() => onResolved());
    } else if (input === "r") {
      request(`/tasks/${approval.taskId}/reject`, {
        method: "POST",
        body: { approvalId: approval.approvalId, reason: "rejected by user" },
      }).then(() => onResolved()).catch(() => onResolved());
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text bold color="yellow">
        ⚠ APPROVAL REQUIRED
      </Text>
      <Box marginTop={1}>
        <Text>Tool: </Text>
        <Text bold>{approval.toolName}</Text>
      </Box>
      <Box>
        <Text>Input: </Text>
        <Text>{JSON.stringify(approval.toolInput)}</Text>
      </Box>
      <Box>
        <Text>Pattern: </Text>
        <Text dimColor>{approval.matchedPattern}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="green">[a] Approve</Text>
        <Text>  </Text>
        <Text color="red">[r] Reject</Text>
      </Box>
    </Box>
  );
}
