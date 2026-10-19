import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRolePersona,
  loadRolePersona,
  updateLearnedRules,
  formatThreeTierRules,
  getRoleClaudeMdPath,
} from "../../agent/persona.js";
import type { Role } from "../../shared/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "adam-persona-test-"));
});

afterAll(() => {
  // Cleanup any remaining temp dirs - best effort
});

function makeAgent(overrides: Partial<Role> = {}): Role {
  return {
    id: "agent-1",
    name: overrides.name ?? "Artisan",
    cagPrompt: overrides.cagPrompt ?? "A skilled engineer",
    preferences: {},
    learnedRules: overrides.learnedRules ?? { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "stream-1",
    status: "active",
    createdAt: Date.now(),
  };
}

describe("agent/persona", () => {
  describe("getRoleClaudeMdPath", () => {
    it("should return the correct path", () => {
      const path = getRoleClaudeMdPath("/workspace");
      expect(path).toBe(join("/workspace", ".claude", "CLAUDE.md"));
    });
  });

  describe("formatThreeTierRules", () => {
    it("should include system, identity, and learned sections", () => {
      const agent = makeAgent({ learnedRules: { stylePreferences: ["rule 1", "rule 2"], avoidedActions: [], pinnedParameters: [] } });
      const output = formatThreeTierRules(agent);

      expect(output).toContain("## [system] (Immutable)");
      expect(output).toContain("## [identity] (User-Modifiable)");
      expect(output).toContain("## [learned] (Self-Evolving)");
    });

    it("should include agent name in identity section", () => {
      const agent = makeAgent({ name: "TestBot" });
      const output = formatThreeTierRules(agent);
      expect(output).toContain("TestBot");
    });

    it("should include CAG prompt in identity section", () => {
      const agent = makeAgent({ cagPrompt: "A skilled engineer" });
      const output = formatThreeTierRules(agent);
      expect(output).toContain("A skilled engineer");
    });

    it("should show '(none yet)' when no learned rules", () => {
      const agent = makeAgent({ learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] } });
      const output = formatThreeTierRules(agent);
      expect(output).toContain("(none yet)");
    });

    it("should list learned rules when present", () => {
      const agent = makeAgent({ learnedRules: { stylePreferences: ["always test", "prefer types"], avoidedActions: [], pinnedParameters: [] } });
      const output = formatThreeTierRules(agent);
      expect(output).toContain("- always test");
      expect(output).toContain("- prefer types");
    });
  });

  describe("writeRolePersona", () => {
    it("should create .claude/CLAUDE.md file", () => {
      const agent = makeAgent();
      writeRolePersona(agent, tempDir);

      const claudePath = getRoleClaudeMdPath(tempDir);
      expect(existsSync(claudePath)).toBe(true);
    });

    it("should write correct content structure", () => {
      const agent = makeAgent({ name: "Writer" });
      writeRolePersona(agent, tempDir);

      const content = readFileSync(getRoleClaudeMdPath(tempDir), "utf-8");
      expect(content).toContain("# Role Workspace CLAUDE.md");
      expect(content).toContain("Writer");
      expect(content).toContain("[system]");
      expect(content).toContain("[identity]");
      expect(content).toContain("[learned]");
    });

    it("should create .claude directory if it does not exist", () => {
      const agent = makeAgent();
      const subDir = join(tempDir, "subproject");
      writeRolePersona(agent, subDir);

      expect(existsSync(join(subDir, ".claude"))).toBe(true);
    });
  });

  describe("loadRolePersona", () => {
    it("should return null when file does not exist", () => {
      const result = loadRolePersona(join(tempDir, "nonexistent"));
      expect(result).toBeNull();
    });

    it("should return file content when it exists", () => {
      const agent = makeAgent();
      writeRolePersona(agent, tempDir);

      const content = loadRolePersona(tempDir);
      expect(content).not.toBeNull();
      expect(content).toContain("Role Workspace CLAUDE.md");
    });
  });

  describe("updateLearnedRules", () => {
    it("should update only the learned section", () => {
      const agent = makeAgent({ learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] } });
      writeRolePersona(agent, tempDir);

      const updatedAgent = makeAgent({ learnedRules: { stylePreferences: ["new insight"], avoidedActions: [], pinnedParameters: [] } });
      updateLearnedRules(updatedAgent, tempDir);

      const content = readFileSync(getRoleClaudeMdPath(tempDir), "utf-8");
      expect(content).toContain("- new insight");
      expect(content).toContain("[system]");
      expect(content).toContain("[identity]");
    });

    it("should create file if it does not exist", () => {
      const agent = makeAgent({ learnedRules: { stylePreferences: ["from scratch"], avoidedActions: [], pinnedParameters: [] } });
      const newDir = join(tempDir, "new-workspace");
      updateLearnedRules(agent, newDir);

      const content = readFileSync(getRoleClaudeMdPath(newDir), "utf-8");
      expect(content).toContain("- from scratch");
    });

    it("should preserve content before learned section", () => {
      const agent = makeAgent({ name: "PreserveMe", cagPrompt: "A test role" });
      writeRolePersona(agent, tempDir);

      const updatedAgent = makeAgent({
        name: "PreserveMe",
        cagPrompt: "A test role",
        learnedRules: { stylePreferences: ["learned rule"], avoidedActions: [], pinnedParameters: [] },
      });
      updateLearnedRules(updatedAgent, tempDir);

      const content = readFileSync(getRoleClaudeMdPath(tempDir), "utf-8");
      expect(content).toContain("PreserveMe");
      expect(content).toContain("A test role");
      expect(content).toContain("- learned rule");
    });
  });
});
