import { Box, Text } from "ink";
import React from "react";
import { StatusReportLine, type StatusReportPhase } from "./StatusReportLine.js";
import { ResultDeliveryBox } from "./ResultDeliveryBox.js";
import { ApprovalSelect } from "./ApprovalSelect.js";
import { SystemNoteLine } from "./SystemNoteLine.js";
import { AuditNoteLine } from "./AuditNoteLine.js";
import { ThreadBox } from "./ThreadBox.js";
import { useRoleNames } from "../hooks/useRoleNames.js";
import { taskShortId } from "../role-colors.js";
import type {
  ChatEnvelopeKind,
  ApprovalShape,
  ChatAttachment,
  DeliveryTarget,
} from "../../../shared/types.js";

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  taskId?: string;
  createdAt?: number;
  kind?: ChatEnvelopeKind;
  threadRoot?: string;
  parentMessageId?: string;
  promptId?: string;
  approvalShape?: ApprovalShape;
  roleId?: string;
  attachments?: ChatAttachment[];
  mirroredToTargets?: DeliveryTarget[];
  platformMessageId?: string;
  seq?: number;
}

interface MessageHistoryProps {
  messages: Message[];
  /** Called when an inline ApprovalSelect successfully submits. */
  onApprovalSubmitted?: (promptId: string) => void;
  /** Called when an inline ApprovalSelect POST fails. */
  onApprovalFailed?: (promptId: string) => void;
}

/** Phase string inferred from envelope content for status_report; default 'running'. */
function phaseFromContent(content: string): StatusReportPhase {
  const c = content.toLowerCase();
  if (c.includes("completed") || c.includes("done") || c.includes("成功")) return "completed";
  if (c.includes("failed") || c.includes("error") || c.includes("失败")) return "failed";
  if (c.includes("retry") || c.includes("重试")) return "retrying";
  if (c.includes("blocked") || c.includes("auth_required") || c.includes("阻塞")) return "blocked";
  return "running";
}

/** Derive roleName from useRoleNames cache + taskShortId from util at render. */
function makeEnvelopeRenderer(
  getName: (roleId: string | undefined | null) => string,
  onApprovalSubmitted?: (promptId: string) => void,
  onApprovalFailed?: (promptId: string) => void,
) {
  return function renderEnvelope(msg: Message, key: string | number) {
    // user_message + assistant_text + undefined kind: default bubble (legacy)
    if (!msg.kind || msg.kind === "user_message" || msg.kind === "assistant_text") {
      return (
        <Box key={key} flexDirection="column" marginBottom={1}>
          <Text dimColor bold>{msg.role === "user" ? "You:" : "Adam:"}</Text>
          <Text>{msg.content}</Text>
        </Box>
      );
    }
    if (msg.kind === "status_report") {
      return (
        <StatusReportLine
          key={key}
          content={msg.content}
          phase={phaseFromContent(msg.content)}
          taskShortId={taskShortId(msg.taskId)}
        />
      );
    }
    if (msg.kind === "result_delivery") {
      return (
        <ResultDeliveryBox
          key={key}
          content={msg.content}
          roleId={msg.roleId}
          roleName={getName(msg.roleId)}
          taskShortIdLabel={taskShortId(msg.taskId)}
          attachments={msg.attachments}
          mirroredToTargets={msg.mirroredToTargets}
          createdAt={msg.createdAt}
        />
      );
    }
    if (msg.kind === "approval_prompt" && msg.promptId && msg.approvalShape) {
      const promptId = msg.promptId;
      return (
        <ApprovalSelect
          key={key}
          promptId={promptId}
          content={msg.content}
          shape={msg.approvalShape}
          onSubmitted={() => onApprovalSubmitted?.(promptId)}
          onSubmitFailure={() => onApprovalFailed?.(promptId)}
        />
      );
    }
    if (msg.kind === "system_note") {
      return <SystemNoteLine key={key} content={msg.content} />;
    }
    if (msg.kind === "audit_note") {
      return <AuditNoteLine key={key} content={msg.content} />;
    }
    return <Text key={key} dimColor>{msg.content}</Text>;
  };
}

/** DP-004: >=3 consecutive status_report in the same thread → drop them, replace with synthetic entry. */
function compressStatusReports(
  msgs: Message[],
): Array<Message | { __synthetic: true; count: number; lastContent: string }> {
  const result: Array<Message | { __synthetic: true; count: number; lastContent: string }> = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.kind === "status_report") {
      let j = i;
      while (j < msgs.length && msgs[j].kind === "status_report") j++;
      const run = j - i;
      if (run >= 3) {
        // Replace all N consecutive status_reports with a single synthetic entry
        result.push({ __synthetic: true, count: run, lastContent: msgs[j - 1].content });
        i = j;
        continue;
      }
      // < 3 consecutive: keep each as-is (no compression)
    }
    result.push(m);
    i++;
  }
  return result;
}

export function MessageHistory({
  messages,
  onApprovalSubmitted,
  onApprovalFailed,
}: MessageHistoryProps) {
  const { getName } = useRoleNames();
  const renderEnvelope = makeEnvelopeRenderer(getName, onApprovalSubmitted, onApprovalFailed);

  if (messages.length === 0) return null;

  // Group by threadRoot (null/undefined → free conversation)
  const free: Message[] = [];
  const threads: Map<string, Message[]> = new Map();
  for (const m of messages) {
    if (!m.threadRoot) {
      free.push(m);
    } else {
      const arr = threads.get(m.threadRoot) ?? [];
      arr.push(m);
      threads.set(m.threadRoot, arr);
    }
  }

  return (
    <Box flexDirection="column">
      {/* Free conversation (no thread) */}
      {free.map((m, i) => renderEnvelope(m, `free-${m.id ?? i}`))}

      {/* Thread groups */}
      {Array.from(threads.entries()).map(([root, threadMsgs]) => {
        const head = threadMsgs[0];
        const compressed = compressStatusReports(threadMsgs);
        return (
          <ThreadBox
            key={`thread-${root}`}
            threadRoot={root}
            roleId={head.roleId}
            roleName={getName(head.roleId)}
            taskShortIdLabel={taskShortId(head.taskId)}
            brief={head.content.slice(0, 30)}
          >
            {compressed.map((entry, i) => {
              if ("__synthetic" in entry) {
                return (
                  <Text key={`compressed-${i}`} dimColor>
                    … {entry.count} 条进展（最近: {entry.lastContent.slice(0, 40)}）
                  </Text>
                );
              }
              return renderEnvelope(entry, `${root}-${entry.id ?? i}`);
            })}
          </ThreadBox>
        );
      })}
    </Box>
  );
}
