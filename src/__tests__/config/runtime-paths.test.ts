import { describe, it, expect } from "vitest";
import { RUNTIME_DIR, DB_PATH, CONFIG_PATH, ENV_PATH, CLAUDE_MD_PATH, LOGS_DIR } from "../../shared/constants.js";
import { homedir } from "os";
import { join } from "path";

describe("Runtime paths", () => {
  it("RUNTIME_DIR points to ~/.adam/", () => {
    expect(RUNTIME_DIR).toBe(join(homedir(), ".adam"));
  });

  it("DB_PATH is under RUNTIME_DIR", () => {
    expect(DB_PATH).toBe(join(RUNTIME_DIR, "adam.db"));
  });

  it("CONFIG_PATH is under RUNTIME_DIR", () => {
    expect(CONFIG_PATH).toBe(join(RUNTIME_DIR, "adam.config.yaml"));
  });

  it("ENV_PATH is under RUNTIME_DIR", () => {
    expect(ENV_PATH).toBe(join(RUNTIME_DIR, ".env"));
  });

  it("CLAUDE_MD_PATH is under RUNTIME_DIR", () => {
    expect(CLAUDE_MD_PATH).toBe(join(RUNTIME_DIR, "CLAUDE.md"));
  });

  it("LOGS_DIR is under RUNTIME_DIR", () => {
    expect(LOGS_DIR).toBe(join(RUNTIME_DIR, "logs"));
  });
});
