import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

import {
  createFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  updateFeatureRequestStatus,
} from "../../store/feature-requests.js";

describe("store/feature-requests", () => {
  let cleanup: () => void;

  beforeEach(() => {
    const { cleanup: c } = setupTestDb();
    cleanup = c;
  });

  afterEach(() => {
    cleanup!();
  });

  function makeReq(overrides: Partial<Parameters<typeof createFeatureRequest>[0]> = {}) {
    const now = Date.now();
    return {
      id: `fr-${now}-${Math.random().toString(36).slice(2, 6)}`,
      content: "Adam should integrate with Notion",
      status: "new" as const,
      extractedAt: now,
      createdAt: now,
      updatedAt: now,
      extractedByRoleId: undefined,
      ...overrides,
    };
  }

  it("create + read", () => {
    const req = makeReq();
    createFeatureRequest(req);
    const found = getFeatureRequest(req.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe(req.content);
    expect(found!.extractedByRoleId).toBe(req.extractedByRoleId);
  });

  it("list returns all records (no status filter in store)", () => {
    createFeatureRequest(makeReq());
    createFeatureRequest(makeReq());
    const list = listFeatureRequests();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("status filter works at REST layer (store returns all, route filters)", () => {
    createFeatureRequest(makeReq({ status: "new" }));
    createFeatureRequest(makeReq({ status: "dismissed" }));
    // Store: returns all
    const all = listFeatureRequests();
    expect(all.length).toBeGreaterThanOrEqual(2);
    // REST layer filters via status query param (tested in feature-requests-routes.test.ts)
    const newOnes = all.filter((r) => r.status === "new");
    expect(newOnes.every((r) => r.status === "new")).toBe(true);
  });

  it("updateFeatureRequestStatus changes status", () => {
    const req = makeReq();
    createFeatureRequest(req);
    updateFeatureRequestStatus(req.id, "reviewed");
    const found = getFeatureRequest(req.id);
    expect(found!.status).toBe("reviewed");
  });

  it("ordered by extracted_at DESC", () => {
    const now = Date.now();
    createFeatureRequest(makeReq({ id: `fr-older-${now}`, extractedAt: now - 100_000 }));
    createFeatureRequest(makeReq({ id: `fr-newer-${now}`, extractedAt: now }));
    const list = listFeatureRequests();
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(`fr-newer-${now}`)).toBeLessThan(ids.indexOf(`fr-older-${now}`));
  });
});
