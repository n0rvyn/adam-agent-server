/**
 * Pure pricing module: per-model SDK usage + price table → recomputed cost.
 *
 * No I/O, no config import — caller passes the table.
 * No baseUrl/name-pattern normalization: exact-string key match only.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** USD per 1M tokens. estimated=true ⇒ looked-up default, not operator-confirmed. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  estimated?: boolean;
}

export type PriceTable = Record<string, ModelPrice>;

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD?: number;
}

export interface PerModelCost {
  model: string;
  priced: boolean;
  estimated: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export type PricingStatus = "priced" | "partial" | "unknown" | "none";

export interface CostRecompute {
  costUsd: number;
  perModel: PerModelCost[];
  pricingStatus: PricingStatus;
  unknownModels: string[];
  sdkTotalCostUsd?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a possibly-undefined/NaN token count to a safe integer 0. */
function safeTokens(value: number | undefined | null): number {
  if (value == null || !isFinite(value) || isNaN(value)) return 0;
  return value;
}

// ─── recomputeCost ────────────────────────────────────────────────────────────

/**
 * Compute the total cost + per-model breakdown from a modelUsage map and a price table.
 *
 * Rules:
 *  - Exact-string key match against the table; no prefix/suffix normalization.
 *  - A key absent from the table → priced=false, cost=0, added to unknownModels.
 *  - `estimated` reflects the price entry's optional flag (default false).
 *  - Undefined/NaN token fields coerced to 0; no throw.
 */
export function recomputeCost(
  modelUsage: Record<string, ModelUsageEntry>,
  table: PriceTable,
  sdkTotalCostUsd?: number,
): CostRecompute {
  const entries = Object.entries(modelUsage);

  if (entries.length === 0) {
    return {
      costUsd: 0,
      perModel: [],
      pricingStatus: "none",
      unknownModels: [],
      sdkTotalCostUsd,
    };
  }

  const perModel: PerModelCost[] = [];
  const unknownModels: string[] = [];
  let totalCostUsd = 0;
  let pricedCount = 0;

  for (const [model, usage] of entries) {
    const inputTokens = safeTokens(usage.inputTokens);
    const outputTokens = safeTokens(usage.outputTokens);
    const cacheReadTokens = safeTokens(usage.cacheReadInputTokens);
    const cacheCreationTokens = safeTokens(usage.cacheCreationInputTokens);

    const price = table[model];

    if (price !== undefined) {
      const cost =
        (inputTokens / 1e6) * price.input +
        (outputTokens / 1e6) * price.output +
        (cacheReadTokens / 1e6) * price.cacheRead +
        (cacheCreationTokens / 1e6) * price.cacheCreation;

      totalCostUsd += cost;
      pricedCount++;

      perModel.push({
        model,
        priced: true,
        estimated: price.estimated === true,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd: cost,
      });
    } else {
      unknownModels.push(model);

      perModel.push({
        model,
        priced: false,
        estimated: false,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd: 0,
      });
    }
  }

  let pricingStatus: PricingStatus;
  if (pricedCount === 0) {
    pricingStatus = "unknown";
  } else if (pricedCount === entries.length) {
    pricingStatus = "priced";
  } else {
    pricingStatus = "partial";
  }

  return {
    costUsd: totalCostUsd,
    perModel,
    pricingStatus,
    unknownModels,
    sdkTotalCostUsd,
  };
}

// ─── validatePriceTable ───────────────────────────────────────────────────────

const REQUIRED_NUMERIC_FIELDS = ["input", "output", "cacheRead", "cacheCreation"] as const;

/**
 * Validate the shape of a price table value.
 * Returns null if valid, or a precise error string naming model+field if invalid.
 */
export function validatePriceTable(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "pricing.models must be a plain object (not null, not an array).";
  }

  const obj = value as Record<string, unknown>;

  for (const [model, entry] of Object.entries(obj)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `pricing.models["${model}"] must be a plain object.`;
    }

    const entryObj = entry as Record<string, unknown>;

    for (const field of REQUIRED_NUMERIC_FIELDS) {
      const v = entryObj[field];
      if (typeof v !== "number" || !isFinite(v) || isNaN(v) || v < 0) {
        return `pricing.models["${model}"].${field} must be a finite non-negative number (got ${JSON.stringify(v)}).`;
      }
    }

    if ("estimated" in entryObj) {
      if (typeof entryObj.estimated !== "boolean") {
        return `pricing.models["${model}"].estimated must be a boolean if present (got ${JSON.stringify(entryObj.estimated)}).`;
      }
    }
  }

  return null;
}
