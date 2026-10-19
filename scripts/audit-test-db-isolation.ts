/**
 * Scanner: flags test files that import production store modules that touch
 * the DB (via `getDb()`) without proper isolation.
 *
 * A test file is considered isolated if ANY of these patterns hold:
 *   1. vi.mock("../../store/db.js") — the canonical global redirect
 *   2. `new Database(...)` — test owns its own SQLite instance
 *   3. Every imported DB-touching store module has its own
 *      `vi.mock("../../store/X.js")` that fully replaces it
 *
 * Pure-function store modules (validators, presets, plugin-registry that only
 * touch the filesystem, etc.) don't need isolation because importing them
 * doesn't trigger `getDb()`. The scanner discovers which modules touch the DB
 * by reading their source and grepping for `getDb`.
 *
 * Reports per-test violations as the unmocked DB-touching store modules.
 *
 * Exit codes:
 *   0 — all test files are isolated
 *   1 — violations found (see stderr output)
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = process.cwd();
const TESTS_ROOT = join(REPO_ROOT, "src/__tests__");
const STORE_ROOT = join(REPO_ROOT, "src/store");

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile() && e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

interface Violation {
  path: string;
  unmockedDbTouchingImports: string[];
}

function extractStoreModule(importLine: string): string | null {
  const m = importLine.match(/(?:\.\.\/)+store\/([a-z][\w-]+)(?:\.js)?/);
  return m ? m[1] : null;
}

/** Cache: store-module basename → does this module use getDb? */
const dbTouchCache = new Map<string, boolean>();

async function moduleTouchesDb(modBasename: string): Promise<boolean> {
  if (dbTouchCache.has(modBasename)) return dbTouchCache.get(modBasename)!;
  const sourcePath = join(STORE_ROOT, `${modBasename}.ts`);
  if (!existsSync(sourcePath)) {
    // Unknown module — treat as DB-touching to be safe
    dbTouchCache.set(modBasename, true);
    return true;
  }
  const content = await readFile(sourcePath, "utf-8");
  // Module touches DB if it calls getDb() OR re-exports it
  const touches = /\bgetDb\s*\(/.test(content) || /export\s+\{[^}]*\bgetDb\b/.test(content);
  dbTouchCache.set(modBasename, touches);
  return touches;
}

async function main() {
  const files = await walk(TESTS_ROOT);
  const violations: Violation[] = [];

  for (const fullPath of files) {
    const content = await readFile(fullPath, "utf-8");

    // Collect store imports — type-only imports are erased at runtime, so they don't load the module
    const allImportLines = content.match(/import\s+(?:type\s+)?(?:\{[^}]*\}|[A-Za-z_*$][\w$]*)(?:\s*,\s*\{[^}]*\})?\s+from\s+["'](?:\.\.\/)+store\/[a-z][\w-]+(?:\.js)?["']/g) ?? [];
    const importedStoreModules = new Set<string>();
    for (const line of allImportLines) {
      if (/^\s*import\s+type\s+/.test(line)) continue; // type-only imports are erased
      const mod = extractStoreModule(line);
      if (mod) importedStoreModules.add(mod);
    }
    if (importedStoreModules.size === 0) continue;

    // Pattern 1: global db.js mock
    if (/vi\.mock\(\s*["'](?:\.\.\/)+store\/db(?:\.js)?["']/.test(content)) continue;

    // Pattern 2: own Database instance
    if (/new\s+Database\s*\(/.test(content)) continue;

    // Filter to DB-touching modules only (pure modules don't need isolation)
    const dbTouching: string[] = [];
    for (const mod of importedStoreModules) {
      if (await moduleTouchesDb(mod)) dbTouching.push(mod);
    }
    if (dbTouching.length === 0) continue; // all imports are pure modules

    // Pattern 3: per-module mocks covering every DB-touching import
    const mockedStoreModules = new Set<string>();
    const mockMatches = content.match(/vi\.mock\(\s*["'](?:\.\.\/)+store\/[a-z][\w-]+(?:\.js)?["']/g) ?? [];
    for (const line of mockMatches) {
      const mod = extractStoreModule(line);
      if (mod) mockedStoreModules.add(mod);
    }
    const unmocked = dbTouching.filter((m) => !mockedStoreModules.has(m));
    if (unmocked.length === 0) continue;

    violations.push({ path: relative(REPO_ROOT, fullPath), unmockedDbTouchingImports: unmocked });
  }

  if (violations.length > 0) {
    console.error("ERROR: The following test files import DB-touching store modules without isolation:");
    for (const v of violations) {
      console.error(`  - ${v.path}`);
      console.error(`      unmocked: ${v.unmockedDbTouchingImports.join(", ")}`);
    }
    console.error(
      `\nFix: add 'vi.mock("../../store/db.js", () => ({ getDb: () => getTestDb(), closeDb: () => {} }));' before the production-store imports, OR add a per-module 'vi.mock("../../store/<name>.js", ...)' for each one listed above.`,
    );
    process.exit(1);
  }

  console.log(`OK: scanned ${files.length} test files; all DB-touching store imports are isolated.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Scanner error:", err);
  process.exit(1);
});
