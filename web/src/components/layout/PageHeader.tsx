import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageMetric {
  label: string;
  value: ReactNode;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  metrics?: PageMetric[];
  actions?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  metrics,
  actions,
  compact = false,
  className,
}: PageHeaderProps) {
  return (
    <section
      className={cn(
        "surface-panel-elevated rounded-xl",
        compact ? "px-4 py-4 lg:px-5 lg:py-5" : "px-5 py-5 lg:px-6 lg:py-6",
        className,
      )}
    >
      <div className={cn("flex flex-col lg:flex-row lg:justify-between", compact ? "gap-3 lg:items-start" : "gap-4 lg:items-end")}>
        <div className={cn(compact ? "space-y-1.5" : "space-y-2")}>
          {eyebrow ? <p className="text-kicker">{eyebrow}</p> : null}
          <div className={cn(compact ? "space-y-0.5" : "space-y-1")}>
            <h1 className="text-title">{title}</h1>
            {description ? (
              <p
                className={cn(
                  "max-w-2xl text-sm text-[var(--app-text-muted)]",
                  compact ? "leading-5" : "leading-6",
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
          {metrics && metrics.length > 0 ? (
            <div className={cn("flex flex-wrap gap-x-4 gap-y-2 pt-1", compact ? "pt-0.5" : "pt-1")}>
              {metrics.map((metric) => (
                <div key={metric.label} className="space-y-0.5">
                  <span className="block text-[10px] uppercase tracking-[0.18em] text-[var(--app-text-subtle)]">
                    {metric.label}
                  </span>
                  <span className="text-sm font-medium text-[var(--app-text)]">{metric.value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">{actions}</div>
        ) : null}
      </div>
    </section>
  );
}
