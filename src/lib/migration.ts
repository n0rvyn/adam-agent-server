import { existsSync, copyFileSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
import { RUNTIME_DIR } from "../shared/constants.js";

export function ensureRuntimeDir(): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  mkdirSync(join(RUNTIME_DIR, "logs"), { recursive: true });
  mkdirSync(join(RUNTIME_DIR, ".claude"), { recursive: true });
}

/** One-time migration from project-local paths to ~/.adam/. Safe to call repeatedly. */
export function migrateRuntimeFiles(projectDir: string = process.cwd()): string[] {
  ensureRuntimeDir();
  const migrated: string[] = [];

  const migrations = [
    { from: join(projectDir, "data", "adam.db"), to: join(RUNTIME_DIR, "adam.db"), label: "database" },
    { from: join(projectDir, "adam.config.yaml"), to: join(RUNTIME_DIR, "adam.config.yaml"), label: "config" },
    { from: join(projectDir, ".env"), to: join(RUNTIME_DIR, ".env"), label: ".env" },
  ];

  for (const { from, to, label } of migrations) {
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to);
      migrated.push(label);
    }
  }

  // Migrate .claude/plugins/ directory if exists
  const oldPluginsDir = join(projectDir, ".claude", "plugins");
  const newPluginsDir = join(RUNTIME_DIR, ".claude", "plugins");
  if (existsSync(oldPluginsDir) && !existsSync(newPluginsDir)) {
    cpSync(oldPluginsDir, newPluginsDir, { recursive: true });
    migrated.push("plugins");
  }

  return migrated;
}
