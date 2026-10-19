import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Artifact } from "../../../store/artifacts.js";

export type { Artifact };

function getApiKey(): string {
  if (process.env.ADAM_API_KEY) return process.env.ADAM_API_KEY;
  const keyFile = join(homedir(), ".adam", "adam.key");
  if (existsSync(keyFile)) return readFileSync(keyFile, "utf8").trim();
  throw new Error("ADAM_API_KEY env or ~/.adam/adam.key required");
}

function getPort(): number {
  return Number(process.env.ADAM_PORT ?? 7100);
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "x-api-key": getApiKey(),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (options.body) {
    headers["Content-Type"] ??= "application/json";
  }
  const res = await fetch(`http://localhost:${getPort()}${path}`, { ...options, headers });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function listArtifacts(filter: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(
    Object.entries(filter).map(([k, v]) => [k, String(v)]),
  ).toString();
  return call<{ artifacts: Artifact[]; total: number }>(`/artifacts${qs ? "?" + qs : ""}`);
}

export function getArtifact(id: string) {
  return call<{ artifact: Artifact; deliveryLog: unknown[] }>(
    `/artifacts/${encodeURIComponent(id)}`,
  );
}

export function deleteArtifact(id: string, confirm = false) {
  return call<void>(
    `/artifacts/${encodeURIComponent(id)}${confirm ? "?confirm=true" : ""}`,
    { method: "DELETE" },
  );
}

export function redeliverArtifact(id: string, body: { channelId: string; chatId?: string }) {
  return call<{ deliveryLogId: string; status: "pending" | "rejected"; reason?: string }>(
    `/artifacts/${encodeURIComponent(id)}/redeliver`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
