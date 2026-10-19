import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "surface-panel-muted flex flex-col items-center justify-center rounded-xl text-center",
        compact ? "px-5 py-6" : "px-6 py-10",
        className,
      )}
    >
      {icon && <div className={cn("text-[var(--app-text-subtle)]", compact ? "mb-3" : "mb-4")}>{icon}</div>}
      <h3 className="text-base font-semibold text-[var(--app-text)]">{title}</h3>
      {description && (
        <p className={cn("max-w-md text-sm text-[var(--app-text-muted)]", compact ? "mt-1.5 leading-5" : "mt-2 leading-6")}>
          {description}
        </p>
      )}
      {action && <div className={cn(compact ? "mt-3" : "mt-4")}>{action}</div>}
    </div>
  );
}
