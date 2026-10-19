import { api, getStoredApiKey } from "@/lib/api.ts";
import type { Artifact, DeliveryLogEntry } from "@/lib/types.ts";

// ─── Filter & pagination ──────────────────────────────────────────────────────

export interface ArtifactFilter {
  source_kind?: "template_step" | "task_published" | "chat_sent";
  mime_prefix?: string;
  role_id?: string;
  task_id?: string;
  execution_id?: string;
  chat_session_id?: string;
  delivery_status?: "delivered" | "pending" | "failed" | "expired";
  from?: number; // unix ms
  to?: number;
  limit?: number;
  offset?: number;
}

export interface ArtifactListResponse {
  artifacts: Artifact[];
  total: number;
}

export interface ArtifactDetailResponse {
  artifact: Artifact;
  deliveryLog: DeliveryLogEntry[];
}

// ─── API functions ────────────────────────────────────────────────────────────

export async function listArtifacts(filter: ArtifactFilter = {}): Promise<ArtifactListResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return api<ArtifactListResponse>(`/artifacts${qs ? `?${qs}` : ""}`);
}

export async function getArtifact(id: string): Promise<ArtifactDetailResponse> {
  return api<ArtifactDetailResponse>(`/artifacts/${id}`);
}

export async function deleteArtifact(id: string, confirm: boolean): Promise<void> {
  const qs = confirm ? "?confirm=true" : "";
  return api<void>(`/artifacts/${id}${qs}`, { method: "DELETE" });
}

export async function redeliverArtifact(
  id: string,
  opts: { channelId: string; chatId?: string },
): Promise<{ deliveryLogId: string; status: string }> {
  return api<{ deliveryLogId: string; status: string }>(`/artifacts/${id}/redeliver`, {
    method: "POST",
    body: JSON.stringify({ channelId: opts.channelId, ...(opts.chatId ? { chatId: opts.chatId } : {}) }),
  });
}

/**
 * Programmatic blob download — attaches x-api-key header (native <a download> cannot).
 * Creates a temporary object URL, triggers a click, then revokes the URL.
 */
export async function downloadArtifactBlob(id: string, filename: string): Promise<void> {
  const apiKey = getStoredApiKey();
  const response = await fetch(`/artifacts/${id}/blob`, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Canonical blob URL for use in <audio> / <img> src attributes (uses api_key query param). */
export function artifactBlobUrl(id: string): string {
  const apiKey = getStoredApiKey();
  return `/artifacts/${id}/blob${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ""}`;
}
