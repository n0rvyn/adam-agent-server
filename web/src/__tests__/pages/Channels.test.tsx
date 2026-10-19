import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor, within } from "../utils/test-utils";
import { Channels } from "@/pages/Channels.tsx";
import { api } from "@/lib/api.ts";

interface TestChannel {
  id: string;
  name: string;
  platform: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
  createdAt: number;
  messageCount: number;
}

vi.mock("@/lib/api.ts", () => ({
  api: vi.fn(),
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const mockApi = vi.mocked(api);

describe("Channels", () => {
  beforeEach(() => {
    mockApi.mockReset();
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/channels") return { channels: [] };
      return {};
    });
  });

  it("renders page title", async () => {
    render(<Channels />);

    expect(await screen.findByText("Channels")).toBeInTheDocument();
  });

  it("renders Add Channel button", async () => {
    render(<Channels />);

    expect(await screen.findByRole("button", { name: /Add Channel/ })).toBeInTheDocument();
  });

  it("shows empty state when no channels", async () => {
    render(<Channels />);

    expect(await screen.findByText("No channels")).toBeInTheDocument();
  });

  it("renders channel cards when channels exist", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/channels") {
        return {
          channels: [
            channel({
              id: "ch1",
              name: "TG Bot",
              platform: "telegram",
              status: "connected",
              messageCount: 5,
            }),
          ],
        };
      }
      return {};
    });

    render(<Channels />);

    expect(await screen.findByText("TG Bot")).toBeInTheDocument();
    expect(screen.getByText("telegram")).toBeInTheDocument();
    expect(screen.getByText("connected")).toBeInTheDocument();
    const card = screen.getByText("TG Bot").closest(".surface-panel");
    expect(card).toBeTruthy();
    expect(within(card as HTMLElement).getByText("5")).toBeInTheDocument();
  });

  it("shows form when Add Channel is clicked", async () => {
    const user = userEvent.setup();
    render(<Channels />);

    await user.click(await screen.findByRole("button", { name: /Add Channel/ }));

    expect(screen.getByText("New Channel")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Platform")).toBeInTheDocument();
  });

  it("offers email platform and fills the config template", async () => {
    const user = userEvent.setup();
    render(<Channels />);

    await user.click(await screen.findByRole("button", { name: /Add Channel/ }));
    await user.selectOptions(screen.getByLabelText("Platform"), "email");

    expect(screen.getByDisplayValue(/"address": "test1@test.com"/)).toBeInTheDocument();
  });

  it("creates an email channel and refreshes the list", async () => {
    const user = userEvent.setup();
    const created = channel({
      id: "mail-1",
      name: "Client Mail",
      platform: "email",
      config: { address: "client@example.com" },
    });
    let fetchCount = 0;

    mockApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === "/channels" && options?.method === "POST") {
        expect(JSON.parse(options.body ?? "{}")).toEqual({
          name: "Client Mail",
          platform: "email",
          config: { address: "client@example.com" },
          enabled: true,
        });
        return { channel: created };
      }
      if (path === "/channels") {
        fetchCount += 1;
        return { channels: fetchCount > 1 ? [created] : [] };
      }
      return {};
    });

    render(<Channels />);

    await user.click(await screen.findByRole("button", { name: /Add Channel/ }));
    await user.clear(screen.getByPlaceholderText("My Telegram Bot"));
    await user.type(screen.getByPlaceholderText("My Telegram Bot"), "Client Mail");
    await user.selectOptions(screen.getByLabelText("Platform"), "email");
    const configInput = screen.getByDisplayValue(/"address": "test1@test.com"/);
    fireEvent.change(configInput, { target: { value: '{\n  "address": "client@example.com"\n}' } });
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Client Mail")).toBeInTheDocument();
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("shows edit form when edit button is clicked", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/channels") {
        return {
          channels: [
            channel({
              id: "ch1",
              name: "TG Bot",
              platform: "telegram",
              config: { botToken: "test" },
            }),
          ],
        };
      }
      return {};
    });

    render(<Channels />);
    await screen.findByText("TG Bot");

    const editButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-pencil"));
    expect(editButton).toBeDefined();
    await user.click(editButton!);

    expect(screen.getByText("Edit Channel")).toBeInTheDocument();
    expect(screen.getByDisplayValue("TG Bot")).toBeInTheDocument();
  });

  it("renders connect and disconnect actions on channel cards", async () => {
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/channels") {
        return {
          channels: [
            channel({ id: "ch1", name: "Disconnected Bot", status: "disconnected" }),
            channel({ id: "ch2", name: "Connected Bot", status: "connected" }),
          ],
        };
      }
      return {};
    });

    render(<Channels />);

    expect(await screen.findByText("Disconnected Bot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
  });

  it("shows the connect API error instead of hiding it", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/channels") {
        return { channels: [channel({ id: "mail-1", name: "Client Mail", platform: "email", status: "disconnected" })] };
      }
      if (path === "/channels/mail-1/connect" && options?.method === "POST") {
        throw new Error("Email Gateway is disabled");
      }
      return {};
    });

    render(<Channels />);
    await screen.findByText("Client Mail");
    await user.click(screen.getByRole("button", { name: /Connect/ }));

    expect(await screen.findByText("Email Gateway is disabled")).toBeInTheDocument();
  });

  it("opens the message history panel from a channel card", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string) => {
      if (path === "/channels") {
        return { channels: [channel({ id: "mail-1", name: "Client Mail", platform: "email" })] };
      }
      if (path === "/channels/mail-1/messages") {
        return {
          messages: [
            {
              id: "msg-1",
              sessionId: "session-1",
              role: "user",
              content: "Send the report",
              createdAt: Date.now(),
            },
          ],
        };
      }
      return {};
    });

    render(<Channels />);
    await screen.findByText("Client Mail");

    const messagesButton = screen.getAllByRole("button").find((button) => button.querySelector("svg.lucide-message-square"));
    expect(messagesButton).toBeDefined();
    await user.click(messagesButton!);

    await waitFor(() => {
      expect(screen.getByText("Send the report")).toBeInTheDocument();
    });
  });
});

function channel(overrides: Partial<TestChannel> = {}): TestChannel {
  return {
    id: "channel-1",
    name: "Channel",
    platform: "telegram",
    enabled: true,
    status: "connected",
    config: {},
    createdAt: Date.now(),
    messageCount: 0,
    ...overrides,
  };
}
