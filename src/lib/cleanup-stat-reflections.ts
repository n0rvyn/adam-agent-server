import type Database from "better-sqlite3";

export const STAT_REFLECTION_PATTERNS = [
  "Reflection: Made % file modifications%",
  "Reflection: No significant patterns%",
] as const;

export const STAT_REFLECTION_EXACT = "Reflection: Total 50 significant events observed.";

export interface StatReflectionCount {
  total: number;
  byPattern: Record<string, number>;
  sample: Array<{ id: string; content: string; createdAt: number }>;
}

export function countStatReflections(db: Database.Database, sampleSize = 5): StatReflectionCount {
  const byPattern: Record<string, number> = {};
  let total = 0;

  for (const pattern of STAT_REFLECTION_PATTERNS) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE ?").get(pattern) as { n: number };
    byPattern[pattern] = row.n;
    total += row.n;
  }
  const exactRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = ?").get(STAT_REFLECTION_EXACT) as { n: number };
  byPattern[STAT_REFLECTION_EXACT] = exactRow.n;
  total += exactRow.n;

  const sample = db.prepare(
    `SELECT id, content, created_at AS createdAt FROM memories
     WHERE content LIKE ? OR content LIKE ? OR content = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(STAT_REFLECTION_PATTERNS[0], STAT_REFLECTION_PATTERNS[1], STAT_REFLECTION_EXACT, sampleSize) as Array<{ id: string; content: string; createdAt: number }>;

  return { total, byPattern, sample };
}

export function deleteStatReflections(db: Database.Database): number {
  const tx = db.transaction(() => {
    let deleted = 0;
    for (const pattern of STAT_REFLECTION_PATTERNS) {
      const r = db.prepare("DELETE FROM memories WHERE content LIKE ?").run(pattern);
      deleted += r.changes;
    }
    const r2 = db.prepare("DELETE FROM memories WHERE content = ?").run(STAT_REFLECTION_EXACT);
    deleted += r2.changes;
    return deleted;
  });
  return tx();
}
