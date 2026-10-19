import { useEffect, useState, useCallback } from "react";
import { CircleDollarSign, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Card } from "@/components/ui/Card.tsx";
import { Badge } from "@/components/ui/Badge.tsx";
import { Button } from "@/components/ui/Button.tsx";
import { EmptyState } from "@/components/ui/EmptyState.tsx";
import { PageHeader } from "@/components/layout/PageHeader.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { getCostSummary, getCostDetail } from "@/lib/api.ts";

// ─── Local types ─────────────────────────────────────────────────────────────

interface CostSummaryGroup {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  callCount: number;
}

interface CostTrendBucket {
  bucket: string;
  costUsd: number;
  callCount: number;
}

interface CostSummary {
  totalCostUsd: number;
  callCount: number;
  topModel?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  unpricedCallCount: number;
  unpricedTokens: number;
  groups: CostSummaryGroup[];
  trend: CostTrendBucket[];
  trendStacked?: Array<{ bucket: string } & Record<string, number>>;
  trendStackKeys?: string[];
  /** The configured absolute daily spend limit in USD. 0 = disabled. */
  thresholdUsd?: number;
}

interface CostDetailCall {
  callId: string;
  source: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  priced: number;
  createdAt: number;
  taskId?: string;
  sessionId?: string;
  messageId?: string;
}

type GroupBy = "model" | "role" | "source" | "date";
type Granularity = "day" | "week" | "month";
type RangePreset = "today" | "7d" | "30d" | "custom";
type TrendMode = "total" | "source" | "model";

/** Minutes east of UTC for the viewer's local timezone (UTC+8 → 480) — drives local-day bucketing. */
const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset();

