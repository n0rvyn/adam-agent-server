import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";
import type { MistakePattern, MistakePatternStatus } from "../../../shared/types.js";

interface MistakesProps {
  onBack: () => void;
}

export function Mistakes({ onBack }: MistakesProps) {
  const [patterns, setPatterns] = useState<MistakePattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterStatus, setFilterStatus] = useState<MistakePatternStatus | "all">("all");
  const { message, setMessage } = useFlashMessage();

  const fetchPatterns = useCallback(() => {
    setLoading(true);
    const qs = filterStatus !== "all" ? `?status=${filterStatus}` : "";
    request<{ mistakePatterns: MistakePattern[] }>(`/mistake-patterns${qs}`)
      .then(({ mistakePatterns }) => {
        setPatterns(mistakePatterns);
        setSelectedIndex(0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [filterStatus]);

  useEffect(() => {
    void fetchPatterns();
  }, [fetchPatterns]);

  const updateStatus = async (id: string, status: MistakePatternStatus) => {
    try {
      await request(`/mistake-patterns/${id}`, {
        method: "PATCH",
        body: { status },
      });
      setMessage(`Marked as ${status}`, "success");
      await fetchPatterns();
    } catch (err) {
      setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  useInput((input, key) => {
    if (key.escape || input === "q") { onBack(); return; }
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(patterns.length - 1, i + 1)); return; }
    if (input === "r") { void fetchPatterns(); return; }
    // Filter: 0=all 1=new 2=acknowledged 3=dismissed
    const statusMap: Record<string, MistakePatternStatus | "all"> = {
      "0": "all", "1": "new", "2": "acknowledged", "3": "dismissed",
    };
    if (statusMap[input]) { setFilterStatus(statusMap[input]!); return; }
    if (input === "a" && patterns.length > 0) {
      const pat = patterns[selectedIndex];
      if (pat && pat.status !== "acknowledged") { void updateStatus(pat.id, "acknowledged"); return; }
    }
    if (input === "d" && patterns.length > 0) {
      const pat = patterns[selectedIndex];
      if (pat && pat.status !== "dismissed") { void updateStatus(pat.id, "dismissed"); return; }
    }
    if (input === "n" && patterns.length > 0) {
      const pat = patterns[selectedIndex];
      if (pat && pat.status !== "new") { void updateStatus(pat.id, "new"); return; }
    }
  });

  const statusColor = (s: MistakePatternStatus): string => {
    if (s === "new") return "cyan";
    if (s === "acknowledged") return "green";
    if (s === "dismissed") return "gray";
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
      <Text bold>Mistake Patterns ({patterns.length}) (Esc:back q:quit r:refresh)</Text>
      {message && (
        <Box marginTop={1}>
          <Text color={message.type === "error" ? "red" : "green"}>
            {message.type === "success" ? "✓ " : "✗ "}{message.text}
          </Text>
        </Box>
      )}
      {/* Filter hint */}
      <Text dimColor>Filters: 0=all 1=new 2=acknowledged 3=dismissed</Text>
      <Text dimColor>Actions: a=acknowledge d=dismiss n=mark new</Text>
      {loading ? (
        <Text dimColor>Loading...</Text>
      ) : patterns.length === 0 ? (
        <Text dimColor>No mistake patterns found.</Text>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {patterns.map((pat, i) => {
            const selected = i === selectedIndex;
            const truncated = pat.dimensionValue.length > 80
              ? pat.dimensionValue.slice(0, 80) + "..."
              : pat.dimensionValue;
            return (
              <Box key={pat.id} flexDirection="column">
                <Box>
                  <Text color={selected ? "cyan" : undefined} bold={selected}>
                    {selected ? "> " : "  "}
                  </Text>
                  <Text color={statusColor(pat.status)}>[{pat.status}]</Text>
                  <Text dimColor> {timeAgo(pat.lastSeen)}</Text>
                  <Text dimColor> [{pat.dimensionType}]</Text>
                  <Text dimColor> {pat.roleIds.length} role(s)</Text>
                  <Text dimColor> x{pat.count}</Text>
                </Box>
                <Box paddingLeft={4} flexDirection="column">
                  <Text color={selected ? "cyan" : "white"}>{truncated}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
