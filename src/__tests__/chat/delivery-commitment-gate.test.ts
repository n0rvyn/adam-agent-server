import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import { applyFutureDeliveryCommitmentGate } from "../../chat/delivery-commitment-gate.js";
import { initRuntimeConfig } from "../../config/runtime.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { getBlockedFutureDeliveryText } from "../../chat/commitment-replacement-text.js";
import type { ServerConfig, CapturedDispatch, ChatSource } from "../../shared/types.js";

afterAll(() => cleanup());
beforeEach(() => {
  clearTestDb();
  initRuntimeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ServerConfig);
});

const webSource: ChatSource = { type: "web" };

function dispatch(taskId: string): CapturedDispatch {
  return { taskId, toolName: "dispatch_to_role", traceId: "trace-x" };
}

describe("chat/delivery-commitment-gate — ZH", () => {
  it("creates commitment when ZH future-delivery has exactly one dispatch", () => {
    const result = applyFutureDeliveryCommitmentGate({
      text: "完成后我会发到你的微信。",
      traceId: "trace-1",
      sessionId: "session-1",
      source: webSource,
      sourceMessageId: "msg-1",
      dispatches: [dispatch("task-1")],
    });
    expect(result.createdCommitmentIds).toHaveLength(1);
    expect(result.text).toContain("完成后");
  });

  it("blocks and replaces with ZH text when missing dispatch", () => {
    const result = applyFutureDeliveryCommitmentGate({
      text: "完成后我会发到你的微信。",
      traceId: "trace-2",
      sessionId: "session-2",
      source: webSource,
      sourceMessageId: "msg-2",
      dispatches: [],
    });
    expect(result.blockedReasons).toContain("missing_dispatch");
    expect(result.text).toContain(getBlockedFutureDeliveryText("zh"));
  });
});

describe("chat/delivery-commitment-gate — EN", () => {
  it("creates commitment when EN future-delivery has exactly one dispatch", () => {
    const result = applyFutureDeliveryCommitmentGate({
      text: "I'll send you the 3 images once done.",
      traceId: "trace-en-1",
      sessionId: "session-en-1",
      source: webSource,
      sourceMessageId: "msg-en-1",
      dispatches: [dispatch("task-en-1")],
    });
    expect(result.createdCommitmentIds.length).toBeGreaterThan(0);
  });

  it("blocks and replaces with EN text when EN detection lacks dispatch", () => {
    const result = applyFutureDeliveryCommitmentGate({
      text: "I'll send the report later.",
      traceId: "trace-en-2",
      sessionId: "session-en-2",
      source: webSource,
      sourceMessageId: "msg-en-2",
      dispatches: [],
    });
    expect(result.blockedReasons).toContain("missing_dispatch");
    expect(result.text).toContain(getBlockedFutureDeliveryText("en"));
  });

  it("uses en blockedText (not zh) when EN-locale detection blocks", () => {
    const result = applyFutureDeliveryCommitmentGate({
      text: "I'll deliver the file once finished.",
      traceId: "trace-en-3",
      sessionId: "session-en-3",
      source: webSource,
      sourceMessageId: "msg-en-3",
      dispatches: [],
    });
    expect(result.text).not.toContain(getBlockedFutureDeliveryText("zh"));
    expect(result.text).toContain(getBlockedFutureDeliveryText("en"));
  });
});