/** Stable color palette for stacked trend areas. */
const STACK_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#84cc16", "#ec4899"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUsd(value: number): string {
  if (value < 0.0001) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function rangeMs(preset: RangePreset, customFrom?: number, customTo?: number): { from: number; to: number } {
  const now = Date.now();
  if (preset === "today") {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return { from: midnight.getTime(), to: now };
  }
  if (preset === "7d") return { from: now - 7 * 86_400_000, to: now };
  if (preset === "30d") return { from: now - 30 * 86_400_000, to: now };
  return { from: customFrom ?? now - 86_400_000, to: customTo ?? now };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Cost() {
  const roles = useAppStore((s) => s.roles);
  const fetchRoles = useAppStore((s) => s.fetchRoles);

  const [preset, setPreset] = useState<RangePreset>("7d");
  const [customFrom, setCustomFrom] = useState<string>(""); // YYYY-MM-DD
  const [customTo, setCustomTo] = useState<string>("");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const [trendMode, setTrendMode] = useState<TrendMode>("total");
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [drillData, setDrillData] = useState<Record<string, CostDetailCall[]>>({});
  const [drillLoading, setDrillLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void fetchRoles();
  }, [fetchRoles]);

  // Resolve custom date strings (local-midnight start → next-local-midnight end) when preset=custom.
  const customMs =
    preset === "custom"
      ? {
          from: customFrom ? new Date(`${customFrom}T00:00:00`).getTime() : Date.now() - 7 * 86_400_000,
          to: customTo ? new Date(`${customTo}T23:59:59.999`).getTime() : Date.now(),
        }
      : undefined;
  const { from, to } = rangeMs(preset, customMs?.from, customMs?.to);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setExpandedRow(null);
    try {
      const data = await getCostSummary({
        from,
        to,
        groupBy,
        granularity,
        tzOffsetMinutes: TZ_OFFSET_MINUTES,
        ...(trendMode !== "total" ? { trendStackBy: trendMode } : {}),
      });
      setSummary(data);
    } catch {
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, groupBy, granularity, trendMode]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const getRoleLabel = (key: string): string => {
    if (key === "system") return "System / non-role";
    return roles.find((r) => r.id === key)?.name ?? key.slice(0, 8);
  };

  const getGroupLabel = (key: string): string => {
    if (groupBy === "role") return getRoleLabel(key);
    return key;
  };

  const handleRowClick = async (key: string) => {
    if (expandedRow === key) {
      setExpandedRow(null);
      return;
    }
    setExpandedRow(key);
    if (drillData[key]) return;
    setDrillLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const calls = await getCostDetail({ groupBy, groupKey: key, from, to, tzOffsetMinutes: TZ_OFFSET_MINUTES });
      setDrillData((prev) => ({ ...prev, [key]: calls }));
    } catch {
      setDrillData((prev) => ({ ...prev, [key]: [] }));
    } finally {
      setDrillLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const hasData = summary && (summary.callCount > 0 || summary.groups.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Cost"
        title="Platform Spend"
        compact
        description="LLM cost breakdown by model, role, source, and date."
        metrics={[
          { label: "Total", value: summary ? formatUsd(summary.totalCostUsd) : "—" },
          { label: "Calls", value: summary?.callCount ?? "—" },
          { label: "Top Model", value: summary?.topModel ?? "—" },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {(["today", "7d", "30d", "custom"] as RangePreset[]).map((p) => (
              <button
                key={p}
                className={`rounded px-2 py-1 text-xs ${preset === p ? "bg-[var(--app-accent)] text-white" : "border border-[var(--app-border)] text-[var(--app-text-subtle)] hover:border-[var(--app-accent)]"}`}
                onClick={() => setPreset(p)}
              >
                {p === "today" ? "Today" : p === "7d" ? "7 days" : p === "30d" ? "30 days" : "Custom"}
              </button>
            ))}
            {preset === "custom" && (
              <>
                <input
                  type="date"
                  aria-label="From date"
                  className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
                <span className="text-xs text-[var(--app-text-subtle)]">→</span>
                <input
                  type="date"
                  aria-label="To date"
                  className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </>
            )}
            <select
              className="rounded border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
            >
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
            <Button variant="ghost" size="sm" onClick={() => void loadSummary()}>
              <RefreshCw size={14} />
            </Button>
          </div>
        }
      />

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {(() => {
            const overLimit =
              (summary.thresholdUsd ?? 0) > 0 &&
              preset === "today" &&
              summary.totalCostUsd > (summary.thresholdUsd ?? 0);
            return (
              <Card className="p-3">
                <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">Total Spend</p>
                <p className={`mt-1 text-2xl font-semibold ${overLimit ? "text-[var(--app-danger)]" : "text-[var(--app-text)]"}`}>
                  {formatUsd(summary.totalCostUsd)}
                </p>
                {overLimit && (
                  <Badge variant="destructive" className="mt-1 text-[10px]">
                    over ${(summary.thresholdUsd ?? 0).toFixed(2)} limit
                  </Badge>
                )}
                {summary.unpricedCallCount > 0 && (
                  <Badge variant="warning" className="mt-1 text-[10px]">
                    {summary.unpricedCallCount} call{summary.unpricedCallCount !== 1 ? "s" : ""} unpriced — cost unknown
                  </Badge>
                )}
              </Card>
            );
          })()}
          <Card className="p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">Input Tokens</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{formatTokens(summary.tokens.input)}</p>
          </Card>
          <Card className="p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">Output Tokens</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{formatTokens(summary.tokens.output)}</p>
          </Card>
          <Card className="p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">Cache Read</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{formatTokens(summary.tokens.cacheRead)}</p>
          </Card>
          <Card className="p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">Cache Creation</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{formatTokens(summary.tokens.cacheCreation)}</p>
          </Card>
          <Card className="p-3">
            <p className="text-[10px] uppercase tracking-wide text-[var(--app-text-subtle)]">LLM Calls</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--app-text)]">{summary.callCount}</p>
            {summary.topModel && (
              <p className="mt-0.5 truncate text-[10px] text-[var(--app-text-subtle)]">{summary.topModel}</p>
            )}
          </Card>
        </div>
      )}

      {/* Trend chart */}
      {hasData && summary && summary.trend.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <p className="text-xs font-medium text-[var(--app-text-muted)]">Spend Over Time</p>
            <div className="ml-auto flex items-center gap-1">
              {([
                ["total", "Total"],
                ["source", "By source"],
                ["model", "By model"],
              ] as Array<[TrendMode, string]>).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`rounded px-2 py-0.5 text-[11px] ${trendMode === mode ? "bg-[var(--app-accent)] text-white" : "border border-[var(--app-border)] text-[var(--app-text-subtle)] hover:border-[var(--app-accent)]"}`}
                  onClick={() => setTrendMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            {trendMode === "total" || !summary.trendStacked || !summary.trendStackKeys ? (
              <LineChart data={summary.trend} margin={{ top: 4, right: 12, left: -10, bottom: 4 }}>
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
                <Tooltip formatter={(value) => [formatUsd(Number(value)), "Cost"]} contentStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="costUsd" stroke="var(--app-accent)" strokeWidth={2} dot={false} />
              </LineChart>
            ) : (
              <AreaChart data={summary.trendStacked} margin={{ top: 4, right: 12, left: -10, bottom: 4 }}>
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v.toFixed(3)}`} />
                <Tooltip formatter={(value, name) => [formatUsd(Number(value)), String(name)]} contentStyle={{ fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {summary.trendStackKeys.map((key, i) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stackId="1"
                    stroke={STACK_COLORS[i % STACK_COLORS.length]}
                    fill={STACK_COLORS[i % STACK_COLORS.length]}
                    fillOpacity={0.6}
                  />
                ))}
              </AreaChart>
            )}
          </ResponsiveContainer>
        </Card>
      )}

      {/* Group-by table */}
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <p className="text-xs font-medium text-[var(--app-text-muted)]">Breakdown by</p>
          {(["model", "role", "source", "date"] as GroupBy[]).map((g) => (
            <button
              key={g}
              className={`rounded px-2 py-0.5 text-xs ${groupBy === g ? "bg-[var(--app-accent)] text-white" : "border border-[var(--app-border)] text-[var(--app-text-subtle)] hover:border-[var(--app-accent)]"}`}
              onClick={() => { setGroupBy(g); setExpandedRow(null); }}
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
          </div>
        ) : !hasData ? (
          <EmptyState
            icon={<CircleDollarSign size={32} />}
            title="No cost in this window"
            description="No LLM calls recorded for the selected range. Pre-release history was backfilled from task runs (source=task only); chat and evaluation costs are tracked going forward."
            className="py-8"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--app-border)] text-left text-[var(--app-text-subtle)]">
                  <th className="pb-2 pr-3 font-medium">
                    {groupBy.charAt(0).toUpperCase() + groupBy.slice(1)}
                  </th>
                  <th className="pb-2 pr-3 font-medium">Cost</th>
                  <th className="pb-2 pr-3 font-medium">Calls</th>
                  <th className="pb-2 pr-3 font-medium">Input</th>
                  <th className="pb-2 font-medium">Output</th>
                </tr>
              </thead>
              <tbody>
                {summary!.groups.map((row) => (
                  <>
                    <tr
                      key={row.key}
                      className="cursor-pointer border-b border-[var(--app-border)] hover:bg-[var(--app-canvas)]"
                      onClick={() => void handleRowClick(row.key)}
                    >
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1">
                          {expandedRow === row.key ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          <span className="font-medium text-[var(--app-text)]">{getGroupLabel(row.key)}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[var(--app-text)]">{formatUsd(row.costUsd)}</td>
                      <td className="py-2 pr-3 text-[var(--app-text-subtle)]">{row.callCount}</td>
                      <td className="py-2 pr-3 text-[var(--app-text-subtle)]">{formatTokens(row.inputTokens)}</td>
                      <td className="py-2 text-[var(--app-text-subtle)]">{formatTokens(row.outputTokens)}</td>
                    </tr>
                    {expandedRow === row.key && (
                      <tr key={`${row.key}-detail`} className="bg-[var(--app-canvas)]">
                        <td colSpan={5} className="px-4 py-3">
                          {drillLoading[row.key] ? (
                            <div className="flex items-center gap-2 text-[var(--app-text-subtle)]">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--app-border)] border-t-[var(--app-accent)]" />
                              <span>Loading…</span>
                            </div>
                          ) : !drillData[row.key] || drillData[row.key].length === 0 ? (
                            <p className="text-[var(--app-text-subtle)]">No calls in this window.</p>
                          ) : (
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-left text-[var(--app-text-subtle)]">
                                  <th className="pb-1 pr-3 font-medium">Call ID</th>
                                  <th className="pb-1 pr-3 font-medium">Model</th>
                                  <th className="pb-1 pr-3 font-medium">Source</th>
                                  <th className="pb-1 pr-3 font-medium">Cost</th>
                                  <th className="pb-1 pr-3 font-medium">Tokens In/Out</th>
                                  <th className="pb-1 font-medium">Priced</th>
                                </tr>
                              </thead>
                              <tbody>
                                {drillData[row.key].map((call) => (
                                  <tr key={call.callId} className="border-t border-[var(--app-border)]">
                                    <td className="py-1 pr-3 font-mono text-[var(--app-text-subtle)]">
                                      {call.callId.slice(0, 12)}…
                                    </td>
                                    <td className="py-1 pr-3 text-[var(--app-text)]">{call.model}</td>
                                    <td className="py-1 pr-3">
                                      <Badge variant="info">{call.source}</Badge>
                                    </td>
                                    <td className="py-1 pr-3 font-mono text-[var(--app-text)]">
                                      {formatUsd(call.costUsd)}
                                    </td>
                                    <td className="py-1 pr-3 text-[var(--app-text-subtle)]">
                                      {formatTokens(call.inputTokens)} / {formatTokens(call.outputTokens)}
                                    </td>
                                    <td className="py-1">
                                      {call.priced ? (
                                        <Badge variant="success">priced</Badge>
                                      ) : (
                                        <Badge variant="warning">unpriced</Badge>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
