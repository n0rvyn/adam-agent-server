import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-[var(--app-text-muted)]">
      <span className="text-6xl font-bold text-[var(--app-text-subtle)]">404</span>
      <p className="text-lg">Page not found</p>
      <Link to="/" className="text-[var(--app-accent)] hover:text-[var(--app-accent)] underline">
        Back to Dashboard
      </Link>
    </div>
  );
}
