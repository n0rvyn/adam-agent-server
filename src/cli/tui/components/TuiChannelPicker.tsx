import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

interface Channel {
  id: string;
  name: string;
  platform: string;
  status?: string;
}

interface TuiChannelPickerProps {
  onSelect: (channelId: string) => void;
  onCancel: () => void;
  fetchChannels: () => Promise<{ channels: Channel[] }>;
}

export function TuiChannelPicker({ onSelect, onCancel, fetchChannels }: TuiChannelPickerProps) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchChannels()
      .then((data) => {
        setChannels(data.channels);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(`Failed to load channels: ${err instanceof Error ? err.message : String(err)}`);
        setLoading(false);
      });
  }, [fetchChannels]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    // Number key selection: 1-9
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= channels.length) {
      const ch = channels[num - 1];
      if (ch) onSelect(ch.id);
    }
  });

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading channels...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">{error}</Text>
        <Text dimColor> (Esc to cancel)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Select channel to redeliver (Esc to cancel):</Text>
      {channels.length === 0 ? (
        <Text dimColor>No channels configured.</Text>
      ) : (
        channels.map((ch, i) => (
          <Box key={ch.id}>
            <Text>[{i + 1}] </Text>
            <Text color="cyan">{ch.name}</Text>
            <Text dimColor> ({ch.platform})</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
