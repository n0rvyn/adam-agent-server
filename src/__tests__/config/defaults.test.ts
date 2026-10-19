import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../../config/defaults.js";

describe("DEFAULT_CONFIG", () => {
  it("has server section with port and host", () => {
    expect(DEFAULT_CONFIG.server.port).toBe(7100);
    expect(DEFAULT_CONFIG.server.host).toBe("0.0.0.0");
  });

  it("has defaults section with model and timeout", () => {
    expect(DEFAULT_CONFIG.defaults.timeout).toBe(600);
    expect(DEFAULT_CONFIG.defaults.maxTurns).toBe(400);
    expect(DEFAULT_CONFIG.defaults.model).toBe("");
  });

  it("has deniedReadPaths defaults", () => {
    expect(DEFAULT_CONFIG.defaults.deniedReadPaths).toContain("~/.ssh");
    expect(DEFAULT_CONFIG.defaults.deniedReadPaths).toContain("~/.aws");
  });

  it("settingSources defaults to user and project", () => {
    expect(DEFAULT_CONFIG.defaults.settingSources).toEqual(["user", "project"]);
  });

  it("has approval defaults", () => {
    expect(DEFAULT_CONFIG.defaults.approvalRequired).toContain("rm -rf *");
    expect(DEFAULT_CONFIG.defaults.approvalTimeout).toBe(600);
  });

  it("has agents section", () => {
    expect(DEFAULT_CONFIG.roles).toBeDefined();
    expect(DEFAULT_CONFIG.roles!.presets).toEqual([]);
  });

  it("has watchdog section with correct defaults", () => {
    expect(DEFAULT_CONFIG.watchdog).toBeDefined();
    expect(DEFAULT_CONFIG.watchdog!.enabled).toBe(true);
    expect(DEFAULT_CONFIG.watchdog!.intervalMinutes).toBe(5);
    expect(DEFAULT_CONFIG.watchdog!.rules.managerHealthCheck.enabled).toBe(true);
    expect(DEFAULT_CONFIG.watchdog!.rules.managerHealthCheck.action).toBe("restart");
    expect(DEFAULT_CONFIG.watchdog!.rules.managerHealthCheck.staleDurationMinutes).toBe(15);
    expect(DEFAULT_CONFIG.watchdog!.rules.staleTasks.enabled).toBe(true);
    expect(DEFAULT_CONFIG.watchdog!.rules.staleTasks.action).toBe("notify");
    expect(DEFAULT_CONFIG.watchdog!.rules.staleTasks.maxPendingMinutes).toBe(30);
    expect(DEFAULT_CONFIG.watchdog!.rules.dbMaintenance.enabled).toBe(true);
    expect(DEFAULT_CONFIG.watchdog!.rules.dbMaintenance.action).toBe("ignore");
    expect(DEFAULT_CONFIG.watchdog!.rules.dbMaintenance.walCheckpointThresholdMB).toBe(100);
  });

  // Phase 2: maxTurns raised from 100 to 400 (task-013bb0f8 hit 200 ceiling)
  it("maxTurns defaults to 400 for research-class task headroom", () => {
    expect(DEFAULT_CONFIG.defaults.maxTurns).toBe(400);
  });

  it("maxTurns is not capped at the old 200 ceiling", () => {
    expect(DEFAULT_CONFIG.defaults.maxTurns).toBeGreaterThanOrEqual(400);
  });
});
