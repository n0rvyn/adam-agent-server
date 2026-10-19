import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";

interface WrapperProps {
  children: ReactNode;
}

/**
 * Creates a data router wrapper compatible with useBlocker and other data router hooks.
 */
function DataRouterWrapper({ children }: WrapperProps) {
  const router = createMemoryRouter(
    [{ path: "*", element: children }],
    { initialEntries: ["/"] },
  );
  return <RouterProvider router={router} />;
}

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  preloadedState?: Partial<ReturnType<typeof useAppStore.getState>>;
  /** Set false to skip the Router wrapper (e.g. when test provides its own MemoryRouter) */
  withRouter?: boolean;
}

function customRender(ui: ReactElement, options?: CustomRenderOptions): RenderResult {
  const { preloadedState, withRouter = true, ...rest } = options ?? {};

  // Only reset store state when preloadedState is explicitly provided
  if (preloadedState !== undefined) {
    useAppStore.setState({
      tasks: [],
      skills: [],
      goals: [],
      strategies: [],
      templates: [],
      readiness: null,
      stats: { activeTasks: 0, queuedTasks: 0, totalCostToday: 0 },
      logs: [],
      configVersion: 0,
      wsConnected: false,
      _ws: null,
      _wsReconnectDelay: 1000,
      roles: [],
      executionPool: { active: 0, max: 3, queued: 0 },
      ...preloadedState,
    });
  }

  if (withRouter) {
    return render(ui, { wrapper: DataRouterWrapper, ...rest });
  }
  return render(ui, rest);
}

// Re-export everything from testing-library
export * from "@testing-library/react";
export { customRender as render };
