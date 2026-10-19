import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";

interface AgentInfo {
  id: string;
  name: string;
}

interface MemoryInfo {
  id: string;
  agentId: string;
  content: string;
  importance: number;
  retrievedCount: number;
  createdAt: number;
  type?: string;
  score?: number;
}

type ImportanceFilter = "all" | "high" | "medium" | "low";

interface MemoryListProps {
  onBack: () => void;
}

function importanceColor(importance: number): string {
  if (importance >= 4) return "red";
  if (importance === 3) return "yellow";
  return "gray";
}

function importanceLabel(importance: number): string {
  if (importance >= 4) return "HIGH";
  if (importance === 3) return "MED ";
  return "LOW ";
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

export function MemoryList({ onBack }: MemoryListProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentIndex, setAgentIndex] = useState(0);
  const [memories, setMemories] = useState<MemoryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<ImportanceFilter>("all");
  const [message, setMessage] = useState<string | null>(null);
  const [isSearchResult, setIsSearchResult] = useState(false);

  const fetchAgents = useCallback(() => {
    request<{ agents: AgentInfo[] }>("/agents")
      .then(({ agents }) => {
        setAgents(agents);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const currentAgent = agents[agentIndex];

  const fetchMemories = useCallback(() => {
    if (!currentAgent) return;
    setIsSearchResult(false);
    request<{ memories: MemoryInfo[] }>(`/memories/${currentAgent.id}`)
      .then(({ memories }) => {
        setMemories(memories);
        setMessage(null);
      })
      .catch((err) => setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`));
  }, [currentAgent]);

  useEffect(() => {
    if (currentAgent) {
      fetchMemories();
    }
  }, [currentAgent, fetchMemories]);

  const handleSearch = useCallback(async (query: string) => {
    if (!currentAgent || !query.trim()) return;
    try {
      const res = await request<{ memories: MemoryInfo[]; count: number }>("/memories/query", {
        method: "POST",
        body: { agentId: currentAgent.id, prompt: query.trim() },
      });
      setMemories(res.memories);
      setIsSearchResult(true);
      setMessage(`Search: ${res.count} results`);
    } catch (err) {
      setMessage(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [currentAgent]);

  const inputMode = searchMode;

  const filteredMemories = memories.filter((m) => {
    if (filter === "all") return true;
    if (filter === "high") return m.importance > 3;
    if (filter === "medium") return m.importance === 3;
    return m.importance < 3; // low
  });

  useInput((input, key) => {
    if (inputMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery("");
        return;
      }
      if (key.return) {
        handleSearch(searchQuery);
        setSearchMode(false);
        setSearchQuery("");
        return;
      }
      return;
    }

    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (input === "a") {
      setAgentIndex((i) => (i + 1) % Math.max(1, agents.length));
      return;
    }
    if (key.leftArrow) {
      setAgentIndex((i) => (i - 1 + agents.length) % Math.max(1, agents.length));
      return;
    }
    if (key.rightArrow) {
      setAgentIndex((i) => (i + 1) % Math.max(1, agents.length));
      return;
    }
    if (input === "s") {
      setSearchMode(true);
      setSearchQuery("");
      setMessage(null);
      return;
    }
    if (input === "h") {
      setFilter((f) => (f === "high" ? "all" : "high"));
      return;
    }
    if (input === "m") {
      setFilter((f) => (f === "medium" ? "all" : "medium"));
      return;
    }
    if (input === "l") {
      setFilter((f) => (f === "low" ? "all" : "low"));
      return;
    }
    if (input === "r") {
      fetchMemories();
    }
  });

  if (loading) {
    return <Text dimColor>Loading agents...</Text>;
  }

  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No agents found</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Memories (Esc to go back)</Text>
      <Box marginTop={1}>
        <Text>Agent: </Text>
        <Text bold color="cyan">{currentAgent?.name ?? "?"}</Text>
        <Text dimColor> ({agentIndex + 1}/{agents.length}) [a/arrows to switch]</Text>
      </Box>
      <Box>
        <Text dimColor>
          Filter: {filter === "all" ? "all" : filter} | {isSearchResult ? "search results" : "all memories"} ({filteredMemories.length})
        </Text>
      </Box>
      {message && (
        <Box>
          <Text color="yellow">{message}</Text>
        </Box>
      )}
      {searchMode && (
        <Box marginTop={1}>
          <Text bold color="cyan">Search: </Text>
          <TextInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="search query..."
          />
          <Text dimColor> (Enter to search, Esc to cancel)</Text>
        </Box>
      )}
      {filteredMemories.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No memories{filter !== "all" ? ` matching filter '${filter}'` : ""}</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {filteredMemories.map((m) => (
            <Box key={m.id} marginBottom={0}>
              <Text color={importanceColor(m.importance)} bold>
                {importanceLabel(m.importance)}{" "}
              </Text>
              <Text dimColor>{pad(m.type ?? "?", 12)}</Text>
              <Text dimColor>{pad(`×${m.retrievedCount ?? 0}`, 5)}</Text>
              <Text>{truncate(m.content, 55)} </Text>
              <Text dimColor>{formatDate(m.createdAt)}</Text>
              {m.score !== undefined && <Text dimColor> ({m.score.toFixed(2)})</Text>}
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>s:search h:high m:medium l:low a:agent r:refresh</Text>
      </Box>
    </Box>
  );
}

function pad(s: string, len: number): string {
  if (!s) return " ".repeat(len);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 3) + "...";
}
