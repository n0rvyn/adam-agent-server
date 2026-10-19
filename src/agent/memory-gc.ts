/**
 * memory-gc.ts
 *
 * Daily memory GC: sweeps aged observation memories and archives decayed active beliefs.
 * Anti-pattern beliefs (is_anti = 1) are preserved regardless of status or effective_ema.
 *
 * Belief GC predicate (v3): active belief whose effective_ema < archiveThreshold (default 0.2).
 * effective_ema = success_ema × decayBase^(currentRoleTaskSeq − last_used_at_seq).
 * Beliefs are soft-archived (status='archived'), never hard-deleted.
 */

import { getDb } from "../store/db.js";
import { listBeliefsByRole } from "../store/beliefs.js";
import { getRoleTaskSeq } from "../store/roles.js";
import { checkArchiveThreshold, archiveBelief } from "./belief-mechanism.js";
import { getLogger } from "../lib/logger.js";

const log = getLogger("manager");

export interface MemoryGcConfig {
  observationTtlDays: number;
}

export interface MemoryGcReport {
  observationsDeleted: number;
  beliefsArchived: number;
}

/**
 * Run a single GC pass.
 *
 * Predicates:
 *  - Observations: `kind = 'observation' AND created_at < now - observationTtlDays`
 *  - Beliefs:     active, is_anti=0, effective_ema < archiveThreshold → soft archive
 *
 * Anti-pattern beliefs (is_anti = 1) are NEVER archived by this pass.
 */
export function memoryGcTick(cfg: MemoryGcConfig): MemoryGcReport {
  const db = getDb();
  const now = Date.now();
  const obsCutoff = now - cfg.observationTtlDays * 86_400_000;

  // Observation sweep: hard-delete old observation memories (unchanged from v2)
  const obsResult = db
    .prepare("DELETE FROM memories WHERE created_at < ? AND kind = 'observation'")
    .run(obsCutoff);
  const observationsDeleted = obsResult.changes;

  // Belief sweep: archive (soft-delete) actives crossing threshold.
  // v90: scan only kind='behavior' owners — predictions are part of the
  // belief-ledger pipeline, not role memory; their lifecycle is governed by
  // settle()/supersede, NOT by EMA decay.
  const allRoleIds = (
    db.prepare("SELECT DISTINCT role_id FROM beliefs WHERE status='active' AND kind='behavior'").all() as Array<{ role_id: string }>
  ).map(r => r.role_id);

  let beliefsArchived = 0;
  for (const rid of allRoleIds) {
    const currentSeq = getRoleTaskSeq(rid);
    const actives = listBeliefsByRole(rid, { onlyActive: true });
    for (const b of actives) {
      if (b.isAnti) continue; // anti-pattern beliefs are permanently protected
      if (checkArchiveThreshold(b, currentSeq)) {
        archiveBelief(b.id);
        beliefsArchived++;
      }
    }
  }

  db.prepare("UPDATE server_state SET last_memory_gc_at = ? WHERE id = 1").run(now);

  log.info(
    { observationsDeleted, beliefsArchived, obsCutoff },
    "Memory GC completed",
  );

  return { observationsDeleted, beliefsArchived };
}
