/**
 * REST route tests for the config-doc export endpoints.
 *
 * Covers:
 *   GET /task-templates/:id/export           (single template)
 *   GET /config-doc/export?ids=a,b           (multi-id with dedup)
 *
 * These tests MUST fail before Task 5-impl (route 404).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { taskTemplateRoutes } from "../../server/routes/task-templates.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { createRole as createRoleFn } from "../../store/roles.js";
import type { BreeEngine } from "../../scheduler/bree-engine.js";

const { cleanup } = setupTestDb();
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());
beforeEach(() => clearTestDb());

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

function makeRole(id: string, name: string) {
  return {
    id,
    name,
    cagPrompt: "x",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: `mem-${id}`,
    status: "active" as const,
    preferences: {},
    createdAt: 1,
  };
}

describe("REST /task-templates/:id/export", () => {
  it("returns 200 with rendered doc + inventory for an existing template", async () => {
    const role = makeRole("r1", "ExportRole");
    createRoleFn(role);
    const tpl = {
      id: "t-exp",
      name: "ExportTpl",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "do it", roleId: "r1" }],
    };
    createTaskTemplate(tpl);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/task-templates/t-exp/export",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("config-doc");
    expect(typeof body.doc).toBe("string");
    expect(body.inventory).toBeDefined();
    // Header has the template id
    expect(body.doc).toContain("t-exp");
    // Closure has the role
    expect(body.doc).toContain("r1");
  });

  it("returns 404 for an unknown template id", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/task-templates/does-not-exist/export",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("REST /config-doc/export?ids=", () => {
  it("returns a deduped doc for multiple ids sharing roles", async () => {
    const role = makeRole("r-shared", "Shared");
    createRoleFn(role);
    const t1 = {
      id: "t-multi-1",
      name: "T1",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "p1", roleId: "r-shared" }],
    };
    const t2 = {
      id: "t-multi-2",
      name: "T2",
      trigger: { type: "manual" as const },
      enabled: true,
      createdAt: 1,
      steps: [{ id: "s1", prompt: "p2", roleId: "r-shared" }],
    };
    createTaskTemplate(t1);
    createTaskTemplate(t2);

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/config-doc/export?ids=t-multi-1,t-multi-2",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.format).toBe("config-doc");
    expect(typeof body.doc).toBe("string");
    // Both templates present
    expect(body.doc).toContain("t-multi-1");
    expect(body.doc).toContain("t-multi-2");
    // Role appears once in the closure (not duplicated across N templates)
    const closureOccurrences = (body.doc.match(/## role r-shared/g) ?? []).length;
    expect(closureOccurrences).toBe(1);
  });

  it("returns 404 when any of the requested ids is missing", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/config-doc/export?ids=missing-id",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});
