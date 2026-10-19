import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api/artifacts module before importing the store
vi.mock("@/lib/api/artifacts.ts", () => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  redeliverArtifact: vi.fn(),
  downloadArtifactBlob: vi.fn(),
  artifactBlobUrl: vi.fn((id: string) => `/artifacts/${id}/blob`),
}));

import { listArtifacts, getArtifact } from "@/lib/api/artifacts.ts";
import { useArtifactsStore } from "@/store/artifactsSlice.ts";
import type { Artifact, DeliveryLogEntry } from "@/lib/types.ts";

const mockListArtifacts = vi.mocked(listArtifacts);
const mockGetArtifact = vi.mocked(getArtifact);

const makeArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "art-1",
  sourceKind: "task_published",
  taskId: "task-1",
  kind: "file",
  sizeBytes: 1024,
  createdAt: 1000000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the store to initial state
  useArtifactsStore.setState({
    list: [],
    total: 0,
    filter: { limit: 50, offset: 0 },
    selectedId: null,
    selectedDetail: null,
    loading: false,
    error: null,
  });
});

describe("useArtifactsStore", () => {
  it("load success — updates list and total", async () => {
    const artifacts = [makeArtifact(), makeArtifact({ id: "art-2" })];
    mockListArtifacts.mockResolvedValueOnce({ artifacts, total: 2 });

    await useArtifactsStore.getState().load();

    const state = useArtifactsStore.getState();
    expect(state.list).toHaveLength(2);
    expect(state.total).toBe(2);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("load failure — sets error, clears loading", async () => {
    mockListArtifacts.mockRejectedValueOnce(new Error("Network error"));

    await useArtifactsStore.getState().load();

    const state = useArtifactsStore.getState();
    expect(state.error).toBe("Network error");
    expect(state.loading).toBe(false);
    expect(state.list).toHaveLength(0);
  });

  it("applyFilter merges patch and resets offset to 0", async () => {
    mockListArtifacts.mockResolvedValue({ artifacts: [], total: 0 });

    await useArtifactsStore.getState().applyFilter({ mime_prefix: "audio/" });

    const state = useArtifactsStore.getState();
    expect(state.filter.mime_prefix).toBe("audio/");
    expect(state.filter.offset).toBe(0);
    expect(mockListArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ mime_prefix: "audio/", offset: 0 }),
    );
  });

  it("select fetches artifact detail and stores it", async () => {
    const artifact = makeArtifact();
    const deliveryLog: DeliveryLogEntry[] = [];
    mockGetArtifact.mockResolvedValueOnce({ artifact, deliveryLog });

    await useArtifactsStore.getState().select("art-1");

    const state = useArtifactsStore.getState();
    expect(state.selectedId).toBe("art-1");
    expect(state.selectedDetail?.artifact.id).toBe("art-1");
    expect(mockGetArtifact).toHaveBeenCalledWith("art-1");
  });

  it("select(null) clears selectedDetail without API call", async () => {
    await useArtifactsStore.getState().select(null);

    const state = useArtifactsStore.getState();
    expect(state.selectedId).toBeNull();
    expect(state.selectedDetail).toBeNull();
    expect(mockGetArtifact).not.toHaveBeenCalled();
  });

  it("error state is reset on new load call", async () => {
    // First load fails
    mockListArtifacts.mockRejectedValueOnce(new Error("fail"));
    await useArtifactsStore.getState().load();
    expect(useArtifactsStore.getState().error).toBe("fail");

    // Second load succeeds — error should clear
    mockListArtifacts.mockResolvedValueOnce({ artifacts: [], total: 0 });
    await useArtifactsStore.getState().load();
    expect(useArtifactsStore.getState().error).toBeNull();
  });
});
