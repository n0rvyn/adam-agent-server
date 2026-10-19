import { describe, it, expect } from "vitest";
import {
  taskIdSchema,
  roleIdSchema,
  goalIdSchema,
  channelIdSchema,
  sessionIdSchema,
  templateIdSchema,
  pluginIdSchema,
  eventDefIdSchema,
  ruleIdSchema,
  strategyIdSchema,
  localFilePathSchema,
  stepIdSchema,
} from "../../lib/tool-schemas.js";

describe("tool-schemas", () => {
  describe("UUID-only schemas (taskId, goalId, channelId, sessionId, eventDefId, ruleId, strategyId)", () => {
    it("accepts a valid UUID v4", () => {
      const valid = "a1b2c3d4-5e6f-4789-9abc-def012345678";
      for (const s of [taskIdSchema, goalIdSchema, channelIdSchema, sessionIdSchema, eventDefIdSchema, ruleIdSchema, strategyIdSchema]) {
        expect(s.safeParse(valid).success).toBe(true);
      }
    });
    it("rejects non-UUID values with helpful errors", () => {
      const r = channelIdSchema.safeParse("iPad WeChat");
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.message).toContain("UUID");
        expect(r.error.message).toContain("list_channels");
      }
    });
    it("rejects empty string", () => {
      expect(taskIdSchema.safeParse("").success).toBe(false);
    });
  });

  describe("roleIdSchema (UUID or system role ID)", () => {
    it("accepts UUID", () => {
      expect(roleIdSchema.safeParse("a1b2c3d4-5e6f-4789-9abc-def012345678").success).toBe(true);
    });
    it("accepts 'role-chat-manager' system role ID", () => {
      expect(roleIdSchema.safeParse("role-chat-manager").success).toBe(true);
    });
    it("accepts 'role-adam-automator'", () => {
      expect(roleIdSchema.safeParse("role-adam-automator").success).toBe(true);
    });
    it("rejects Chinese role name (real failure mode the LLM hits today)", () => {
      const r = roleIdSchema.safeParse("审慎者");
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.message).toContain("list_roles");
    });
    it("rejects 'admin' or other non-prefixed strings", () => {
      expect(roleIdSchema.safeParse("admin").success).toBe(false);
    });
  });

  describe("templateIdSchema (UUID, 'tmpl-<hex>', 'workflow-<uuid>', or friendly ID)", () => {
    it("accepts 'tmpl-a1b2c3d4'", () => {
      expect(templateIdSchema.safeParse("tmpl-a1b2c3d4").success).toBe(true);
    });
    it("accepts UUID", () => {
      expect(templateIdSchema.safeParse("a1b2c3d4-5e6f-4789-9abc-def012345678").success).toBe(true);
    });
    it("accepts 'workflow-<uuid>'", () => {
      expect(templateIdSchema.safeParse("workflow-227c93e4-6763-41c2-b1c2-65ad02fdfab9").success).toBe(true);
    });
    it("rejects 'tmpl-' (no hex)", () => {
      expect(templateIdSchema.safeParse("tmpl-").success).toBe(false);
    });
    it("rejects 'workflow-' (no uuid)", () => {
      expect(templateIdSchema.safeParse("workflow-").success).toBe(false);
    });
    it("accepts friendly ID 'pkos-scan-and-sync'", () => {
      expect(templateIdSchema.safeParse("pkos-scan-and-sync").success).toBe(true);
    });
    it("accepts friendly ID 'pkos-inbox-ripple-workflow'", () => {
      expect(templateIdSchema.safeParse("pkos-inbox-ripple-workflow").success).toBe(true);
    });
    it("rejects friendly ID without hyphen separator", () => {
      expect(templateIdSchema.safeParse("pkossync").success).toBe(false);
    });
  });

  describe("stepIdSchema (letters incl. CJK, digits, dots, underscores, dashes)", () => {
    it("accepts ASCII step ID", () => {
      expect(stepIdSchema.safeParse("step-1").success).toBe(true);
    });
    it("accepts Chinese step ID", () => {
      expect(stepIdSchema.safeParse("达芬奇写作").success).toBe(true);
    });
    it("rejects empty string", () => {
      expect(stepIdSchema.safeParse("").success).toBe(false);
    });
    it("rejects step ID with spaces", () => {
      expect(stepIdSchema.safeParse("step 1").success).toBe(false);
    });
  });

  describe("pluginIdSchema ('name@scope')", () => {
    it("accepts 'github@anthropic'", () => {
      expect(pluginIdSchema.safeParse("github@anthropic").success).toBe(true);
    });
    it("accepts 'dev-workflow@cookit-marketplace'", () => {
      expect(pluginIdSchema.safeParse("dev-workflow@cookit-marketplace").success).toBe(true);
    });
    it("rejects bare 'github' (no @scope)", () => {
      expect(pluginIdSchema.safeParse("github").success).toBe(false);
    });
    it("rejects '@anthropic' (no name)", () => {
      expect(pluginIdSchema.safeParse("@anthropic").success).toBe(false);
    });
  });

  describe("localFilePathSchema", () => {
    it("accepts absolute path", () => {
      expect(localFilePathSchema.safeParse("/Users/me/file.txt").success).toBe(true);
    });
    it("accepts tilde-expanded path", () => {
      expect(localFilePathSchema.safeParse("~/Documents/file.txt").success).toBe(true);
    });
    it("rejects relative path", () => {
      expect(localFilePathSchema.safeParse("./file.txt").success).toBe(false);
    });
    it("rejects remote URL (real failure mode per CLAUDE.md memory)", () => {
      const r = localFilePathSchema.safeParse("https://example.com/file.png");
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.message).toContain("absolute");
    });
  });
});
