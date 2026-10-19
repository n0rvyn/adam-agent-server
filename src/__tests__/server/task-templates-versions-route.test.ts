/**
 * REST route tests for the template-version endpoints (Phase 0.5).
 *
 * Covers the full HTTP surface added in Task 5:
 *   GET    /task-templates/:id/versions
 *   GET    /task-templates/:id/versions/:v
 *   GET    /task-templates/:id/versions/diff?a=&b=
 *   POST   /task-templates/:id/versions/:v/restore
 *
 * Live mini-e2e (edit via ChatManager on :7100, then restore via WebUI)
 * is deploy-deferred — these tests validate the contract in isolation.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { taskTemplateRoutes } from "../../server/routes/task-templates.js";
import { createTaskTemplate, updateTaskTemplate } from "../../store/task-templates.js";
import type { BreeEngine } from "../../scheduler/bree-engine.js";
import type { TaskTemplate } from "../../shared/types.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

/**
 * Build a minimal Fastify app with auth + the task-template routes registered.
 * A no-op BreeEngine stub is supplied — the version routes don't touch the
 * scheduler, but the routes function signature requires it.
 */
async function buildApp() {
  const app = fastify();
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui"))
      return;
    const headerKey = request.headers["x-api-key"] as string | undefined;
    if (headerKey && headerKey === TEST_API_KEY) return;
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
  });
  const stubBree = {} as BreeEngine;
  await app.register(taskTemplateRoutes, stubBree);
  await app.ready();
  return app;
}

function authHeaders(): Record<string, string> {
  return { "x-api-key": TEST_API_KEY };
}

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: overrides.id ?? "tmpl-rest-1",
    name: overrides.name ?? "Test Template",
    description: overrides.description,
    trigger: overrides.trigger ?? { type: "manual" },
    steps: overrides.steps ?? [{ id: "s1", prompt: "Do something" }],
    rolePreference: overrides.rolePreference ?? "role-test-seed",
    config: overrides.config,
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt,
  };
}

describe("REST /task-templates/:id/versions", () => {
  describe("GET /task-templates/:id/versions", () => {
    it("returns 404 when template not found", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/does-not-exist/versions",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe("NOT_FOUND");
    });

    it("returns 200 with empty versions array for a freshly created template", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-fresh" }));
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-fresh/versions",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.templateId).toBe("tmpl-fresh");
      expect(body.count).toBe(0);
      expect(body.versions).toEqual([]);
    });

    it("returns version summaries (newest first) after content updates", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-v1", name: "Original" }));
      updateTaskTemplate("tmpl-v1", { name: "Renamed" });
      updateTaskTemplate("tmpl-v1", { name: "Renamed again" });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-v1/versions",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(2);
      expect(body.versions).toHaveLength(2);
      expect(body.versions[0].versionNo).toBe(2);
      expect(body.versions[0].reason).toBe("update");
      expect(body.versions[0].snapshotName).toBe("Renamed");
      expect(body.versions[1].versionNo).toBe(1);
      expect(body.versions[1].snapshotName).toBe("Original");
    });
  });

  describe("GET /task-templates/:id/versions/:v", () => {
    it("returns 404 for a non-existent version", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-sv" }));
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-sv/versions/99",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns the full snapshot for a valid version", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-snap", name: "Original", steps: [{ id: "s1", prompt: "first" }] }));
      updateTaskTemplate("tmpl-snap", { name: "Renamed" });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-snap/versions/1",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.versionNo).toBe(1);
      expect(body.reason).toBe("update");
      expect(body.snapshot.name).toBe("Original");
      expect(body.snapshot.steps).toEqual([{ id: "s1", prompt: "first" }]);
    });
  });

  describe("GET /task-templates/:id/versions/diff", () => {
    it("returns 400 when query params are missing", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-d" }));
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-d/versions/diff",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns field-level changes between two versions", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-diff-rest", name: "Alpha" }));
      updateTaskTemplate("tmpl-diff-rest", { name: "Beta" });
      // Need at least 2 distinct updates to have v1 and v2.
      updateTaskTemplate("tmpl-diff-rest", { name: "Gamma" });

      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-diff-rest/versions/diff?a=1&b=2",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.a).toBe(1);
      expect(body.b).toBe(2);
      expect(body.changeCount).toBeGreaterThan(0);
      const nameChange = body.changes.find((c: { path: string }) => c.path === "name");
      expect(nameChange).toBeDefined();
      expect(nameChange.before).toBe("Alpha");
      expect(nameChange.after).toBe("Beta");
    });
  });

  describe("POST /task-templates/:id/versions/:v/restore", () => {
    it("returns 404 for a non-existent version", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-r404" }));
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates/tmpl-r404/versions/99/restore",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it("non-destructively restores: pre-restore state captured as new version, content reverts", async () => {
      createTaskTemplate(makeTemplate({ id: "tmpl-restore", name: "A" }));
      updateTaskTemplate("tmpl-restore", { name: "B" });
      updateTaskTemplate("tmpl-restore", { name: "C" });

      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/task-templates/tmpl-restore/versions/1/restore",
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.restoredFromVersion).toBe(1);
      expect(body.preRestoreVersionNo).toBe(2); // max version before restore
      expect(body.currentName).toBe("A"); // reverted content

      // History preserved: now we should have v3 (pre-restore snapshot) + v2 + v1.
      const listRes = await app.inject({
        method: "GET",
        url: "/task-templates/tmpl-restore/versions",
        headers: authHeaders(),
      });
      const listBody = listRes.json();
      expect(listBody.count).toBe(3);
      expect(listBody.versions[0].versionNo).toBe(3);
      expect(listBody.versions[0].reason).toBe("restore");
      expect(listBody.versions[0].snapshotName).toBe("C");
    });
  });
});
