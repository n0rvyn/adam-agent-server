/**
 * SkillRegistry -- unified queryable skill catalog aggregating skills from all sources.
 * Skill sources: plugin skills from Claude Code plugins, automator skills from
 * the seed function in Role workspaces, and user workspace skills from Role workspaces.
 */

import { listInstalledPlugins, getPluginManifest } from "../store/plugin-registry.js";
import { listRoles } from "../store/roles.js";
import { resolveRolePluginCapabilities } from "../lib/role-capabilities.js";
import { readRoleWorkspaceSkills } from "../lib/role-workspace-skills.js";
import type { ErrorCategory } from "../lib/error-classifier.js";
import { getDb } from "../store/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ErrorCategory } from "../lib/error-classifier.js";

export interface ErrorPattern {
  pattern: string;
  category: ErrorCategory;
  userAction: string;
}

export interface SkillHealth {
  totalTasks: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  commonErrors: Array<{ category: ErrorCategory; count: number }>;
}

export interface SkillEntry {
  name: string;
  description: string;
  source: "plugin" | "adam-automator" | "role-workspace";
  sourceName: string; // plugin name, "adam-automator", or role name
  /** Roles that have this skill bound (via plugin or workspace) */
  boundRoles: Array<{ roleId: string; roleName: string }>;
  /** Trigger keywords derived from skill name + description */
  triggers: string[];
  /** Known error patterns for this skill (from skill manifest or learned) */
  errorPatterns?: ErrorPattern[];
  /** Health metrics derived from role_scores + task records */
  health?: SkillHealth;
}

export interface SkillQuery {
  /** Free-text search across name, description, triggers */
  query?: string;
  /** Filter by role that has this skill */
  roleId?: string;
  /** Filter by source */
  source?: SkillEntry["source"];
}

// ---------------------------------------------------------------------------
// Keyword TF-IDF-like matching (DP-001: chosen A)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "must", "shall", "can", "need", "dare", "ought", "used",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
  "through", "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "when", "where", "why",
  "how", "all", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "also", "now", "and", "but", "or", "if", "because", "until",
  "while", "about", "against", "this", "that", "these", "those", "it", "its",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Compute a simple TF-IDF-like score: token overlap count. */
