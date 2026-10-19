import { useEffect } from "react";
import { Lightbulb, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { Table, Thead, Tbody, Tr, Th, Td } from "@/components/ui/Table.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { timeAgo } from "@/lib/format.ts";
const ROLE_COLORS: Record<string, string> = {
  engineer: "info",
  analyst: "warning",
  content_creator: "success",
  reviewer: "muted",
};

export function Strategies() {
  const strategies = useAppStore((s) => s.strategies);
  const fetchStrategies = useAppStore((s) => s.fetchStrategies);

  useEffect(() => {
    void fetchStrategies();
  }, [fetchStrategies]);

  // Group by role
  const grouped = new Map<string, typeof strategies>();
  for (const s of strategies) {
    const list = grouped.get(s.roleId) ?? [];
    list.push(s);
    grouped.set(s.roleId, list);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        compact
        title="Strategies"
        description="Bandit strategies grouped by role."
        metrics={[
          { label: "Catalog", value: strategies.length },
          { label: "Roles", value: grouped.size },
          { label: "Mature", value: strategies.filter((strategy) => strategy.totalTrials >= 10).length },
        ]}
        className="px-4 py-3 lg:px-4 lg:py-3"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void fetchStrategies()}>
            <RefreshCw size={14} />
          </Button>
        }
      />

      {strategies.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Lightbulb size={32} />}
            title="No strategies"
            description="Strategies are created by the Thompson Sampling engine as agents process tasks."
            compact
          />
        </Card>
      ) : (
        Array.from(grouped.entries()).map(([role, strats]) => (
          <div key={role} className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant={(ROLE_COLORS[role] ?? "muted") as "info" | "warning" | "success" | "muted"}>
                {role}
              </Badge>
              <span className="text-xs text-[var(--app-text-subtle)]">{strats.length} strategies</span>
            </div>

            <Card padding={false}>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Name</Th>
                    <Th>Task Type</Th>
                    <Th>Alpha</Th>
                    <Th>Beta</Th>
                    <Th>Trials</Th>
                    <Th>Avg Reward</Th>
                    <Th>Created</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {strats.map((s) => (
                    <Tr key={s.id}>
                      <Td className="font-medium text-[var(--app-text)]">{s.name}</Td>
                      <Td>
                        <span className="rounded bg-[var(--app-panel-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--app-text-muted)]">
                          {s.taskType}
                        </span>
                      </Td>
                      <Td className="font-mono text-xs">{s.alpha.toFixed(2)}</Td>
                      <Td className="font-mono text-xs">{s.beta.toFixed(2)}</Td>
                      <Td className="font-mono text-xs">{s.totalTrials}</Td>
                      <Td className="font-mono text-xs">
                        {s.avgReward != null ? s.avgReward.toFixed(3) : "\u2014"}
                      </Td>
                      <Td className="text-xs text-[var(--app-text-subtle)]">{timeAgo(s.createdAt)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Card>
          </div>
        ))
      )}
    </div>
  );
}
