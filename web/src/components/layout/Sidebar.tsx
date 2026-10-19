import { NavLink } from "react-router-dom";
import { clsx } from "clsx";
import { navigationItems } from "@/lib/navigation.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/Tooltip.tsx";

interface SidebarProps {
  onNavigate?: () => void;
}

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <aside className="flex h-full w-64 flex-col border-r border-[var(--app-border)] bg-[var(--app-sidebar-bg)]">
      {/* Brand */}
      <div className="flex h-16 items-center gap-3 border-b border-[var(--app-border)] px-5">
        <div className="surface-accent flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white">
          A
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-wide text-[var(--app-text)]">Adam</div>
          <div className="text-[11px] text-[var(--app-text-subtle)]">Operator workspace</div>
        </div>
        <span className="ml-auto rounded-full border border-[var(--app-border)] bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-[var(--app-text-subtle)]">
          v2.0
        </span>
      </div>

      {/* Navigation */}
      <TooltipProvider delayDuration={300}>
        <nav role="navigation" aria-label="Main navigation" className="flex-1 space-y-1 px-3 py-4">
          {navigationItems.map(({ to, icon: Icon, label, description }) => (
            <Tooltip key={to}>
              <TooltipTrigger asChild>
                <NavLink
                  to={to}
                  end={to === "/"}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      "group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-canvas)]",
                      isActive
                        ? "surface-panel-elevated text-[var(--app-text)]"
                        : "text-[var(--app-text-muted)] hover:bg-white/[0.04] hover:text-[var(--app-text)]",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon size={16} className="flex-shrink-0" />
                      <span className="text-sm font-medium">{label}</span>
                      {isActive && <span className="sr-only">(current page)</span>}
                    </>
                  )}
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">
                <div className="space-y-0.5">
                  <div className="font-medium text-[var(--app-text)]">{label}</div>
                  <div className="text-[var(--app-text-muted)]">{description}</div>
                </div>
              </TooltipContent>
            </Tooltip>
          ))}
        </nav>
      </TooltipProvider>
    </aside>
  );
}
