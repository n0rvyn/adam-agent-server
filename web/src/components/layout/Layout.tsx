import { useEffect, useState, useCallback } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Menu, X, Wifi, WifiOff } from "lucide-react";
import { Sidebar } from "./Sidebar.tsx";
import { Toaster } from "@/components/ui/Toaster.tsx";
import { useAppStore } from "@/store/useAppStore.ts";
import { getRouteMeta } from "@/lib/navigation.ts";

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const wsConnected = useAppStore((s) => s.wsConnected);
  const connectWebSocket = useAppStore((s) => s.connectWebSocket);
  const fetchReadiness = useAppStore((s) => s.fetchReadiness);
  const routeMeta = getRouteMeta(location.pathname);

  useEffect(() => {
    connectWebSocket();
    fetchReadiness();
    const interval = setInterval(fetchReadiness, 30_000);
    return () => clearInterval(interval);
  }, [connectWebSocket, fetchReadiness]);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Skip to content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--app-accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:outline-none"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={closeSidebar} />
          <div className="relative z-50 h-full w-60">
            <Sidebar onNavigate={closeSidebar} />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="border-b border-[var(--app-border)] bg-[var(--app-header-bg)] px-4 py-2.5 lg:px-6">
          <div className="flex items-center gap-3">
          <button
            className="text-[var(--app-text-subtle)] transition-colors hover:text-[var(--app-text)] lg:hidden"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? "Close menu" : "Open menu"}
          >
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>

            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--app-text-muted)]">
                <span className="text-[var(--app-text)]">{routeMeta.section}</span>
                <span className="mx-1.5 text-[var(--app-text-subtle)]">/</span>
                <span className="font-medium text-[var(--app-text)]">{routeMeta.title}</span>
              </p>
            </div>

            <div
              className="surface-panel-muted flex items-center gap-2 rounded-full px-3 py-1 text-xs"
              aria-live="polite"
            >
              {wsConnected ? (
                <>
                  <Wifi size={14} className="text-[var(--app-success)]" />
                  <span className="text-[var(--app-text)]">Connected</span>
                </>
              ) : (
                <>
                  <WifiOff size={14} className="text-[var(--app-danger)]" />
                  <span className="text-[var(--app-text)]">Disconnected</span>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main id="main-content" role="main" className="flex-1 overflow-y-auto p-4 lg:p-5">
          <Outlet />
        </main>
      </div>
      <Toaster position="bottom-center" />
    </div>
  );
}
