import { useState, type FormEvent } from "react";
import { setStoredApiKey, verifyApiKey } from "@/lib/api.ts";

export function Login() {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const returnTo = new URLSearchParams(window.location.search).get("returnTo") ?? "/ui";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError("API key is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const ok = await verifyApiKey(trimmed);
      if (!ok) {
        setError("Invalid API key");
        setSubmitting(false);
        return;
      }
      setStoredApiKey(trimmed);
      window.location.href = returnTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--app-bg)] text-[var(--app-fg)]">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-8 shadow-lg"
      >
        <h1 className="mb-2 text-2xl font-semibold">Adam — Sign in</h1>
        <p className="mb-6 text-sm text-[var(--app-muted)]">
          Paste your API key to continue.
        </p>

        <label className="mb-1 block text-sm font-medium">API key</label>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="64-character hex string"
          className="mb-4 w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--app-accent)]"
          autoFocus
          disabled={submitting}
        />

        {error && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-[var(--app-accent)] px-4 py-2 font-medium text-[var(--app-accent-fg)] transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Verifying..." : "Sign in"}
        </button>

        <details className="mt-6 text-xs text-[var(--app-muted)]">
          <summary className="cursor-pointer select-none">Where do I find my API key?</summary>
          <div className="mt-2 space-y-1 leading-relaxed">
            <p>
              Adam generates a random API key on first boot and stores it at{" "}
              <code className="rounded bg-[var(--app-bg)] px-1">~/.adam/adam.key</code>.
            </p>
            <p>Local: <code className="rounded bg-[var(--app-bg)] px-1">cat ~/.adam/adam.key</code></p>
            <p>Remote (VPS): <code className="rounded bg-[var(--app-bg)] px-1">ssh &lt;host&gt; cat ~/.adam/adam.key</code></p>
            <p>Rotation resets all logged-in sessions. Do it from Settings → API Key.</p>
          </div>
        </details>
      </form>
    </div>
  );
}
