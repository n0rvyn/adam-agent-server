import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli/index.ts" },
  format: "esm",
  target: "node20",
  dts: false,
  minify: true,
  outDir: "dist",
  clean: true,
  external: [
    "better-sqlite3",
    "ws",
    "pino",
    "pino-pretty",
    // Node.js built-ins (ws requires these via CJS require)
    "events",
    "http",
    "https",
    "net",
    "tls",
    "crypto",
    "stream",
    "url",
    "zlib",
    "buffer",
    "util",
  ],
});
