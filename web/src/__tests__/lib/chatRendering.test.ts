import { describe, it, expect } from "vitest";
import {
  roleColorToken,
  taskShortId,
  groupConsecutiveStatusReports,
  groupByThread,
  type ThreadSegment,
} from "@/lib/chatRendering.ts";

const makeMsg = (overrides: Partial<import("@/store/useChatStore").ChatMessageInfo> = {}) =>
  ({
    id: "m0",
    sessionId: "s0",
    role: "assistant",
    content: "hello",
    source: { type: "web" },
    createdAt: Date.now(),
    ...overrides,
  }) as import("@/store/useChatStore").ChatMessageInfo;

describe("roleColorToken", () => {
  it("returns one of the 6 palette tokens", () => {
    const tokens = [
      "var(--app-log-adam)",
      "var(--app-log-manager)",
      "var(--app-log-scheduler)",
      "var(--app-log-ws)",
      "var(--app-log-store)",
      "var(--app-log-embedding)",
    ];
    for (let i = 0; i < 20; i++) {
      expect(tokens).toContain(roleColorToken(`role-${i}`));
    }
  });

  it("returns stable color for the same roleId", () => {
    const color = roleColorToken("role-A");
    for (let i = 0; i < 100; i++) {
      expect(roleColorToken("role-A")).toBe(color);
    }
  });

  it("returns fallback for undefined roleId", () => {
    expect(roleColorToken(undefined)).toBe("var(--app-text-subtle)");
  });
});

describe("taskShortId", () => {
  it("formats a UUID correctly", () => {
    expect(taskShortId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe("T-A1B2C3D4");
  });

  it("returns empty string for undefined", () => {
    expect(taskShortId(undefined)).toBe("");
  });
});

describe("groupConsecutiveStatusReports", () => {
  it("collapses 3+ consecutive status_reports into one status-group", () => {
    const messages = [
      makeMsg({ id: "u", kind: "user_message" }),
      makeMsg({ id: "s1", kind: "status_report" }),
      makeMsg({ id: "s2", kind: "status_report" }),
      makeMsg({ id: "s3", kind: "status_report" }),
      makeMsg({ id: "r", kind: "result_delivery" }),
    ];
    const segments = groupConsecutiveStatusReports(messages, 3);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "single", message: messages[0] });
    expect(segments[1]).toEqual({
      type: "status-group",
      messages: [messages[1], messages[2], messages[3]],
    });
    expect(segments[2]).toEqual({ type: "single", message: messages[4] });
  });

  it("keeps fewer than 3 status_reports as individual singles", () => {
    const messages = [
      makeMsg({ id: "u", kind: "user_message" }),
      makeMsg({ id: "s1", kind: "status_report" }),
      makeMsg({ id: "s2", kind: "status_report" }),
      makeMsg({ id: "r", kind: "result_delivery" }),
    ];
    const segments = groupConsecutiveStatusReports(messages, 3);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toEqual({ type: "single", message: messages[0] });
    expect(segments[1]).toEqual({ type: "single", message: messages[1] });
    expect(segments[2]).toEqual({ type: "single", message: messages[2] });
    expect(segments[3]).toEqual({ type: "single", message: messages[3] });
  });
});

describe("groupByThread", () => {
  it("groups messages by threadRoot with free bucket first", () => {
    const messages = [
      makeMsg({ id: "m1", threadRoot: undefined, kind: "user_message" }),
      makeMsg({ id: "m2", threadRoot: "t1", kind: "status_report" }),
      makeMsg({ id: "m3", threadRoot: "t1", kind: "result_delivery" }),
      makeMsg({ id: "m4", threadRoot: "t2", kind: "status_report" }),
    ];
    const buckets = groupByThread(messages);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toEqual({ threadRoot: null, messages: [messages[0]] });
    expect(buckets[1]).toEqual({ threadRoot: "t1", messages: [messages[1], messages[2]] });
    expect(buckets[2]).toEqual({ threadRoot: "t2", messages: [messages[3]] });
  });
});
