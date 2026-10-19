import { describe, it, expect } from "vitest";
import { getSdkMcpServersForRole } from "../../manager/role-mcp-registry.js";

describe("manager/role-mcp-registry", () => {
  it("returns mining-tools for feature-miner preset", () => {
    const servers = getSdkMcpServersForRole({ id: "role-test", presetId: "feature-miner" });
    expect(servers).toHaveProperty("mining-tools");
    expect(servers["mining-tools"]).toBeDefined();
  });

  it("returns empty for engineer preset", () => {
    const servers = getSdkMcpServersForRole({ id: "role-test", presetId: "engineer" });
    expect(servers).toEqual({});
  });

  it("returns empty for role without presetId", () => {
    const servers = getSdkMcpServersForRole({ id: "role-test" });
    expect(servers).toEqual({});
  });
});
