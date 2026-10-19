import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotifyTargetSelector } from "@/components/ui/NotifyTargetSelector.tsx";

vi.mock("@/lib/api.ts", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/channels") {
      return {
        channels: [{
          id: "mail-1",
          name: "Client Mail",
          platform: "email",
          enabled: true,
          config: { address: "test1@test.com" },
        }],
      };
    }
    if (path === "/chat/sessions") return { sessions: [] };
    return {};
  }),
}));

describe("NotifyTargetSelector email channels", () => {
  it("lists an email channel with no prior session", async () => {
    const onChange = vi.fn();
    render(<NotifyTargetSelector value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Default/ }));
    await waitFor(() => expect(screen.getByText("Client Mail")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Client Mail"));

    expect(onChange).toHaveBeenCalledWith([{ type: "channel", channelId: "mail-1", chatId: "test1@test.com" }]);
  });
});
