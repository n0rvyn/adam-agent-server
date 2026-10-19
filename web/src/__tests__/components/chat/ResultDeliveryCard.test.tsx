import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultDeliveryCard } from "@/components/chat/ResultDeliveryCard.tsx";
import type { ChatMessageInfo, ChatAttachmentInfo } from "@/store/useChatStore.ts";

const makeMsg = (overrides: Partial<ChatMessageInfo> = {}): ChatMessageInfo => ({
  id: "msg-1",
  sessionId: "sess-1",
  role: "assistant",
  content: "Task completed successfully.",
  source: { type: "web" },
  createdAt: Date.now(),
  ...overrides,
});

describe("ResultDeliveryCard", () => {
  it("renders content with role pill and task short ID", () => {
    render(
      <ResultDeliveryCard
        message={makeMsg({
          kind: "result_delivery",
          taskId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          roleId: "role-X",
          content: "Summary of the work done.",
        })}
      />,
    );
    expect(screen.getByTestId("result-delivery-card")).toBeInTheDocument();
    expect(screen.getByText("Summary of the work done.")).toBeInTheDocument();
    expect(screen.getByText("T-A1B2C3D4")).toBeInTheDocument();
    expect(screen.getByTestId("role-pill")).toBeInTheDocument();
  });

  it("renders attachments as chips", () => {
    const attachments: ChatAttachmentInfo[] = [
      {
        artifactId: "art-1",
        locator: "/tmp/out.md",
        filename: "review.md",
        mimeType: "text/markdown",
        size: 4200,
        purpose: "report",
      },
      {
        artifactId: "art-2",
        locator: "/tmp/data.json",
        filename: "data.json",
        mimeType: "application/json",
        size: 1200,
        purpose: "data",
      },
    ];
    render(
      <ResultDeliveryCard
        message={makeMsg({ kind: "result_delivery", attachments })}
      />,
    );
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(2);
    expect(screen.getByText("review.md")).toBeInTheDocument();
    expect(screen.getByText("data.json")).toBeInTheDocument();
  });

  it("renders mirror suffix with channel list and timestamp", () => {
    const fixedTime = new Date("2026-05-07T10:30:00").getTime();
    render(
      <ResultDeliveryCard
        message={makeMsg({
          kind: "result_delivery",
          createdAt: fixedTime,
          mirroredToTargets: [{ channelId: "wechat-bot" }],
        })}
      />,
    );
    expect(screen.getByTestId("mirror-suffix")).toBeInTheDocument();
    const text = screen.getByTestId("mirror-suffix").textContent;
    // Must match D-022 format: "(also delivered to: <list> @ <HH:MM>)"
    expect(text).toMatch(/^\(also delivered to: wechat-bot @ \d{1,2}:\d{2}\)$/);
  });

  it("omits mirror suffix when no mirroredToTargets", () => {
    render(
      <ResultDeliveryCard message={makeMsg({ kind: "result_delivery" })} />,
    );
    expect(screen.queryByTestId("mirror-suffix")).not.toBeInTheDocument();
  });

  it("omits attachment chips when no attachments", () => {
    render(
      <ResultDeliveryCard message={makeMsg({ kind: "result_delivery" })} />,
    );
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });
});
