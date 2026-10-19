/**
 * reflection-job.ts
 *
 * Watchdog-driven reflection cadence: every `intervalMinutes`, scan roles that
 * are stale (NULL or older than the interval), claim the slot, then run the
 * reflection pipeline sequentially.
 *
 * Slot-claim pattern: UPDATE last_reflection_at BEFORE await runReflectionForRole.
 * Two consecutive watchdog ticks (5-min apart) cannot both dispatch the same Role
 * because the first tick's UPDATE lands before the second tick's SELECT.
 */

import { getDb } from "../store/db.js";
import { runReflectionForRole } from "./reflection.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("manager");

export async function reflectionTick(intervalMinutes: number): Promise<string[]> {
  const db = getDb();
  const cutoff = Date.now() - intervalMinutes * 60_000;

  const roles = db
    .prepare(
      "SELECT id, last_reflection_at FROM roles WHERE last_reflection_at IS NULL OR last_reflection_at < ?"
    )
    .all(cutoff) as Array<{ id: string; last_reflection_at: number | null }>;

  const dispatched: string[] = [];

  for (const row of roles) {
    // Step 2a: claim the slot BEFORE invoking Haiku (concurrency guard)
    db.prepare("UPDATE roles SET last_reflection_at = ? WHERE id = ?").run(Date.now(), row.id);

    // Step 2b: run reflection
    try {
      await runReflectionForRole(row.id);
      dispatched.push(row.id);
    } catch (err) {
      // Slot stays claimed; the next cycle waits intervalMinutes before retrying.
      // This is the backoff mechanism per design spec.
      log.warn({ err, roleId: row.id }, "Reflection tick: role failed; slot remains claimed");
    }
  }

  return dispatched;
}
