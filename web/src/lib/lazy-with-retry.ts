import { lazy, type ComponentType } from "react";

/**
 * Wraps React.lazy() with automatic retry on chunk load failure.
 * When a dynamic import fails (stale hash after rebuild), reloads the page once.
 * Uses sessionStorage to prevent infinite reload loops.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((error: unknown) => {
      const key = "chunk-reload-" + window.location.pathname;
      const hasReloaded = sessionStorage.getItem(key);

      if (!hasReloaded) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
        // Return a never-resolving promise to prevent React from rendering
        // while the page is reloading
        return new Promise<{ default: T }>(() => {});
      }

      // Already reloaded once — clear flag and throw so ErrorBoundary catches it
      sessionStorage.removeItem(key);
      throw error;
    }),
  );
}
