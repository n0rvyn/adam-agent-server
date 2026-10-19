import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module-level cache — avoid repeated sync I/O
let _version: string | undefined;
let _name: string | undefined;

function findPackageJson(): string {
  // Try the most likely location first (works for both bundled and source layouts)
  const likely = join(__dirname, "..", "package.json");
  if (existsSync(likely)) return likely;
  // Fallback for source layout (src/lib/ → project root)
  const fallback = join(__dirname, "..", "..", "package.json");
  if (existsSync(fallback)) return fallback;
  // Last resort: use process.cwd() (works in test environments)
  return join(process.cwd(), "package.json");
}

export function getVersion(): string {
  if (_version === undefined) {
    const pkgPath = findPackageJson();
    _version = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }).version;
  }
  return _version;
}

export function getName(): string {
  if (_name === undefined) {
    const pkgPath = findPackageJson();
    _name = (JSON.parse(readFileSync(pkgPath, "utf-8")) as { name: string }).name;
  }
  return _name;
}
