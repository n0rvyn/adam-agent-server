import { Box, Text, useInput } from "ink";
import React, { useState, useMemo } from "react";
import TextInput from "ink-text-input";
import { type Command, filterCommands, findPrefixMatch } from "../commands.js";

interface InputBarProps {
  onSubmit: (value: string) => void;
  commands?: Command[];
}

export function InputBar({ onSubmit }: InputBarProps) {
  const [value, setValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [autocompleteActive, setAutocompleteActive] = useState(false);

  const showAutocomplete = value.startsWith("/") && value.length >= 1;
  const query = value.slice(1);
  const filtered = useMemo(
    () => (showAutocomplete ? filterCommands(query) : []),
    [showAutocomplete, query],
  );

  const handleChange = (v: string) => {
    setValue(v);
    if (v.startsWith("/")) {
      setAutocompleteActive(true);
      setSelectedIndex(0);
    } else {
      setAutocompleteActive(false);
    }
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      const cmd = trimmed.slice(1);
      // Exact match or prefix fallback
      const match = findPrefixMatch(cmd);
      if (match) {
        onSubmit(`/${match.name}`);
      } else {
        onSubmit(trimmed);
      }
    } else {
      onSubmit(trimmed);
    }
    setValue("");
    setAutocompleteActive(false);
  };

  const selectCommand = (cmd: Command) => {
    onSubmit(`/${cmd.name}`);
    setValue("");
    setAutocompleteActive(false);
  };

  useInput(
    (input, key) => {
      if (!autocompleteActive || !showAutocomplete || filtered.length === 0) return;

      if (key.upArrow) {
        setSelectedIndex((i) => (i <= 0 ? filtered.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => (i >= filtered.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.tab) {
        const selected = filtered[selectedIndex];
        if (selected) selectCommand(selected);
        return;
      }
      if (key.escape) {
        setAutocompleteActive(false);
        setValue("");
        return;
      }
    },
    { isActive: autocompleteActive && showAutocomplete && filtered.length > 0 },
  );

  return (
    <Box flexDirection="column">
      {autocompleteActive && showAutocomplete && filtered.length > 0 && (
        <Box flexDirection="column" marginBottom={0} paddingX={1}>
          {filtered.map((cmd, i) => {
            const selected = i === selectedIndex;
            return (
              <Box key={cmd.name}>
                <Text color={selected ? "cyan" : "gray"} bold={selected}>
                  {selected ? "▸ " : "  "}
                </Text>
                <Text color={selected ? "cyan" : "white"} bold={selected}>
                  /{cmd.name}
                </Text>
                <Text dimColor> — {cmd.description}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box borderStyle="round" borderDimColor>
        <Text bold>▸ </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder="Type a message or / for commands..."
        />
      </Box>
    </Box>
  );
}
