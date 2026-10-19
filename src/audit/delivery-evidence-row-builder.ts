// Build a typed latestAttempt from a raw DB row.
// This module is intentionally isolated to break TypeScript's contextual typing chain
// that widens `unknown` to the caller's indexed-access return type.

type LatestAttemptTarget =
  | { type: "channel"; channelId: string; chatId?: string; platform?: string }
  | { type: "webhook"; webhookUrl: string }
  | undefined;

type LatestAttemptNonNull = {
  status: "pending" | "delivered" | "failed" | "expired";
  target: LatestAttemptTarget;
  messageType?: string;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
  queueDepth?: number;
  quotaResetHours?: number;
};

type LatestAttempt = LatestAttemptNonNull | null;

export function buildLatestAttemptFromRow(row: unknown): LatestAttempt {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = row as Record<string, any>;
  const target = r["target"];
  const attemptTarget: LatestAttemptTarget =
    target && typeof target === "object"
      ? target as LatestAttemptTarget
      : undefined;
  return {
    status: r["status"] as LatestAttemptNonNull["status"],
    target: attemptTarget,
    messageType: r["messageType"],
    error: r["error"],
    createdAt: r["createdAt"],
    deliveredAt: r["deliveredAt"],
    queueDepth: undefined,
    quotaResetHours: undefined,
  };
}

export function maybeBuildLatestAttempt(row: unknown): LatestAttempt {
  if (row == null) return null;
  return buildLatestAttemptFromRow(row);
}
