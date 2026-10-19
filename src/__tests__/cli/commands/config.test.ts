import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { setupTestDb, getTestDb } from "../../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

describe("config command", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  afterAll(() => {
    cleanup();
  });

  it("displays config from adam.config.yaml", async () => {
    const { configHandler } = await import("../../../cli/commands/config.js");
    await configHandler({});

    // Should have called console.log at least once (for the header)
    expect(consoleSpy).toHaveBeenCalled();
    // Should NOT have called process.exit (config file exists in project root)
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("displays config as JSON when --json flag passed", async () => {
    const { configHandler } = await import("../../../cli/commands/config.js");
    await configHandler({ json: true });

    // First call should be valid JSON
    const output = consoleSpy.mock.calls[0][0];
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
