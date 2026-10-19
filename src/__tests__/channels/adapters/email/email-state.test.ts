import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getEmailGatewayStatePath,
  loadEmailGatewayState,
  recordSeenMessageId,
  recordSentMessageId,
  saveEmailGatewayState,
} from "../../../../channels/adapters/email/email-state.js";

describe("email gateway state", () => {
  it("persists and reloads cursor state", () => {
    const root = mkdtempSync(join(tmpdir(), "adam-email-state-"));
    const path = getEmailGatewayStatePath(root);
    try {
      saveEmailGatewayState({
        uidValidity: 7,
        lastUid: 42,
        seenMessageIds: ["seen-1"],
        sentMessageIds: ["sent-1"],
        updatedAt: 1,
      }, path);

      expect(loadEmailGatewayState(path)).toMatchObject({
        uidValidity: 7,
        lastUid: 42,
        seenMessageIds: ["seen-1"],
        sentMessageIds: ["sent-1"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records seen and sent message ids durably", () => {
    const root = mkdtempSync(join(tmpdir(), "adam-email-state-"));
    const path = getEmailGatewayStatePath(root);
    try {
      recordSeenMessageId(" seen-1 ", path);
      recordSentMessageId(" sent-1 ", path);
      const state = loadEmailGatewayState(path);

      expect(state.seenMessageIds).toEqual(["seen-1"]);
      expect(state.sentMessageIds).toEqual(["sent-1"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
