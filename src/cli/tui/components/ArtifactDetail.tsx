import { Box, Text, useInput } from "ink";
import React from "react";
import type { Artifact } from "../lib/artifacts-api.js";

interface DeliveryLogEntry {
  status: string;
  target?: { channelId?: string };
  createdAt?: number;
}

interface ArtifactDetailProps {
  artifact: Artifact;
  deliveryLog: DeliveryLogEntry[];
  onBack: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(20)}</Text>
      <Text color="cyan">{value}</Text>
    </Box>
  );
}

export function ArtifactDetail({ artifact, deliveryLog, onBack }: ArtifactDetailProps) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Artifact Detail (Esc to go back)</Text>
      <Box flexDirection="column" marginTop={1}>
        <Row label="ID" value={artifact.id} />
        <Row label="Source" value={artifact.sourceKind} />
        <Row label="Role" value={artifact.producedByRole ?? artifact.roleId ?? "—"} />
        <Row label="Mime" value={artifact.mime ?? "—"} />
        <Row label="Kind" value={artifact.kind} />
        <Row label="Size" value={formatBytes(artifact.sizeBytes)} />
        <Row label="Created" value={formatDate(artifact.createdAt)} />
        <Row label="Key" value={artifact.key ?? "—"} />
        <Row label="Blob path" value={artifact.blobPath ?? "—"} />
        {artifact.executionId && <Row label="Execution ID" value={artifact.executionId} />}
        {artifact.taskId && <Row label="Task ID" value={artifact.taskId} />}
        {artifact.chatSessionId && <Row label="Chat Session" value={artifact.chatSessionId} />}
        {artifact.originalFilename && (
          <Row label="Filename" value={artifact.originalFilename} />
        )}
      </Box>

      {deliveryLog.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Delivery Log ({deliveryLog.length})</Text>
          {deliveryLog.map((entry, i) => (
            <Box key={i}>
              <Text dimColor>  </Text>
              <Text color={entry.status === "delivered" ? "green" : entry.status === "failed" ? "red" : "yellow"}>
                {entry.status}
              </Text>
              <Text dimColor>
                {" → "}
                {entry.target?.channelId ?? "—"}
                {entry.createdAt ? ` (${new Date(entry.createdAt).toLocaleTimeString()})` : ""}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {deliveryLog.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>No delivery log entries.</Text>
        </Box>
      )}
    </Box>
  );
}
