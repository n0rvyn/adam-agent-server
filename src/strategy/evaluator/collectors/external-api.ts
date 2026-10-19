import { getLogger } from "../../../lib/logger.js";
import { DEFAULT_CONFIG } from "../../../config/defaults.js";
import type { ExternalApiEndpoint } from "../../../shared/types.js";

const log = getLogger("agent");

export interface ExternalApiScore {
  nodeId: string;
  score: number;
  source: string;
  fetchedAt: number;
}

export interface ExternalApiResult {
  scores: ExternalApiScore[];
  errors: string[];
}

/**
 * Collect scores from configured external API endpoints.
 * Fetches from each URL with a 5s timeout, parses numeric values from JSON responses.
 */
export async function collectExternalApiScores(goalId: string): Promise<ExternalApiResult> {
  const endpoints = tryGetExternalApis();
  if (endpoints.length === 0) {
    return { scores: [], errors: [] };
  }

  const scores: ExternalApiScore[] = [];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const score = await fetchExternalApiScore(endpoint);
      if (score !== null) {
        scores.push({ nodeId: goalId, score, source: endpoint.name, fetchedAt: Date.now() });
      }
    } catch (err) {
      errors.push(`External API "${endpoint.name}" (${endpoint.url}): ${err instanceof Error ? err.message : String(err)}`);
      log.warn({ endpoint: endpoint.name, error: err }, "External API fetch failed");
    }
  }

  return { scores, errors };
}

async function fetchExternalApiScore(endpoint: ExternalApiEndpoint): Promise<number | null> {
  const response = await fetch(endpoint.url, {
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as Record<string, unknown>;
  const score = getNestedValue(json, endpoint.scorePath);

  if (typeof score !== "number" || isNaN(score)) {
    throw new Error(`Score at "${endpoint.scorePath}" is not a number: ${JSON.stringify(score)}`);
  }

  return Math.max(0, Math.min(1, score));
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const cleanPath = path.replace(/^\$\.?/, "");
  let current: unknown = obj;
  for (const part of cleanPath.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function tryGetExternalApis(): ExternalApiEndpoint[] {
  return DEFAULT_CONFIG.externalApis ?? [];
}
