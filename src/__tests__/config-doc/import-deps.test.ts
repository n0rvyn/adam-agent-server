/**
 * Tests for `checkImportDependencies` in src/store/config-doc/import-deps.ts.
 *
 * The gate is a deterministic code-side check that runs BEFORE building
 * anything. It refuses to proceed when a required plugin or skill (declared
 * in a config-doc's header dependency manifest) is absent from the live
 * installed set. mcpServer deps are surfaced as warnings (the config is
 * placeholder-bound, not auto-installed).
 *
 * Tests pin:
 *  - `kind:"plugin"` not in installed plugin ids → `missing`
 *  - `kind:"skill"` not in the union of installed plugins' manifest skills → `missing`
 *  - `kind:"mcpServer"` → `warnings` (not a hard refusal)
 *  - all present → `{ok: true, missing: [], warnings: []}`
 *  - registry read failure → treated as missing (fail-closed)
 *  - `missing[]` entries preserve `{pluginId, kind, source}` for the refusal message
 *  - empty deps → `{ok: true, missing: [], warnings: []}`
 *
 * The function under test accepts the installed set as an injected param
 * (the default reads `listInstalledPlugins()` + `getPluginManifest` per
 * plugin from `plugin-registry.js`). Tests inject a fake set so the gate
 * is exercised in isolation from the host's installed plugins.
 */
import { describe, it, expect, vi } from "vitest";

import {
  checkImportDependencies,
  type InstalledPluginSnapshot,
  type ManifestSkillEntry,
} from "../../store/config-doc/import-deps.js";
import type { DependencyEntry } from "../../store/config-doc/types.js";

/**
 * Build a fake `InstalledPluginSnapshot` for a list of plugin ids + their
 * skill names (the manifest is mocked by `getPluginManifest`).
 */
function makeInstalled(
  plugins: Array<{ id: string; skills?: ManifestSkillEntry[] }>,
): InstalledPluginSnapshot {
  return {
    pluginIds: plugins.map((p) => p.id),
    skillsByPlugin: new Map(plugins.map((p) => [p.id, p.skills ?? []])),
  };
}

