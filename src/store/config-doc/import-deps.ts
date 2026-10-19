/**
 * Plugin/skill dependency gate for config-doc import.
 *
 * Deterministic code-side check that runs BEFORE building anything. It
 * refuses to proceed when a required plugin or skill (declared in a
 * config-doc's header dependency manifest) is absent from the live
 * installed set. mcpServer deps are surfaced as warnings (the config is
 * placeholder-bound, not auto-installed).
 *
 * Threat-model contract (per Phase 2 plan §Threat model):
 *  - Plugin gate cannot resolve a dependency → deny (treat as missing).
 *    Never allow-through on lookup error.
 *  - No version-range matching: ids/names are exact strings.
 *  - mcpServer deps are placeholder-bound in the doc; we surface them
 *    as warnings (not hard refusals).
 *
 * Skill-availability source: union over `listInstalledPlugins()` of
 * `getPluginManifest(installPath).skills[].name` (verified at
 * `plugin-registry.ts:188-203`). The gate does NOT consult
 * `getInstalledPlugin` (which does not surface skills).
 *
 * The function accepts the installed set as an injected `InstalledPluginSnapshot`
 * (production code calls `loadInstalledSnapshot()` which reads
 * `listInstalledPlugins()` + `getPluginManifest` from `plugin-registry.js`).
 * Tests inject a fake snapshot to exercise the gate in isolation.
 */
import {
  getPluginManifest,
  listInstalledPlugins,
} from "../plugin-registry.js";
import type { DependencyEntry, DependencyKind } from "./types.js";

/**
 * A single manifest skill entry, restricted to the fields the gate uses.
 * Mirrors the shape `getPluginManifest(installPath).skills[].name` from
 * `plugin-registry.ts`.
 */
export interface ManifestSkillEntry {
  name: string;
  description?: string;
}

/**
 * Snapshot of the installed plugin + skill universe. Built once per gate
 * call from `listInstalledPlugins()` + `getPluginManifest`. The function
 * under test accepts this as an injected param (fail-closed tests inject
 * a throwing snapshot to exercise the "registry unavailable" path).
 */
export interface InstalledPluginSnapshot {
  /** All installed plugin ids (full `name@marketplace` form). */
  pluginIds: string[];
  /** Per-plugin manifest skill list (only `name` is consulted by the gate). */
  skillsByPlugin: Map<string, ManifestSkillEntry[]>;
}

/**
 * A single missing/required dependency, carrying enough provenance for
 * the refusal message.
 */
export interface DependencyGap {
  pluginId: string;
  kind: DependencyKind;
  source: string;
}

/**
 * Result of the gate. `ok: true` only if every plugin/skill dep is
 * present; mcpServer deps become warnings regardless.
 */
export interface DependencyCheckResult {
  ok: boolean;
  missing: DependencyGap[];
  warnings: DependencyGap[];
}

/**
 * Partition the declared deps and check each one against the installed
 * snapshot. Plugin + skill deps are hard requirements (a miss makes
 * `ok: false`). mcpServer deps are warnings (placeholder-bound in the
 * doc, not auto-installed).
 *
 * Fail-closed: if reading the installed set throws, every dep is
 * reported as missing (the import path must not proceed when the host's
 * plugin state is unreadable).
 */
export function checkImportDependencies(
  deps: DependencyEntry[],
  installed: InstalledPluginSnapshot,
): DependencyCheckResult {
  const missing: DependencyGap[] = [];
  const warnings: DependencyGap[] = [];

  // Pre-compute the union of available skill names. A skill name on any
  // installed plugin's manifest satisfies the dep.
  let availableSkills: Set<string>;
  try {
    availableSkills = new Set<string>();
    for (const skills of installed.skillsByPlugin.values()) {
      for (const s of skills ?? []) {
        if (s?.name) availableSkills.add(s.name);
      }
    }
  } catch {
    // Registry read failure → fail-closed. We mark all plugin/skill deps
    // as missing; mcpServer deps are still treated as warnings (they do
    // not require registry access to evaluate).
    availableSkills = new Set<string>();
    installed = { ...installed, pluginIds: [] };
  }

  for (const dep of deps) {
    const gap: DependencyGap = {
      pluginId: dep.pluginId,
      kind: dep.kind,
      source: dep.source,
    };
    if (dep.kind === "mcpServer") {
      // mcpServer deps are placeholder-bound → warning, never a refusal.
      warnings.push(gap);
      continue;
    }
    if (dep.kind === "plugin") {
      if (!installed.pluginIds.includes(dep.pluginId)) {
        missing.push(gap);
      }
      continue;
    }
    if (dep.kind === "skill") {
      if (!availableSkills.has(dep.pluginId)) {
        missing.push(gap);
      }
      continue;
    }
    // Unknown kind: treat as a missing entry to refuse the import.
    missing.push(gap);
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Build an `InstalledPluginSnapshot` from the live registry. The
 * production thin-wrapper in `adam-tools.ts` calls this before invoking
 * `checkImportDependencies`. Reads `listInstalledPlugins()` + per-plugin
 * `getPluginManifest(installPath).skills[].name`. Throws propagate to
 * the caller, which the gate then treats as a fail-closed missing-everything
 * outcome (see `checkImportDependencies` above).
 */
export function loadInstalledSnapshot(): InstalledPluginSnapshot {
  const installed = listInstalledPlugins();
  const skillsByPlugin = new Map<string, ManifestSkillEntry[]>();
  for (const p of installed) {
    const manifest = p.installPath ? getPluginManifest(p.installPath) : null;
    const skills = (manifest?.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
    }));
    skillsByPlugin.set(p.id, skills);
  }
  return {
    pluginIds: installed.map((p) => p.id),
    skillsByPlugin,
  };
}
