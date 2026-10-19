# Authentication

Adam enforces API key authentication between the Web UI (and TUI, webhooks, WS clients) and the server. Auth is **always on** — there is no "insecure local" mode.

## Bootstrap

On first startup, the server:
1. Looks up `server.apiKey` from `config` DB table, `ADAM_API_KEY` env var, and `--api-key=` CLI flag. Env and flag override DB.
2. If all three are empty, generates a random 32-byte hex key (64 chars), persists it to the DB, and writes it to `~/.adam/adam.key` (mode 0600).
3. Prints to stdout (once per generation):
   ```
   [adam] Generated new API key → ~/.adam/adam.key
   [adam] Retrieve it with: cat ~/.adam/adam.key
   [adam] Web UI login: paste this value into the login page
   ```
4. In `NODE_ENV=development` with no `ADAM_API_KEY` env var, also appends `ADAM_API_KEY=<key>` to `./.env.local` so shell sessions (TUI clients, test runs) can pick it up automatically.

The key file is the canonical location. The TUI's `readApiKey()` (`src/cli/client.ts:13`) reads it. Webhook configurations on external platforms should use the same value.

## Retrieving the key

**Local machine:**
```bash
cat ~/.adam/adam.key
```

**VPS / remote server:**
```bash
ssh vps-host cat ~/.adam/adam.key
```

Or scroll back through the server log at first boot — the banner appears once.

## Web UI login flow

1. Visit `http://server:7100/ui` (or the dev proxy `http://localhost:5173`).
2. If `localStorage` has no `adam_api_key`, the app shows the login page.
3. Paste the key. The UI calls `GET /auth/verify` with the candidate key; a 200 response stores it in `localStorage` and redirects to the return URL.
4. 401 from any subsequent API call clears `localStorage.adam_api_key` and redirects back to `/ui/login`.

## Rotation

`POST /auth/rotate` generates a new key, persists it to DB + file, and hot-reloads the in-memory buffer. The old key becomes invalid immediately on the next request. Existing WebSocket connections stay up until the next reconnect, at which point the old key is rejected and the Web UI auto-redirects to login.

From the Web UI: `Settings → API Key → Rotate`. The new key is shown once with a Copy button.

From the CLI:
```bash
KEY=$(cat ~/.adam/adam.key)
curl -X POST -H "x-api-key: $KEY" http://localhost:7100/auth/rotate
```

**Rotation is blocked when `ADAM_API_KEY` env var is set.** The endpoint returns 409 `ROTATE_BLOCKED_BY_ENV`, because env overrides DB at startup and the rotated DB value would be replaced on next restart. Unset the env var (or remove it from `.env.local`) before rotating.

## External integrations

**Webhooks** (`POST /webhooks/:name`): third-party platforms calling these endpoints must send `x-api-key: <adam.key value>`. After rotation, reconfigure every external caller with the new key.

**Channel adapters** (WeChat, Telegram, Discord, etc.): these use their own platform credentials (botToken, session, etc.) stored in the `channels.config` column. Rotating the Adam API key does **NOT** affect channel adapters — they keep running, continue to long-poll their upstream, and continue to deliver inbound messages through the internal event bus. Rotation only matters to clients of Adam's own HTTP/WS endpoints.

**WebSocket clients**: browsers can't set headers for WS upgrade. The server accepts `?api_key=<key>` as a query-param fallback. The Web UI's stores (`useAppStore.ts`, `useChatStore.ts`) already use this pattern.

**Summary**: rotation breaks only (a) other browsers/TUI sessions (they reopen the login page), and (b) external HTTP callers of `/webhooks/:name`. Channel adapters and inbound channel message flow are unaffected.

## Deployment profiles

**Local machine** — default. Bind `server.host` to `127.0.0.1` or `0.0.0.0` depending on whether other devices on the LAN should reach Adam. Auth protects against casual LAN access.

**VPS** — the server should NOT be exposed to the public internet in plaintext. Recommended:
1. Put a TLS reverse proxy in front (Caddy, Nginx, Traefik).
2. Bind Adam to `127.0.0.1` so only the local reverse proxy can reach it.
3. If public webhook endpoints are needed (e.g., Slack/Telegram callbacks), proxy only `/webhooks/*` through the TLS reverse proxy; keep UI + `/events` + `/auth/*` on a private network (Tailscale, VPN) or at least password-protect at the proxy level.
4. Never commit `~/.adam/adam.key` or `.env.local` to git.

## File reference

| Path | Purpose |
|------|---------|
| `~/.adam/adam.key` | Canonical key file, mode 0600 |
| `~/.adam/adam.db` → `config` table, `server.apiKey` row | Persisted key value |
| `.env.local` (project root, dev only) | Shell-exportable `ADAM_API_KEY=` |
| `ADAM_API_KEY` env var | Overrides DB + file; blocks rotation |

## Endpoints

| Path | Auth | Notes |
|------|------|-------|
| `GET /healthz`, `GET /readyz` | skip | Liveness / readiness |
| `GET /docs/*` | skip | OpenAPI spec |
| `GET /ui/*` | skip | SPA static assets (login page must load without a key) |
| `GET /auth/verify` | required | Returns `{ok: true}` if key is valid |
| `POST /auth/rotate` | required | 200 with new key; 409 if env overrides DB |
| everything else | required | 401 on missing/invalid key |

## Threat notes

- `localStorage` storage for the key exposes it to XSS. Adam trusts its own bundle; do not install untrusted browser extensions on a device that has the key.
- Single key shared across UI, webhook, and WS clients. Rotating invalidates all of them at once — plan channel reconfiguration together with rotation.
- `~/.adam/adam.key` mode 0600 protects from other local users but not from root.
- There is no rate limiting on `/auth/verify`. For public-facing deployments, put rate limiting at the reverse proxy.
