import { useCallback, useState } from "react";
import { BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { api } from "@/lib/api.ts";
import { timeAgo } from "@/lib/format.ts";
import { ICON_SIZE } from "@/lib/ui.ts";

interface UsageStat {
  pluginPath: string;
  pluginName: string;
  usageCount: number;
  lastUsed: number;
}

export function UsageStatsCard() {
  const [showStats, setShowStats] = useState(false);
  const [usageStats, setUsageStats] = useState<UsageStat[]>([]);

  const fetchUsageStats = useCallback(async () => {
    try {
      const data = await api<{ stats: UsageStat[] }>("/plugins/stats?limit=20");
      setUsageStats(data.stats);
    } catch {
      setUsageStats([]);
    }
  }, []);

  return (
    <Card>
      <button
        className="flex w-full items-center gap-2 text-sm font-semibold text-[var(--app-text)]"
        onClick={() => {
          if (!showStats && usageStats.length === 0) void fetchUsageStats();
          setShowStats((value) => !value);
        }}
      >
        <BarChart3 size={ICON_SIZE.sm} className="text-[var(--app-text-muted)]" />
        Usage Stats
        {showStats ? (
          <ChevronDown size={ICON_SIZE.xs} className="ml-auto" />
        ) : (
          <ChevronRight size={ICON_SIZE.xs} className="ml-auto" />
        )}
      </button>
      {showStats ? (
        <div className="mt-3">
          {usageStats.length === 0 ? (
            <p className="py-2 text-center text-xs text-[var(--app-text-subtle)]">No usage data yet</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Plugin</Th>
                  <Th>Usage Count</Th>
                  <Th>Last Used</Th>
                </Tr>
              </Thead>
              <Tbody>
                {usageStats.map((stat) => (
                  <Tr key={stat.pluginPath}>
                    <Td className="text-xs font-medium text-[var(--app-text)]">{stat.pluginName}</Td>
                    <Td className="font-mono text-xs text-[var(--app-text-muted)]">{stat.usageCount}</Td>
                    <Td className="text-xs text-[var(--app-text-muted)]">
                      {stat.lastUsed ? timeAgo(stat.lastUsed) : "—"}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      ) : null}
    </Card>
  );
}
