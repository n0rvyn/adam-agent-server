/**
 * Integration test for the audit-tool-receipts coverage script.
 * Invokes main() directly and asserts zero missing tools and zero stale exclusions.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("audit-tool-receipts coverage", () => {
  it("finds zero missing tools and zero stale exclusions", async () => {
    // Dynamic specifier (computed at runtime) bypasses tsc rootDir constraint:
    // the script lives outside src/ but is loaded at test time.
    const scriptUrl = pathToFileURL(resolve(process.cwd(), "scripts/audit-tool-receipts.ts")).href;
    const mod = (await import(scriptUrl)) as {
      main: () => Promise<{
        allCovered: boolean;
        missing: Array<{ file: string; name: string; line: number }>;
        staleExclusions: string[];
      }>;
    };
    const result = await mod.main();
    expect(result.allCovered, formatFailure(result)).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.staleExclusions).toHaveLength(0);
  });
});

function formatFailure(result: { missing: Array<{ file: string; name: string; line: number }>; staleExclusions: string[] }): string {
  let msg = "";
  if (result.missing.length > 0) {
    msg += "MISSING:\n" + result.missing.map((m) => `  ${m.file}::${m.name} (line ${m.line})`).join("\n") + "\n";
  }
  if (result.staleExclusions.length > 0) {
    msg += "STALE EXCLUSIONS:\n" + result.staleExclusions.map((n) => `  ${n}`).join("\n") + "\n";
  }
  return msg || "unknown failure";
}
