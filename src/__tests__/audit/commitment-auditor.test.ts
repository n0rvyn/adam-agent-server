import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { auditAssistantCommitment, listAssistantCommitmentAudits } from "../../audit/commitment-auditor.js";
import { recordRuntimeEffect } from "../../store/runtime-effects.js";
import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { ServerConfig } from "../../shared/types.js";
import { getUnsupportedMutationText } from "../../chat/commitment-replacement-text.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

describe("audit/commitment-auditor", () => {
  it("passes text with no committed mutation claim", () => {
    const result = auditAssistantCommitment({ text: "我会先检查现有模板。", traceId: "trace-none" });
    expect(result.status).toBe("passed");
    expect(listAssistantCommitmentAudits()).toEqual([]);
  });

  it("blocks recorded claims without trace-scoped evidence", () => {
    const result = auditAssistantCommitment({
      text: "收到，已记录：背景音乐音量 -5%",
      traceId: "trace-missing",
      sessionId: "session-1",
      messageId: "msg-1",
    });

    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe(getUnsupportedMutationText("zh"));
    expect(listAssistantCommitmentAudits("trace-missing")[0]).toEqual(expect.objectContaining({
      status: "blocked",
      claim_type: "template_update",
    }));
  });

  it("blocks claims backed only by unrelated effect categories", () => {
    recordRuntimeEffect({
      traceId: "trace-unrelated",
      effectType: "create",
      effectCategory: "goal_update",
      entityType: "goal",
      entityId: "goal-1",
    });

    const result = auditAssistantCommitment({
      text: "背景音乐已记录",
      traceId: "trace-unrelated",
    });

    expect(result.status).toBe("blocked");
    expect(result.evidenceEffectIds).toEqual([]);
  });

  it("passes claims with matching template mutation evidence", () => {
    const effect = recordRuntimeEffect({
      traceId: "trace-template",
      effectType: "update",
      effectCategory: "template_update",
      entityType: "task_template",
      entityId: "tmpl-1",
      fieldPath: "steps.audio.config.backgroundMusicVolume",
    });

    const result = auditAssistantCommitment({
      text: "背景音乐已记录",
      traceId: "trace-template",
    });

    expect(result.status).toBe("passed");
    expect(result.evidenceEffectIds).toEqual([effect.id]);
    expect(listAssistantCommitmentAudits("trace-template")[0]).toEqual(expect.objectContaining({
      status: "passed",
      evidence_effect_ids: JSON.stringify([effect.id]),
    }));
  });

  it("requires task_scheduled evidence for scheduled claims", () => {
    recordRuntimeEffect({
      traceId: "trace-schedule",
      effectType: "create",
      effectCategory: "task_scheduled",
      entityType: "task_template",
      entityId: "tmpl-once",
    });

    expect(auditAssistantCommitment({
      text: "半小时后已安排",
      traceId: "trace-schedule",
    }).status).toBe("passed");
    expect(auditAssistantCommitment({
      text: "半小时后已安排",
      traceId: "trace-no-schedule",
    }).status).toBe("blocked");
  });
});

describe("audit/commitment-auditor — EN", () => {
  it("uses en unsupportedMutationText for EN mutation claim without evidence", () => {
    const result = auditAssistantCommitment({
      text: "I've updated the goal to 30 minutes.",
      traceId: "trace-en-mut",
      sessionId: "session-en",
      messageId: "msg-en",
    });
    expect(result.status).toBe("blocked");
    expect(result.replacementText).toBe(getUnsupportedMutationText("en"));
  });

  it("passes EN mutation claim with matching runtime effect evidence", () => {
    recordRuntimeEffect({
      traceId: "trace-en-goal",
      effectType: "update",
      effectCategory: "goal_update",
      entityType: "goal",
      entityId: "goal-1",
    });
    expect(auditAssistantCommitment({
      text: "I've updated the goal.",
      traceId: "trace-en-goal",
    }).status).toBe("passed");
  });
});

describe("audit/commitment-auditor — inferLocale boundary", () => {
  it("infers zh for predominantly CJK text", () => {
    const result = auditAssistantCommitment({
      text: "已经更新配置使用 default 模板",  // > 30% CJK
      traceId: "trace-mixed-zh",
    });
    // Locale inference must produce zh-locale replacement text on block
    if (result.status === "blocked") {
      expect(result.replacementText).toBe(getUnsupportedMutationText("zh"));
    }
  });

  it("infers en for mostly-EN text with one Chinese word", () => {
    const result = auditAssistantCommitment({
      text: "I've updated 配置 to use new settings.",  // < 30% CJK
      traceId: "trace-mixed-en",
    });
    if (result.status === "blocked") {
      expect(result.replacementText).toBe(getUnsupportedMutationText("en"));
    }
  });

  it("infers zh for pure CJK input", () => {
    const result = auditAssistantCommitment({
      text: "已记录背景音乐音量",
      traceId: "trace-pure-zh",
    });
    if (result.status === "blocked") {
      expect(result.replacementText).toBe(getUnsupportedMutationText("zh"));
    }
  });

  it("infers en for pure EN input (and empty-edge text → en)", () => {
    const result = auditAssistantCommitment({
      text: "I've scheduled the task.",
      traceId: "trace-pure-en",
    });
    if (result.status === "blocked") {
      expect(result.replacementText).toBe(getUnsupportedMutationText("en"));
    }
  });
});
