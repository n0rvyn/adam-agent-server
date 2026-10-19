import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-[var(--app-panel-muted)] text-[var(--app-text)]",
        secondary: "bg-[var(--app-panel-elevated)] text-[var(--app-text-muted)]",
        destructive:
          "bg-[var(--app-danger-soft-bg)] text-[var(--app-danger)] border border-[var(--app-danger-soft-border)]",
        outline: "border border-[var(--app-border)] text-[var(--app-text)]",
        success:
          "bg-[var(--app-success-soft-bg)] text-[var(--app-success)] border border-[var(--app-success-soft-border)]",
        warning:
          "bg-[var(--app-warning-soft-bg)] text-[var(--app-warning)] border border-[var(--app-warning-soft-border)]",
        info: "bg-[var(--app-accent-soft-bg)] text-[var(--app-accent)] border border-[var(--app-accent-soft-border)]",
        muted: "bg-[var(--app-panel-elevated)] text-[var(--app-text-subtle)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning"
  | "info"
  | "muted";

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

/** Map a task/goal/worker status string to a Badge variant */
export function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case "blocked":
      return "warning";
    case "completed":
    case "ready":
    case "idle":
      return "success";
    case "running":
    case "busy":
    case "executing":
    case "planning":
    case "evaluating":
    case "replanning":
      return "info";
    case "pending":
    case "queued":
    case "paused":
    case "degraded":
      return "warning";
    case "failed":
    case "cancelled":
    case "dead":
    case "not_ready":
      return "destructive";
    default:
      return "muted";
  }
}

export { Badge, badgeVariants };
