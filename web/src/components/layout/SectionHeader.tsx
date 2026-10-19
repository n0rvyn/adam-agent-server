import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function SectionHeader({ title, description, action, compact = false, className }: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:justify-between",
        compact ? "gap-2 sm:items-start" : "gap-3 sm:items-end",
        className,
      )}
    >
      <div className={cn(compact ? "space-y-0.5" : "space-y-1")}>
        <p className="text-section-label">{title}</p>
        {description ? (
          <p className={cn("text-sm text-[var(--app-text-muted)]", compact ? "leading-5" : "leading-6")}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
