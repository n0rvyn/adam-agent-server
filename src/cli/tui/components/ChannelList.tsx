import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { request } from "../../client.js";
import type { Channel } from "../../../shared/types.js";

interface ChannelListProps {
  onBack: () => void;
}

const statusColors: Record<string, string> = {
  connected: "green",
  connecting: "yellow",
  disconnected: "gray",
  error: "red",
};

export function ChannelList({ onBack }: ChannelListProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<Channel | null>(null);
  const [actionMsg, setActionMsg] = useState("");

  useEffect(() => {
    void loadChannels();
  }, []);

  async function loadChannels() {
    try {
      const data = await request<{ channels: Channel[] }>("/channels");
      setChannels(data.channels);
    } catch {
      // Failed to load
    }
    setLoading(false);
  }

  async function handleConnect(id: string) {
    const ch = channels.find((c) => c.id === id);
    if (ch?.platform === "wechat") {
      try {
        setActionMsg("Starting WeChat QR login...");
        const result = await request<{ qrcodeUrl?: string; sessionKey?: string; message: string }>(
          `/channels/${id}/wechat/qr-start`, { method: "POST" },
        );
        if (result.qrcodeUrl) {
          setActionMsg(`Scan QR: ${result.qrcodeUrl}\nWaiting for scan...`);
          const waitResult = await request<{ connected: boolean; message: string }>(
            `/channels/${id}/wechat/qr-wait`,
            { method: "POST", body: { sessionKey: result.sessionKey, timeoutMs: 120000 } },
          );
          setActionMsg(waitResult.message);
        } else {
          setActionMsg(result.message);
        }
        void loadChannels();
      } catch {
        setActionMsg("WeChat connect failed");
      }
    } else {
      try {
        await request(`/channels/${id}/connect`, { method: "POST" });
        setActionMsg("Connecting...");
        void loadChannels();
      } catch {
        setActionMsg("Connect failed");
      }
    }
  }

  async function handleDisconnect(id: string) {
    try {
      await request(`/channels/${id}/disconnect`, { method: "POST" });
      setActionMsg("Disconnected");
      void loadChannels();
    } catch {
      setActionMsg("Disconnect failed");
    }
  }

  useInput((input, key) => {
    if (detail) {
      // In detail view: Escape goes back to list
      if (key.escape || input === "q") { setDetail(null); return; }
      if (input === "c") { void handleConnect(detail.id); return; }
      if (input === "d") { void handleDisconnect(detail.id); return; }
      return;
    }

    if (key.escape) { onBack(); return; }
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(channels.length - 1, s + 1)); return; }
    if (key.return && channels[selected]) { setDetail(channels[selected]); setActionMsg(""); return; }
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading channels...</Text>
      </Box>
    );
  }

  // Detail view
  if (detail) {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Channel: {detail.name}</Text>
          <Text dimColor>  (Esc to go back)</Text>
        </Box>
        <Box flexDirection="column" gap={0}>
          <Text>ID:       {detail.id}</Text>
          <Text>Platform: {detail.platform}</Text>
          <Text>Status:   <Text color={statusColors[detail.status] ?? "white"}>{detail.status}</Text></Text>
          <Text>Enabled:  {detail.enabled ? "yes" : "no"}</Text>
          <Text>Messages: {detail.messageCount}</Text>
          <Text>Config:   {JSON.stringify(detail.config)}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>[c] Connect  [d] Disconnect  [Esc] Back</Text>
        </Box>
        {actionMsg && <Text color="yellow">{actionMsg}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Channels</Text>
        <Text dimColor>  ({channels.length} total)  </Text>
        <Text dimColor>Arrow keys to select, Enter for detail, Esc to return</Text>
      </Box>

      {channels.length === 0 ? (
        <Text dimColor>No channels configured. Add channels via API or config.</Text>
      ) : (
        <Box flexDirection="column">
          {/* Header */}
          <Box>
            <Box width={3}><Text dimColor> </Text></Box>
            <Box width={12}><Text bold dimColor>ID</Text></Box>
            <Box width={16}><Text bold dimColor>Name</Text></Box>
            <Box width={12}><Text bold dimColor>Platform</Text></Box>
            <Box width={14}><Text bold dimColor>Status</Text></Box>
            <Box width={10}><Text bold dimColor>Enabled</Text></Box>
            <Box width={10}><Text bold dimColor>Messages</Text></Box>
          </Box>

          {/* Rows */}
          {channels.map((ch, i) => (
            <Box key={ch.id}>
              <Box width={3}>
                <Text>{i === selected ? ">" : " "}</Text>
              </Box>
              <Box width={12}>
                <Text inverse={i === selected}>{ch.id.slice(0, 8)}</Text>
              </Box>
              <Box width={16}>
                <Text>{ch.name}</Text>
              </Box>
              <Box width={12}>
                <Text>{ch.platform}</Text>
              </Box>
              <Box width={14}>
                <Text color={statusColors[ch.status] ?? "white"}>
                  {ch.status === "connected" ? "●" : ch.status === "error" ? "✗" : "○"} {ch.status}
                </Text>
              </Box>
              <Box width={10}>
                <Text color={ch.enabled ? "green" : "gray"}>
                  {ch.enabled ? "yes" : "no"}
                </Text>
              </Box>
              <Box width={10}>
                <Text>{ch.messageCount}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
