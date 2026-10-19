import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetTask, mockStreamManagerAdd } = vi.hoisted(() => ({
  mockGetTask: vi.fn(),
  mockStreamManagerAdd: vi.fn(),
}));

vi.mock("../../../store/tasks.js", () => ({
  getTask: mockGetTask,
}));

vi.mock("../../../server/ws/stream.js", () => ({
  streamManager: { addConnection: mockStreamManagerAdd },
}));

import { streamRoutes } from "../../../server/ws/route.js";
import { setAuthKey } from "../../../server/auth-key.js";
import { TEST_API_KEY } from "../../helpers/test-auth.js";

const authedRequest = (params: Record<string, string>) => ({
  params,
  headers: { "x-api-key": TEST_API_KEY },
  query: {},
});

describe("streamRoutes WebSocket handler", () => {
  let mockFastify: { get: ReturnType<typeof vi.fn> };
  let wsHandler: (socket: Record<string, unknown>, request: Record<string, unknown>) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuthKey(TEST_API_KEY);
    mockFastify = {
      get: vi.fn((_path: string, _opts: unknown, handler: typeof wsHandler) => {
        wsHandler = handler;
      }),
    };
  });

  it("registers /tasks/:id/stream WebSocket route", async () => {
    await streamRoutes(mockFastify as never);
    expect(mockFastify.get).toHaveBeenCalledWith(
      "/tasks/:id/stream",
      { websocket: true },
      expect.any(Function),
    );
  });

  it("closes socket with 1008 for invalid task ID", async () => {
    await streamRoutes(mockFastify as never);

    const mockSocket = { close: vi.fn() };
    wsHandler(mockSocket, authedRequest({ id: "not-a-uuid" }));

    expect(mockSocket.close).toHaveBeenCalledWith(1008, "Invalid task ID");
  });

  it("closes socket with 1008 for non-existent task", async () => {
    await streamRoutes(mockFastify as never);
    mockGetTask.mockReturnValue(undefined);

    const mockSocket = { close: vi.fn() };
    const validUuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    wsHandler(mockSocket, authedRequest({ id: validUuid }));

    expect(mockSocket.close).toHaveBeenCalledWith(1008, "Task not found");
  });

  it("closes socket with 4401 for unauthorized request", async () => {
    await streamRoutes(mockFastify as never);
    const mockSocket = { close: vi.fn() };
    wsHandler(mockSocket, {
      params: { id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" },
      headers: {},
      query: {},
    });
    expect(mockSocket.close).toHaveBeenCalledWith(4401, "Unauthorized");
  });

  it("adds connection to streamManager for valid task", async () => {
    await streamRoutes(mockFastify as never);
    mockGetTask.mockReturnValue({ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", status: "running" });

    const mockSocket = { close: vi.fn() };
    const validUuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    wsHandler(mockSocket, authedRequest({ id: validUuid }));

    expect(mockStreamManagerAdd).toHaveBeenCalledWith(validUuid, mockSocket);
    expect(mockSocket.close).not.toHaveBeenCalled();
  });
});