function matchScore(text: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const textTokens = tokenize(text);
  let score = 0;
  for (const qt of queryTokens) {
    if (textTokens.includes(qt)) score++;
    // Partial match: any text token that starts with the query token
    for (const tt of textTokens) {
      if (tt.startsWith(qt) && tt !== qt) score += 0.5;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Skill health — derived from role_scores + tasks
// ---------------------------------------------------------------------------

/**
 * Query role_scores + tasks to compute per-skill health metrics.
 * task_type column stores the skill name used when the task was scored.
 */
function computeSkillHealthMap(skillNames: string[]): Map<string, SkillHealth> {
  const db = getDb();
  const map = new Map<string, SkillHealth>();

  if (skillNames.length === 0) return map;

  const placeholders = skillNames.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT rs.task_type, rs.score_json, t.status, t.error_category, t.completed_at, rs.created_at
    FROM role_scores rs
    JOIN tasks t ON t.id = rs.task_id
    WHERE rs.task_type IN (${placeholders})
  `).all(...skillNames) as Array<{
    task_type: string;
    score_json: string;
    status: string;
    error_category: string | null;
    completed_at: number | null;
    created_at: number;
  }>;

  const statsMap = new Map<string, {
    successes: number;
    failures: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    errorCounts: Map<string, number>;
  }>();

  for (const row of rows) {
    const skillName = row.task_type;
    let stats = statsMap.get(skillName);
    if (!stats) {
      stats = { successes: 0, failures: 0, lastSuccessAt: null, lastFailureAt: null, errorCounts: new Map() };
      statsMap.set(skillName, stats);
    }

    const scores = JSON.parse(row.score_json) as { taskSuccess?: number };
    const isSuccess = row.status === "completed" || scores.taskSuccess === 1.0;

    if (isSuccess) {
      stats.successes++;
      if (row.completed_at) stats.lastSuccessAt = row.completed_at;
      else if (row.created_at) stats.lastSuccessAt = row.created_at;
    } else {
      stats.failures++;
      if (row.completed_at) stats.lastFailureAt = row.completed_at;
      if (row.error_category) {
        stats.errorCounts.set(row.error_category, (stats.errorCounts.get(row.error_category) ?? 0) + 1);
      }
    }
  }

  for (const [name, stats] of statsMap) {
    const total = stats.successes + stats.failures;
    const commonErrors = Array.from(stats.errorCounts.entries())
      .map(([category, count]) => ({ category: category as ErrorCategory, count }))
      .sort((a, b) => b.count - a.count);
    map.set(name, {
      totalTasks: total,
      successCount: stats.successes,
      failureCount: stats.failures,
      successRate: total > 0 ? stats.successes / total : 0,
      lastSuccessAt: stats.lastSuccessAt,
      lastFailureAt: stats.lastFailureAt,
      commonErrors,
    });
  }

  return map;
}

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

let _cachedRegistry: SkillEntry[] | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

export class SkillRegistry {
  /**
   * Build the full registry by aggregating all sources.
   * Results are cached for CACHE_TTL_MS to avoid repeated disk I/O.
   */
  static build(forceRefresh = false): SkillEntry[] {
    const now = Date.now();
    if (!forceRefresh && _cachedRegistry && (now - _cacheTime) < CACHE_TTL_MS) {
      return _cachedRegistry;
    }

    const entries: SkillEntry[] = [];

    // 1. Collect all active roles
    const roles = listRoles("active");
    const rolePluginCapabilities = new Map<string, ReturnType<typeof resolveRolePluginCapabilities>>();

    // 2. Plugin skills
    const plugins = listInstalledPlugins();
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const manifest = getPluginManifest(plugin.installPath);
      if (!manifest) continue;

      for (const skill of manifest.skills) {
        // Find roles that have this plugin bound
        const boundRoles: SkillEntry["boundRoles"] = [];
        for (const role of roles) {
          let caps = rolePluginCapabilities.get(role.id);
          if (!caps) {
            caps = resolveRolePluginCapabilities(role);
            rolePluginCapabilities.set(role.id, caps);
          }
          const hasPlugin = caps.plugins.some(
            (p) => p.name === plugin.name || p.name === plugin.id,
          );
          if (hasPlugin) {
            boundRoles.push({ roleId: role.id, roleName: role.name });
          }
        }

        const triggers = buildTriggers(skill.name, skill.description);
        entries.push({
          name: skill.name,
          description: skill.description,
          source: "plugin",
          sourceName: plugin.name ?? plugin.id,
          boundRoles,
          triggers,
          errorPatterns: skill.error_patterns?.map((ep) => ({
            pattern: ep.pattern,
            category: ep.category as ErrorCategory,
            userAction: ep.user_action,
          })),
        });
      }
    }

    // 3. Workspace skills (includes automator seeds plus user-created skills)
    for (const role of roles) {
      const workspaceSkills = readRoleWorkspaceSkills(role.id, role.name);
      for (const ws of workspaceSkills) {
        // Determine source type: automator vs user role-workspace
        const source: SkillEntry["source"] =
          role.name === "adam-automator" ? "adam-automator" : "role-workspace";

        // Check if this skill is already registered (from plugin scan)
        const existing = entries.find(
          (e) => e.name === ws.name && e.sourceName === ws.roleName,
        );
        if (existing) {
          // Merge bound role
          if (!existing.boundRoles.some((r) => r.roleId === role.id)) {
            existing.boundRoles.push({ roleId: role.id, roleName: role.name });
          }
        } else {
          const triggers = buildTriggers(ws.name, ws.description);
          entries.push({
            name: ws.name,
            description: ws.description,
            source,
            sourceName: ws.roleName,
            boundRoles: [{ roleId: role.id, roleName: role.name }],
            triggers,
          });
        }
      }
    }

    _cachedRegistry = entries;
    _cacheTime = now;

    // Populate health stats from role_scores + tasks
    const skillNames = entries.map((e) => e.name);
    const healthMap = computeSkillHealthMap(skillNames);
    for (const entry of entries) {
      const h = healthMap.get(entry.name);
      if (h) entry.health = h;
    }

    return entries;
  }

  /**
   * Query skills matching the given filters.
   * Text query uses token overlap scoring.
   */
  static query(q: SkillQuery): SkillEntry[] {
    const all = SkillRegistry.build();

    return all.filter((entry) => {
      if (q.source && entry.source !== q.source) return false;
      if (q.roleId && !entry.boundRoles.some((r) => r.roleId === q.roleId)) return false;
      if (q.query) {
        const queryTokens = tokenize(q.query);
        const nameScore = matchScore(entry.name, queryTokens);
        const descScore = matchScore(entry.description, queryTokens);
        const triggerScore = Math.max(
          ...entry.triggers.map((t) => matchScore(t, queryTokens)),
        );
        const total = nameScore + descScore + triggerScore;
        if (total === 0) return false;
      }
      return true;
    });
  }

  /**
   * Find the best skill(s) for a natural-language task description.
   * Returns skills ranked by TF-IDF-like overlap score, topK results.
   */
  static match(taskDescription: string, topK = 3): SkillEntry[] {
    const all = SkillRegistry.build();
    const queryTokens = tokenize(taskDescription);
    if (queryTokens.length === 0) return [];

    const scored = all
      .map((entry) => {
        const nameScore = matchScore(entry.name, queryTokens) * 2; // name matches weight more
        const descScore = matchScore(entry.description, queryTokens);
        const triggerScore = Math.max(
          ...entry.triggers.map((t) => matchScore(t, queryTokens) * 1.5),
        );
        return { entry, score: nameScore + descScore + triggerScore };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK).map((s) => s.entry);
  }

  /** Invalidate the cache so the next call rebuilds from disk. */
  static invalidateCache(): void {
    _cachedRegistry = null;
    _cacheTime = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTriggers(name: string, description: string): string[] {
  const triggers: string[] = [];
  // Extract words from name (split on underscores, hyphens)
  for (const word of name.split(/[_-]/)) {
    if (word.length > 2) triggers.push(word.toLowerCase());
  }
  // Keywords from description (first 200 chars, split into words)
  const descPreview = description.slice(0, 200).toLowerCase();
  for (const word of descPreview.split(/\W+/)) {
    if (word.length > 4) triggers.push(word);
  }
  // Remove duplicates
  return [...new Set(triggers)];
}
