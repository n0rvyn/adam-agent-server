// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../../../cli/client.js", () => ({ request: vi.fn().mockResolvedValue({}) }));

// Mirror Task 10 mock for stable role name in snapshot
vi.mock("../../../cli/tui/hooks/useRoleNames.js", () => ({
  useRoleNames: () => ({
    getName: (roleId: string | undefined | null) => (roleId === "role-1" ? "审慎者" : "?"),
    loaded: true,
  }),
}));

import { MessageHistory, type Message } from "../../../cli/tui/components/MessageHistory.js";

describe("MessageHistory snapshot", () => {
  it("matches snapshot for full envelope mix", () => {
    const ts = new Date("2026-05-07T10:42:00").getTime();
    // Single fixed taskId across thread members ensures snapshot stability across runs.
    const taskId = "abc12345-de67-89ab-cdef-1234567890ab";
    const messages: Message[] = [
      { id: "m1", role: "user", content: "审 PR #123 #124 #125", kind: "user_message", createdAt: ts },
      { id: "m2", role: "assistant", content: "已分派 3 个评审", kind: "assistant_text", createdAt: ts },
      { id: "m3", role: "assistant", content: "step 1", kind: "status_report", threadRoot: "t1", taskId, roleId: "role-1", createdAt: ts },
      { id: "m4", role: "assistant", content: "step 2", kind: "status_report", threadRoot: "t1", taskId, roleId: "role-1", createdAt: ts },
      { id: "m5", role: "assistant", content: "step 3", kind: "status_report", threadRoot: "t1", taskId, roleId: "role-1", createdAt: ts },
      {
        id: "m6",
        role: "assistant",
        content: "completed",
        kind: "result_delivery",
        threadRoot: "t1",
        taskId,
        roleId: "role-1",
        attachments: [
          {
            artifactId: "a1",
            locator: "local:///tmp/r.md",
            filename: "r.md",
            mimeType: "text/markdown",
            size: 2048,
            purpose: "report",
          },
        ],
        createdAt: ts,
      },
      { id: "m7", role: "assistant", content: "该决策已在 Web 端批准 ✓", kind: "system_note", createdAt: ts },
    ];
    const { lastFrame } = render(<MessageHistory messages={messages} />);
    expect(lastFrame()).toMatchSnapshot();
  });
});
