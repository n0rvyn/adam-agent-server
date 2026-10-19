import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_ROOT = "src/__tests__";
const TEST_EXTENSIONS = [".test.ts", ".test.tsx"];
const MAX_FILES_PER_BATCH = 20;

function isTestFile(name) {
  return TEST_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (entry.isFile() && isTestFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function collectGroups() {
  const entries = readdirSync(TEST_ROOT, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = [];

  for (const entry of entries) {
    const fullPath = join(TEST_ROOT, entry.name);
    if (entry.isDirectory()) {
      const files = collectFiles(fullPath);
      if (files.length > 0) {
        groups.push({ label: entry.name, files });
      }
      continue;
    }

    if (entry.isFile() && isTestFile(entry.name)) {
      groups.push({ label: entry.name, files: [fullPath] });
    }
  }

  return groups;
}

function chunkFiles(files) {
  const chunks = [];
  for (let index = 0; index < files.length; index += MAX_FILES_PER_BATCH) {
    chunks.push(files.slice(index, index + MAX_FILES_PER_BATCH));
  }
  return chunks;
}

function runGroup(index, total, group, files) {
  process.stdout.write(`\n[vitest-group ${index}/${total}] ${group.label}\n`);
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", ...files],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const groups = collectGroups();
if (groups.length === 0) {
  process.stdout.write("No Vitest files found.\n");
  process.exit(0);
}

const batches = groups.flatMap((group) => {
  const chunks = chunkFiles(group.files);
  if (chunks.length === 1) {
    return [{ label: group.label, files: chunks[0] }];
  }
  return chunks.map((files, index) => ({
    label: `${group.label} (${index + 1}/${chunks.length})`,
    files,
  }));
});

batches.forEach((batch, index) => runGroup(index + 1, batches.length, batch, batch.files));
