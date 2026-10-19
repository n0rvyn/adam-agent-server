import type { Task, TaskConfig } from "../shared/types.js";

const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key|pass$/i;
const SECRET_CONTAINER_PATTERN = /^(env|envVars|env_vars)$/i;

const PUBLIC_TASK_CONFIG_KEYS: Array<keyof TaskConfig | "outputContractCheckCount"> = [
  "allowedTools",
  "disallowedTools",
  "maxTurns",
  "maxBudgetUsd",
  "model",
  "effort",
  "settingSources",
  "workspacePath",
  "timeout",
  "approvalRequired",
  "approvalTimeout",
  "plugins",
  "outputContractCheckCount",
];

export function redactSecrets<T>(value: T): T {
  return redactValue(value, []) as T;
}

export function publicTaskView(task: Task): Omit<Task, "config"> & { config: Record<string, unknown> } {
  const redacted = task;
  return {
    ...redacted,
    config: publicTaskConfig(redacted.config),
  };
}

export function publicTaskConfig(config: TaskConfig): Record<string, unknown> {
  const publicConfig: Record<string, unknown> = {};
  const rawConfig = config as unknown as Record<string, unknown>;
  for (const key of PUBLIC_TASK_CONFIG_KEYS) {
    if (rawConfig[key] !== undefined) {
      publicConfig[key] = redactSecrets(rawConfig[key]);
    }
  }
  return publicConfig;
}

function redactValue(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, path));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (shouldRedactKey(key) || isInsideSecretContainer(childPath)) {
      output[key] = redactLeaf(child);
      continue;
    }
    output[key] = redactValue(child, childPath);
  }
  return output;
}

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isInsideSecretContainer(path: string[]): boolean {
  return path.slice(0, -1).some((part) => SECRET_CONTAINER_PATTERN.test(part));
}

function redactLeaf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLeaf);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      output[key] = REDACTED;
    }
    return output;
  }
  if (typeof value === "string" && value.length === 0) return "";
  if (value === undefined || value === null) return value;
  return REDACTED;
}
