/**
 * Field-path utilities for TaskTemplate details (Phase 0.5).
 *
 * `pickFieldByPath` walks a dot-separated path on a TaskTemplate detail
 * and returns the value at that path. Step-level paths like
 * "steps.<id>.prompt" look up the step by id first.
 *
 * Extracted from `src/manager/adam-tools.ts:785` to a shared module so
 * the template-versioning store (Phase 0.5 Task 3) and the adam-tools
 * runtime-effect/audit code can both reuse the same path-walking logic.
 *
 * NOTE: `collectTemplateUpdateFieldPaths` (adam-tools.ts:738) is NOT
 * shared — it consumes flat MCP arg keys (`args.prompt`/`args.stepId`),
 * which is a different shape than snapshot-vs-snapshot diff input. The
 * store layer has its own `diffTemplateVersions` for that.
 */

export function pickFieldByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return obj[path];
  const parts = path.split(".");
  let val: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    if (val === null || val === undefined || typeof val !== "object") return undefined;
    const part = parts[i]!;
    const record = val as Record<string, unknown>;
    // Handle steps array: look up by id
    if (Array.isArray(record.steps)) {
      const step = record.steps.find((s: Record<string, unknown>) => s.id === part);
      if (!step) return undefined;
      val = step;
    } else {
      val = record[part];
    }
  }
  return val;
}
