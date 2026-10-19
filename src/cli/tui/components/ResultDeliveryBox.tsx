import { Box, Text } from "ink";
import React from "react";
import { roleColor, type RoleInkColor } from "../role-colors.js";
import type { ChatAttachment, DeliveryTarget } from "../../../shared/types.js";

interface ResultDeliveryBoxProps {
  content: string;
  roleId?: string;
  /** Pre-derived role name from useRoleNames() at the render site. */
  roleName?: string;
  /** Pre-derived task short id (T-XXXXXXXX) from taskShortId() at the render site. */
  taskShortIdLabel?: string;
  attachments?: ChatAttachment[];
  mirroredToTargets?: DeliveryTarget[];
  createdAt?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHHMM(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatTargets(targets: DeliveryTarget[]): string {
  return targets
    .map((t) => {
      if (t.type === "channel" && t.channelId) return t.channelId;
      if (t.type === "webhook" && t.webhookUrl) {
        try { return new URL(t.webhookUrl).hostname; } catch { return t.webhookUrl; }
      }
      return t.type;
    })
    .join(", ");
}

export function ResultDeliveryBox(props: ResultDeliveryBoxProps) {
  const color: RoleInkColor = roleColor(props.roleId);
  const headerLabel = props.roleName ?? "?";
  const taskTag = props.taskShortIdLabel ? ` · ${props.taskShortIdLabel}` : "";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box>
        <Text bold color={color}>
          [{headerLabel}{taskTag}]
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{props.content}</Text>
      </Box>
      {props.attachments && props.attachments.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {props.attachments.map((a) => {
            const purpose = a.purpose ? `purpose=${a.purpose}, ` : "";
            return (
              <Text key={a.artifactId} dimColor>
                [file] {a.filename} ({purpose}{formatBytes(a.size)}) → {a.locator}
              </Text>
            );
          })}
        </Box>
      )}
      {props.mirroredToTargets && props.mirroredToTargets.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor italic>
            (also delivered to: {formatTargets(props.mirroredToTargets)} @ {formatHHMM(props.createdAt)})
          </Text>
        </Box>
      )}
    </Box>
  );
}
