import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback, useRef } from "react";
import { listArtifacts, getArtifact, deleteArtifact, redeliverArtifact, type Artifact } from "../lib/artifacts-api.js";
import { writeClipboard } from "../lib/clipboard.js";
import { ArtifactDetail } from "./ArtifactDetail.js";
import { TuiChannelPicker } from "./TuiChannelPicker.js";
import { getDangerClass } from "../../../lib/artifact-danger-class.js";
import { useTuiState } from "../hooks/useTuiState.js";

export type { Artifact };

type ActionKey = "d" | "r" | "c" | "t";

interface ArtifactsListProps {
  onBack: () => void;
  onSelect: (artifact: Artifact) => void;
  onAction: (key: ActionKey, artifact: Artifact) => void;
}

/** Strip ANSI control chars from filename before display (threat model input validation). */
function sanitizeFilename(name: string | undefined): string {
  if (!name) return "";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1F\x7F]/g, "");
}

function pad(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sourceKindShort(sk: string): string {
  if (sk === "template_step") return "tmpl";
  if (sk === "task_published") return "task";
  if (sk === "chat_sent") return "chat";
  return sk.slice(0, 6);
}

export function ArtifactsList({ onBack, onSelect, onAction }: ArtifactsListProps) {
  const { dispatch } = useTuiState();

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [viewMode, setViewMode] = useState<"list" | "detail">("list");
  const [detailArtifact, setDetailArtifact] = useState<Artifact | null>(null);
  const [detailLog, setDetailLog] = useState<unknown[]>([]);

  // Task 4 state
  const [confirmingDelete, setConfirmingDelete] = useState<Artifact | null>(null);
  const [showChannelPicker, setShowChannelPicker] = useState<Artifact | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }

  const fetchArtifacts = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    setError(null);
    listArtifacts({ limit: 100 })
      .then((data) => {
        setArtifacts(data.artifacts);
        setTotal(data.total);
        setCursor(0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(`Failed to load: ${err instanceof Error ? err.message : String(err)}`);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchArtifacts();
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [fetchArtifacts]);

  // Confirm-delete input handler (runs when confirmingDelete is set)
  useInput((input, key) => {
    if (!confirmingDelete) return;
    if (input === "y") {
      const art = confirmingDelete;
      setConfirmingDelete(null);
      deleteArtifact(art.id, true)
        .then(() => { showToast("Deleted"); fetchArtifacts(); })
        .catch((err: unknown) => showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`));
    } else if (input === "n" || key.escape) {
      setConfirmingDelete(null);
    }
    // Other keys are ignored (no cancel, no dismiss)
  });

  // Main input handler
  useInput((input, key) => {
    // Skip if in a sub-mode
    if (confirmingDelete || showChannelPicker) return;

    if (key.escape || input === "q") {
      onBack();
      return;
    }

    if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(Math.max(0, artifacts.length - 1), c + 1));
      return;
    }

    if (input === "\r" || input === "\n" || input === "o") {
      if (artifacts.length > 0 && artifacts[cursor]) {
        const art = artifacts[cursor]!;
        onSelect(art);
        getArtifact(art.id)
          .then((data) => {
            setDetailArtifact(data.artifact);
            setDetailLog(data.deliveryLog);
            setViewMode("detail");
          })
          .catch(() => {
            setDetailArtifact(art);
            setDetailLog([]);
            setViewMode("detail");
          });
      }
      return;
    }

    const art = artifacts.length > 0 ? artifacts[cursor] : undefined;
    if (!art) return;

    if (input === "d") {
      onAction("d", art);
      const dangerClass = getDangerClass(art.mime);
      if (dangerClass) {
        setConfirmingDelete(art);
      } else {
        deleteArtifact(art.id, false)
          .then(() => { showToast("Deleted"); fetchArtifacts(); })
          .catch((err: unknown) => showToast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`));
      }
      return;
    }

    if (input === "r") {
      onAction("r", art);
      setShowChannelPicker(art);
      return;
    }

    if (input === "c") {
      onAction("c", art);
      const blobPath = art.blobPath ?? "";
      writeClipboard(blobPath)
        .then((ok) => {
          if (ok) showToast(`Copied: ${blobPath.slice(-40)}`);
          else showToast("Clipboard unavailable");
        })
        .catch(() => showToast("Clipboard unavailable"));
      return;
    }

    if (input === "t") {
      onAction("t", art);
      const taskId = art.taskId ?? art.executionId;
      dispatch({ type: "SET_VIEW", view: "tasks", selectedTaskId: taskId });
      return;
    }
  });

  // Channel picker fetch helper
  const fetchChannelsForPicker = useCallback(() => {
    const { getApiKey, getPort } = (() => {
      // Inline minimal fetch for channels list
      return {
        getApiKey: () => process.env.ADAM_API_KEY ?? "",
        getPort: () => Number(process.env.ADAM_PORT ?? 7100),
      };
    })();
    return fetch(`http://localhost:${getPort()}/channels`, {
      headers: { "x-api-key": getApiKey() },
    }).then((res) => res.json() as Promise<{ channels: Array<{ id: string; name: string; platform: string; status?: string }> }>);
  }, []);

  if (viewMode === "detail" && detailArtifact) {
    return (
      <ArtifactDetail
        artifact={detailArtifact}
        deliveryLog={detailLog as Parameters<typeof ArtifactDetail>[0]["deliveryLog"]}
        onBack={() => setViewMode("list")}
      />
    );
  }

  if (showChannelPicker) {
    const art = showChannelPicker;
    return (
      <TuiChannelPicker
        fetchChannels={fetchChannelsForPicker}
        onSelect={(channelId) => {
          setShowChannelPicker(null);
          redeliverArtifact(art.id, { channelId })
            .then((result) => showToast(`Redeliver queued: ${result.status}`))
            .catch((err: unknown) => showToast(`Redeliver failed: ${err instanceof Error ? err.message : String(err)}`));
        }}
        onCancel={() => setShowChannelPicker(null)}
      />
    );
  }

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text bold>Artifacts</Text>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text bold>Artifacts</Text>
        <Text color="red">{error}</Text>
        <Text dimColor>Press Esc to go back or r to retry</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Artifacts ({total}) (Esc to go back)</Text>
      {/* Header row */}
      <Box>
        <Text dimColor bold>
          {"  "}
          {pad("#", 3)}
          {pad("Source", 12)}
          {pad("Role", 12)}
          {pad("Mime", 16)}
          {pad("Size", 8)}
          {pad("Created", 16)}
          {"Delivered"}
        </Text>
      </Box>
      {artifacts.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No artifacts found.</Text>
        </Box>
      ) : (
        artifacts.map((a, i) => {
          const selected = i === cursor;
          const mime = a.mime ?? "unknown";
          const roleName = a.producedByRole ?? a.roleId ?? "—";
          return (
            <Box key={a.id}>
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {selected ? "> " : "  "}
              </Text>
              <Text color={selected ? "cyan" : undefined} bold={selected}>
                {pad(String(i + 1), 3)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {pad(sourceKindShort(a.sourceKind), 12)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {pad(sanitizeFilename(roleName).slice(0, 11), 12)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {pad(mime.slice(0, 15), 16)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {pad(formatBytes(a.sizeBytes), 8)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {pad(formatRelativeTime(a.createdAt), 16)}
              </Text>
              <Text color={selected ? "cyan" : undefined}>
                {"—"}
              </Text>
            </Box>
          );
        })
      )}
      {/* Confirm delete prompt */}
      {confirmingDelete && (
        <Box marginTop={1}>
          <Text color="red">
            Delete this {getDangerClass(confirmingDelete.mime)} file? (y/n)
          </Text>
        </Box>
      )}
      {/* Toast */}
      {toast && !confirmingDelete && (
        <Box marginTop={1}>
          <Text color="green">{toast}</Text>
        </Box>
      )}
      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>j/k=navigate enter=detail d=delete r=redeliver c=copy t=task</Text>
      </Box>
    </Box>
  );
}