describe("checkImportDependencies — happy path", () => {
  it("empty deps → ok: true, missing: [], warnings: []", () => {
    const installed = makeInstalled([{ id: "synth@personal-os", skills: [{ name: "synth-auto" }] }]);
    const result = checkImportDependencies([], installed);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("all declared plugin + skill deps are present → ok: true", () => {
    const installed = makeInstalled([
      { id: "synth@personal-os", skills: [{ name: "synth-auto" }] },
      { id: "getnote@personal-os", skills: [{ name: "getnote" }] },
      { id: "wechat@personal-os", skills: [{ name: "wechat-send" }] },
    ]);
    const deps: DependencyEntry[] = [
      { pluginId: "synth@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "getnote@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "synth-auto", source: "personal-os", kind: "skill" },
      { pluginId: "getnote", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkImportDependencies — failure modes", () => {
  it("kind:'plugin' not in installed ids → missing entry with full provenance", () => {
    const installed = makeInstalled([{ id: "getnote@personal-os" }]);
    const deps: DependencyEntry[] = [
      { pluginId: "synth@personal-os", source: "personal-os", kind: "plugin" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      { pluginId: "synth@personal-os", kind: "plugin", source: "personal-os" },
    ]);
  });

  it("kind:'skill' not in any installed plugin's manifest skills → missing", () => {
    const installed = makeInstalled([
      { id: "synth@personal-os", skills: [{ name: "synth-auto" }] },
    ]);
    const deps: DependencyEntry[] = [
      { pluginId: "getnote", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      { pluginId: "getnote", kind: "skill", source: "personal-os" },
    ]);
  });

  it("a plugin id is present but a sibling manifest skill is absent → missing", () => {
    // The plugin exists, but its manifest declares only `synth-auto` — the
    // declared skill `wechat-send` is NOT in the union → missing.
    const installed = makeInstalled([
      { id: "synth@personal-os", skills: [{ name: "synth-auto" }] },
    ]);
    const deps: DependencyEntry[] = [
      { pluginId: "wechat-send", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toEqual({
      pluginId: "wechat-send",
      kind: "skill",
      source: "personal-os",
    });
  });

  it("kind:'mcpServer' → warnings (not missing, not a hard refusal)", () => {
    const installed = makeInstalled([]);
    const deps: DependencyEntry[] = [
      { pluginId: "minimax-search@personal-os", source: "personal-os", kind: "mcpServer" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([
      { pluginId: "minimax-search@personal-os", kind: "mcpServer", source: "personal-os" },
    ]);
  });

  it("mixed deps: one plugin missing + one mcpServer → not ok, missing has the plugin, warnings has the mcpServer", () => {
    const installed = makeInstalled([{ id: "synth@personal-os", skills: [{ name: "synth-auto" }] }]);
    const deps: DependencyEntry[] = [
      { pluginId: "synth@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "minimax-search@personal-os", source: "personal-os", kind: "mcpServer" },
      { pluginId: "missing-plugin@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "synth-auto", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.pluginId)).toEqual(["missing-plugin@personal-os"]);
    expect(result.warnings.map((w) => w.pluginId)).toEqual(["minimax-search@personal-os"]);
  });
});

describe("checkImportDependencies — fail-closed on registry read failure", () => {
  // Production registry-failure path: `loadInstalledSnapshot()` (which reads
  // listInstalledPlugins() + getPluginManifest) THROWS on an unreadable
  // registry; the adam-tools `check_config_doc_dependencies` wrapper catches
  // that throw and returns a structured error (refuses the import). The two
  // tests below cover the two degraded snapshots `checkImportDependencies`
  // itself can receive: (1) an empty snapshot (registry returned nothing) and
  // (2) a snapshot whose accessor throws (defensive in-function guard).

  it("an EMPTY installed snapshot treats every plugin/skill dep as missing", () => {
    const emptySnapshot: InstalledPluginSnapshot = {
      pluginIds: [],
      skillsByPlugin: new Map(),
    };
    const deps: DependencyEntry[] = [
      { pluginId: "synth@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "synth-auto", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, emptySnapshot);
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.pluginId).sort()).toEqual([
      "synth-auto",
      "synth@personal-os",
    ]);
  });

  it("a thrown accessor (registry unavailable) is treated as a missing dep", () => {
    // Inject a snapshot accessor that throws. The gate must catch and treat
    // every dep as missing (fail-closed per threat model: lookup error ≠
    // allow-through). This exercises the defensive in-function catch; the
    // production throw originates in loadInstalledSnapshot (see note above).
    const throwingSnapshot: InstalledPluginSnapshot = {
      pluginIds: [],
      skillsByPlugin: new Proxy(new Map(), {
        get(target, prop) {
          if (prop === "get") {
            return () => {
              throw new Error("installed_plugins.json unreadable");
            };
          }
          return Reflect.get(target as object, prop);
        },
      }) as Map<string, ManifestSkillEntry[]>,
    };
    const deps: DependencyEntry[] = [
      { pluginId: "synth@personal-os", source: "personal-os", kind: "plugin" },
      { pluginId: "synth-auto", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, throwingSnapshot);
    expect(result.ok).toBe(false);
    expect(result.missing.map((m) => m.pluginId)).toEqual([
      "synth@personal-os",
      "synth-auto",
    ]);
  });
});

describe("checkImportDependencies — skill union is exhaustive across plugins", () => {
  it("skill name found in ANY installed plugin's manifest satisfies the dep", () => {
    // getnote is registered under plugin A, but the declared skill name
    // is `getnote` and the manifest for plugin A exposes it → satisfied.
    const installed = makeInstalled([
      { id: "kb-tools@personal-os", skills: [{ name: "getnote" }, { name: "search" }] },
      { id: "tts-tools@personal-os", skills: [{ name: "synth-auto" }] },
    ]);
    const deps: DependencyEntry[] = [
      { pluginId: "getnote", source: "personal-os", kind: "skill" },
      { pluginId: "synth-auto", source: "personal-os", kind: "skill" },
    ];
    const result = checkImportDependencies(deps, installed);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});

// Smoke: the function lives where the plan says it does
describe("import-deps module location", () => {
  it("checkImportDependencies is exported from src/store/config-doc/import-deps.ts", async () => {
    const mod = await import("../../store/config-doc/import-deps.js");
    expect(typeof mod.checkImportDependencies).toBe("function");
  });
});
