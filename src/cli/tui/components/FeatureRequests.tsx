import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";

type FeatureRequestStatus = "new" | "reviewed" | "dismissed" | "converted";

interface FeatureRequest {
  id: string;
  content: string;
  summary?: string;
  status: FeatureRequestStatus;
  tags?: string[];
  evidenceQuote?: string;
  extractedAt: number;
  createdAt: number;
}

interface FeatureRequestsProps {
  onBack: () => void;
}

export function FeatureRequests({ onBack }: FeatureRequestsProps) {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterStatus, setFilterStatus] = useState<FeatureRequestStatus | "all">("all");
  const { message, setMessage } = useFlashMessage();

  const fetchRequests = useCallback(() => {
    setLoading(true);
    const qs = filterStatus !== "all" ? `?status=${filterStatus}` : "";
    request<{ featureRequests: FeatureRequest[] }>(`/feature-requests${qs}`)
      .then(({ featureRequests }) => {
        setRequests(featureRequests);
        setSelectedIndex(0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filterStatus]);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  const updateStatus = async (id: string, status: FeatureRequestStatus) => {
    try {
      await request(`/feature-requests/${id}/status`, {
        method: "PATCH",
        body: { status },
      });
      setMessage(`Marked as ${status}`, "success");
      await fetchRequests();
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const filteredRequests = requests;

  useInput((input, key) => {
    if (key.escape || input === "q") { onBack(); return; }
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(filteredRequests.length - 1, i + 1)); return; }
    if (input === "r") { void fetchRequests(); return; }
    // Filter: 1=new, 2=reviewed, 3=dismissed, 4=converted, 0=all
    const statusMap: Record<string, FeatureRequestStatus | "all"> = {
      "0": "all", "1": "new", "2": "reviewed", "3": "dismissed", "4": "converted",
    };
    if (statusMap[input]) { setFilterStatus(statusMap[input]!); return; }
    if (input === "s" && filteredRequests.length > 0) {
      const req = filteredRequests[selectedIndex];
      if (req && req.status === "new") { void updateStatus(req.id, "reviewed"); return; }
    }
    if (input === "d" && filteredRequests.length > 0) {
      const req = filteredRequests[selectedIndex];
      if (req) { void updateStatus(req.id, "dismissed"); return; }
    }
    if (input === "c" && filteredRequests.length > 0) {
      const req = filteredRequests[selectedIndex];
      if (req) { void updateStatus(req.id, "converted"); return; }
    }
  });

  const statusColor = (s: FeatureRequestStatus): string => {
    if (s === "new") return "cyan";
    if (s === "reviewed") return "green";
    if (s === "dismissed") return "gray";
    if (s === "converted") return "yellow";
    return "white";
  };

  const timeAgo = (ts: number): string => {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "now";
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  return (
    <Box flexDirection="column">
      <Text bold>Feature Requests ({filteredRequests.length}) (Esc:back q:quit r:refresh)</Text>
      {message && (
        <Box marginTop={1}>
          <Text color={message.type === "error" ? "red" : "green"}>
            {message.type === "success" ? "✓ " : "✗ "}{message.text}
          </Text>
        </Box>
      )}
      {/* Filter hint */}
      <Text dimColor>Filters: 0=all 1=new 2=reviewed 3=dismissed 4=converted</Text>
      <Text dimColor>Actions: s=reviewed d=dismissed c=converted</Text>
      {loading ? (
        <Text dimColor>Loading...</Text>
      ) : filteredRequests.length === 0 ? (
        <Text dimColor>No feature requests found.</Text>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {filteredRequests.map((req, i) => {
            const selected = i === selectedIndex;
            const truncated = req.content.length > 80 ? req.content.slice(0, 80) + "..." : req.content;
            return (
              <Box key={req.id} flexDirection="column">
                <Box>
                  <Text color={selected ? "cyan" : undefined} bold={selected}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text color={statusColor(req.status)}>[{req.status}]</Text>
                  <Text dimColor> {timeAgo(req.extractedAt)}</Text>
                  {req.tags && req.tags.length > 0 && (
                    <Text dimColor> {req.tags.slice(0, 3).join(", ")}</Text>
                  )}
                </Box>
                <Box paddingLeft={4} flexDirection="column">
                  {req.summary && (
                    <Text color={selected ? "cyan" : "white"}>{req.summary}</Text>
                  )}
                  <Text dimColor>{truncated}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
