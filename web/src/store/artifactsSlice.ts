import { create } from "zustand";
import {
  listArtifacts,
  getArtifact,
  type ArtifactFilter,
  type ArtifactListResponse,
  type ArtifactDetailResponse,
} from "@/lib/api/artifacts.ts";
import type { Artifact } from "@/lib/types.ts";

interface ArtifactsState {
  list: Artifact[];
  total: number;
  filter: ArtifactFilter;
  selectedId: string | null;
  selectedDetail: ArtifactDetailResponse | null;
  loading: boolean;
  error: string | null;
}

interface ArtifactsActions {
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  applyFilter: (patch: Partial<ArtifactFilter>) => Promise<void>;
}

type ArtifactsStore = ArtifactsState & ArtifactsActions;

export const useArtifactsStore = create<ArtifactsStore>((set, get) => ({
  list: [],
  total: 0,
  filter: { limit: 50, offset: 0 },
  selectedId: null,
  selectedDetail: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result: ArtifactListResponse = await listArtifacts(get().filter);
      set({ list: result.artifacts, total: result.total, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  refresh: async () => {
    return get().load();
  },

  select: async (id: string | null) => {
    set({ selectedId: id, selectedDetail: null });
    if (!id) return;
    try {
      const detail: ArtifactDetailResponse = await getArtifact(id);
      set({ selectedDetail: detail });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  applyFilter: async (patch: Partial<ArtifactFilter>) => {
    const newFilter = { ...get().filter, ...patch, offset: 0 };
    set({ filter: newFilter });
    return get().load();
  },
}));
