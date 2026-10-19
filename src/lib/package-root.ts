import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Package root directory — resolves to the npm package's installation location.
 * Works for both local development (`pnpm dev`) and global npm install.
 *
 * tsup bundles all source into dist/, so import.meta.url always points to dist/*.js.
 * One dirname() gives dist/, another gives the package root.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(__dirname, "..");
