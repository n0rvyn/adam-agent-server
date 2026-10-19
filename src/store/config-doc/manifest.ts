/**
 * Manifest builder.
 *
 * Builds three artifacts from a template set + its role closure:
 * 1. Dependency manifest — union of plugin/skill/mcpServer references from
 *    `template.config.plugins`, `step.requirements.plugins`, `role.skills`,
 *    and `role.mcpServers` keys. Deduped. Each entry carries the install
 *    source where resolvable (via `getInstalledPlugin`), or "unknown" when
 *    the plugin id is not in the registry (surfaced, never dropped).
 * 2. Placeholder manifest — one entry per env-specific field occurrence,
 *    with a stable name and the right `kind` (channel/model/path/secret/env).
 *    The renderer substitutes these into `${NAME}` tokens.
 * 3. Ledger owners — distinct non-undefined of the four step ledger fields
 *    across all steps in the export set.
 *
 * See `docs/02-architecture/config-doc-format.md` for the spec.
 */
import { getInstalledPlugin } from "../plugin-registry.js";
import type { TaskStep, TaskTemplate, Role } from "../../shared/types.js";
import type {
  DependencyEntry,
  DependencyKind,
  PlaceholderEntry,
  PlaceholderKind,
} from "./types.js";

// ---------------------------------------------------------------------------
// Dependency manifest
// ---------------------------------------------------------------------------

/**
 * Walk the union of plugin/skill/mcpServer references and return a deduped
 * list. Each plugin id is resolved via the plugin registry; unresolved ids
 * are recorded with `source: "unknown"`.
 */
