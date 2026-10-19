import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Files that surface event payloads to LLM/MCP consumers.
// If a new tool/route surfaces events.payload, add it here.
const FILES_TO_GUARD = [
  "src/manager/adam-tools.ts",
  "src/server/routes/event-defs.ts",
  "src/server/routes/webhooks-events.ts",
];

describe("S5-B guard: untrusted payloads never reach LLM raw", () => {
  it.each(FILES_TO_GUARD)("file %s does not stringify event payload directly", (relPath) => {
    const abs = resolve(process.cwd(), relPath);
    const src = readFileSync(abs, "utf8");
    // Match direct stringification of event payload variables — but NOT args.payload (internal
    // byte-size validation in fire_event_def). Catches e.payload, row.payload, event.payload, etc.
    const offending = src.match(/JSON\.stringify\((?!args\b)[a-zA-Z_$][\w$]*\.payload\)/g);
    if (offending) {
      // Allow only inside formatEventForLLM body — but that lives in signal-sanitizer.ts, not these guarded files.
      throw new Error(
        `${relPath} contains raw \`JSON.stringify(*.payload)\` calls (${offending.length}). ` +
        `Use formatEventForLLM() from src/security/signal-sanitizer.ts instead so untrusted events get fenced. ` +
        `Matches: ${offending.join(", ")}`,
      );
    }
    expect(offending).toBeNull();
  });
});
