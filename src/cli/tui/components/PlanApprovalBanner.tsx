import { Box, Text, useInput } from "ink";
import React, { useState, useEffect } from "react";
import { request } from "../../client.js";
import type { PlanApprovalRequest } from "../hooks/useTuiState.js";

const APPROVAL_TIMEOUT_SECONDS = 300;

interface PlanApprovalBannerProps {
  approval: PlanApprovalRequest;
  onResolved: () => void;
  onTimeout: () => void;
}

export function PlanApprovalBanner({ approval, onResolved, onTimeout }: PlanApprovalBannerProps) {
  const [secondsLeft, setSecondsLeft] = useState(APPROVAL_TIMEOUT_SECONDS);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          onTimeout();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onTimeout]);

  useInput((input) => {
    if (input === "a") {
      request(`/tasks/${approval.taskId}/approve-plan`, {
        method: "POST",
        body: { planId: approval.planId, decision: "allow", approvalType: "once" },
      }).then(() => onResolved()).catch(() => onResolved());
    } else if (input === "r") {
      request(`/tasks/${approval.taskId}/approve-plan`, {
        method: "POST",
        body: { planId: approval.planId, decision: "deny", reason: "rejected by user" },
      }).then(() => onResolved()).catch(() => onResolved());
    } else if (input === "p") {
      request(`/tasks/${approval.taskId}/approve-plan`, {
        method: "POST",
        body: { planId: approval.planId, decision: "allow", approvalType: "permanent" },
      }).then(() => onResolved()).catch(() => onResolved());
    }
  });

  const riskColor = approval.plan.overallRisk === "high" ? "red"
    : approval.plan.overallRisk === "medium" ? "yellow" : "green";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">EXECUTION PLAN — APPROVAL REQUIRED</Text>
      <Text dimColor>Plan ID: {approval.planId}</Text>
      <Text dimColor>Time remaining: {secondsLeft}s</Text>
      <Box marginTop={1}>
        <Text>Overall Risk: </Text>
        <Text bold color={riskColor}>{approval.plan.overallRisk.toUpperCase()}</Text>
      </Box>
      <Text bold>Steps ({approval.plan.steps.length}):</Text>
      {approval.plan.steps.map((step) => {
        const stepRiskColor = step.riskLevel === "high" ? "red"
          : step.riskLevel === "medium" ? "yellow" : "green";
        return (
          <Box key={step.index} paddingLeft={2}>
            <Text>[{step.index}] </Text>
            <Text>{step.description}</Text>
            <Text dimColor> ({step.toolsNeeded.join(", ")})</Text>
            <Text color={stepRiskColor}> [{step.riskLevel}]</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Permissions: </Text>
        <Text>{Object.keys(approval.plan.requiredPermissions).join(", ") || "none"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="green">[a] Allow once  </Text>
        <Text color="green">[p] Allow permanent  </Text>
        <Text color="red">[r] Deny</Text>
      </Box>
    </Box>
  );
}
