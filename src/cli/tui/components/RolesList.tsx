import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useCallback } from "react";
import { request } from "../../client.js";
import type { Role } from "../../../shared/types.js";
import { useFlashMessage } from "../hooks/useFlashMessage.js";
import { RoleDetail } from "./RoleDetail.js";

interface RoleItem {
  id: string;
  name: string;
  status: string;
  performanceScore?: number;
  createdAt: number;
  presetId?: string;
  /** Phase 2: contract compliance EMA, 0-1 or null */
  contractComplianceEma?: number | null;
}

interface RolesListProps {
  onBack: () => void;
}

export function RolesList({ onBack }: RolesListProps) {
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<"list" | "detail">("list");
  const [detailRoleId, setDetailRoleId] = useState<string | null>(null);
  const { message, setMessage, clearMessage } = useFlashMessage();

  const fetchRoles = useCallback(() => {
    setLoading(true);
    request<{ roles: Role[] }>("/roles")
      .then(({ roles }) => {
        setRoles(roles.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          performanceScore: r.performanceScore,
          createdAt: r.createdAt,
          presetId: r.presetId,
          contractComplianceEma: (r as { contractComplianceEma?: number | null }).contractComplianceEma,
        })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  useInput((input, key) => {
    if (key.escape || input === "q") { onBack(); return; }
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(roles.length - 1, i + 1)); return; }
    if (input === "r") { fetchRoles(); clearMessage(); }
    if (input === "\n" || input === "o" || input === "e") {
      if (roles.length > 0) {
        setDetailRoleId(roles[selectedIndex]!.id);
        setMode("detail");
      }
      return;
    }
  });

  if (loading) return <Text dimColor>Loading roles...</Text>;

  if (mode === "detail" && detailRoleId) {
    return <RoleDetail roleId={detailRoleId} onBack={() => setMode("list")} />;
  }

  return (
    <Box flexDirection="column">
      <Text bold>Roles ({roles.length}) (Esc to go back)</Text>
      {message && (
        <Box marginTop={1}>
          <Text
            color={message.type === "success" ? "green" : message.type === "error" ? "red" : "gray"}
          >
            {message.type === "success" ? "✓ " : message.type === "error" ? "✗ " : "→ "}
            {message.text}
          </Text>
        </Box>
      )}
      {roles.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No roles found. Roles define agent behavior and bind plugins.</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {roles.map((r, i) => {
            const selected = i === selectedIndex;
            const score = r.performanceScore != null ? `${(r.performanceScore * 100).toFixed(0)}%` : "—";
            const contractScore = r.contractComplianceEma != null
              ? `[契约 ${(r.contractComplianceEma).toFixed(2)}]`
              : "[契约 —]";
            return (
              <Box key={r.id}>
                <Text color={selected ? "cyan" : undefined} bold={selected}>
                  {selected ? "> " : "  "}
                </Text>
                <Text color={selected ? "cyan" : undefined} bold={selected}>
                  {pad(r.name, 24)}
                </Text>
                {r.presetId && (
                  <Text dimColor>[{r.presetId}]</Text>
                )}
                <Text color={statusColor(r.status)}>
                  {pad(r.status, 12)}
                </Text>
                <Text dimColor>
                  {pad(score, 8)}
                </Text>
                <Text dimColor>
                  {contractScore}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter/O/E:open Esc:back r:refresh</Text>
      </Box>
    </Box>
  );
}

function statusColor(status: string): string {
  if (status === "active") return "green";
  if (status === "probation") return "yellow";
  if (status === "retired" || status === "dead") return "red";
  return "gray";
}

function pad(s: string, len: number): string {
  if (!s) return " ".repeat(len);
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