export function buildDependencyManifest(
  templates: TaskTemplate[],
  roles: Role[],
): DependencyEntry[] {
  const seen = new Map<string, DependencyEntry>();
  const push = (id: string, kind: DependencyKind) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    let source = "unknown";
    if (kind === "plugin") {
      // Try to resolve a marketplace source via the plugin registry.
      const inst = getInstalledPlugin(id);
      if (inst) {
        // The install path encodes the marketplace; the first segment after
        // the plugins dir is the marketplace name. Fall back to the plugin
        // id when not parseable.
        const parts = inst.installPath.split("/").filter(Boolean);
        const pluginsIdx = parts.lastIndexOf("plugins");
        source = pluginsIdx >= 0 && parts[pluginsIdx + 1] ? parts[pluginsIdx + 1] : id;
      }
    } else {
      // Skills and mcpServers are not resolved via the registry here; the
      // renderer treats them as `source: "unknown"` by default. Callers can
      // post-process if they need richer resolution.
      source = "unknown";
    }
    seen.set(key, { pluginId: id, source, kind });
  };

  for (const t of templates) {
    const cfgPlugins = (t.config?.plugins ?? []) as string[];
    for (const id of cfgPlugins) push(id, "plugin");
    for (const step of t.steps) {
      const reqPlugins = (step.requirements?.plugins ?? []) as string[];
      for (const id of reqPlugins) push(id, "plugin");
    }
  }
  for (const role of roles) {
    // role.skills is `string[] | "all"`; portable inline "all" is NOT a plugin
    // reference and is omitted from the dependency manifest.
    if (Array.isArray(role.skills)) {
      for (const id of role.skills) push(id, "skill");
    }
    const mcpKeys = Object.keys(role.mcpServers ?? {});
    for (const id of mcpKeys) push(id, "mcpServer");
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Placeholder manifest
// ---------------------------------------------------------------------------

/**
 * Walk the env-specific fields of every template/role and emit a
 * `PlaceholderEntry` per occurrence with a stable name and `kind`.
 *
 * Stable-name rules:
 * - Channel: `CHANNEL_<n>` per occurrence (in the order encountered)
 * - Model: `MODEL_<roleId>`
 * - Path: `PATH_<roleId>_<i>`
 * - Secret: `SECRET_<roleId>_<mcpKey>`
 * - Env: `ENV_<scope>_<key>`
 *
 * The `boundField` is the dotted path so the renderer can substitute in
 * place during re-import.
 */
export function buildPlaceholderManifest(
  templates: TaskTemplate[],
  roles: Role[],
): PlaceholderEntry[] {
  const out: PlaceholderEntry[] = [];
  let channelCounter = 0;

  // Templates: deliverTo / reportTo
  for (const t of templates) {
    const allTargets: Array<{ list: "deliverTo" | "reportTo"; items: Array<{ type: "channel" | "session"; channelId?: string; chatId?: string; sessionId?: string }> }> = [];
    if (t.deliverTo) allTargets.push({ list: "deliverTo", items: t.deliverTo as Array<{ type: "channel" | "session"; channelId?: string; chatId?: string; sessionId?: string }> });
    if (t.reportTo) allTargets.push({ list: "reportTo", items: t.reportTo as Array<{ type: "channel" | "session"; channelId?: string; chatId?: string; sessionId?: string }> });
    for (const { list, items } of allTargets) {
      items.forEach((it, i) => {
        if (it.type === "channel") {
          if (it.channelId) {
            out.push({
              name: `CHANNEL_${channelCounter++}`,
              kind: "channel",
              boundField: `template.${t.id}.${list}[${i}].channelId`,
            });
          }
          if (it.chatId) {
            out.push({
              name: `CHANNEL_${channelCounter++}`,
              kind: "channel",
              boundField: `template.${t.id}.${list}[${i}].chatId`,
            });
          }
        } else if (it.type === "session" && it.sessionId) {
          out.push({
            name: `CHANNEL_${channelCounter++}`,
            kind: "channel",
            boundField: `template.${t.id}.${list}[${i}].sessionId`,
          });
        }
      });
    }
    // Template config env values
    const envObj = t.config?.env ?? {};
    for (const k of Object.keys(envObj)) {
      out.push({
        name: `ENV_template.${t.id}.config.env.${k}`,
        kind: "env",
        boundField: `template.${t.id}.config.env.${k}`,
      });
    }
    // Template config mcpServers values (credential-shaped — secret, symmetric
    // with role.mcpServers). Without this they would serialize wholesale via
    // canonicalize(config) and leak.
    const cfgMcp = (t.config?.mcpServers ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(cfgMcp)) {
      out.push({
        name: `SECRET_template.${t.id}.config.mcpServers.${k}`,
        kind: "secret",
        boundField: `template.${t.id}.config.mcpServers.${k}`,
      });
    }
  }

  // Roles: model, additionalDirectories, envVars, mcpServers
  for (const r of roles) {
    if (r.model) {
      out.push({
        name: `MODEL_${r.id}`,
        kind: "model",
        boundField: `role.${r.id}.model`,
      });
    }
    const dirs = r.additionalDirectories ?? [];
    dirs.forEach((d: { path?: string }, i: number) => {
      if (d?.path) {
        out.push({
          name: `PATH_${r.id}_${i}`,
          kind: "path",
          boundField: `role.${r.id}.additionalDirectories[${i}].path`,
        });
      }
    });
    const envVars = r.envVars ?? {};
    for (const k of Object.keys(envVars)) {
      out.push({
        name: `ENV_role.${r.id}.envVars.${k}`,
        kind: "env",
        boundField: `role.${r.id}.envVars.${k}`,
      });
    }
    const mcp = r.mcpServers ?? {};
    for (const k of Object.keys(mcp)) {
      out.push({
        name: `SECRET_${r.id}_${k}`,
        kind: "secret",
        boundField: `role.${r.id}.mcpServers.${k}`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Ledger owners
// ---------------------------------------------------------------------------

const LEDGER_FIELDS = [
  "settlementLedgerOwner",
  "publishesClaimsTo",
  "settlesPredictionsFor",
  "openLedgerOwner",
] as const satisfies Array<keyof TaskStep>;

/**
 * Distinct non-undefined values of the four step ledger fields across the
 * export set. Returned sorted for determinism.
 */
export function collectLedgerOwners(templates: TaskTemplate[]): string[] {
  const set = new Set<string>();
  for (const t of templates) {
    for (const step of t.steps) {
      for (const f of LEDGER_FIELDS) {
        const v = step[f];
        if (typeof v === "string" && v.length > 0) set.add(v);
      }
    }
  }
  return Array.from(set).sort();
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export type { DependencyEntry, PlaceholderEntry, DependencyKind, PlaceholderKind };
