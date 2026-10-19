import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen items-center justify-center bg-[var(--app-canvas)] p-6">
          <div className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--app-danger)]/10">
              <svg
                className="h-6 w-6 text-[var(--app-danger)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h1 className="mb-2 text-lg font-semibold text-[var(--app-text)]">
              Something went wrong
            </h1>
            <p className="mb-6 text-sm text-[var(--app-text-muted)]">
              An unexpected error occurred. Try reloading the page.
            </p>
            {this.state.error && (
              <pre className="mb-6 max-h-32 overflow-auto rounded bg-[var(--app-canvas)] p-3 text-left text-xs text-[var(--app-danger)]">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[var(--app-canvas)]"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
