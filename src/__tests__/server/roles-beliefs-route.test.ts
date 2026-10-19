import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fastify from "fastify";
import { roleRoutes } from "../../server/routes/roles.js";
import { setAuthKey } from "../../server/auth-key.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();
setAuthKey(TEST_API_KEY);
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());

beforeEach(() => {
  clearTestDb();
});

async function buildApp() {
  const app = fastify();
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
    const headerKey = request.headers["x-api-key"] as string | undefined;
    if (headerKey && headerKey === TEST_API_KEY) return;
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
  });
  await app.register(roleRoutes);
  await app.ready();
  return app;
}

function seedRole(id = "role-1", name = "Test Role"): void {
  getTestDb().prepare(`
    INSERT INTO roles (id, name, cag_prompt, memory_stream_id, status, preferences, created_at, importance_trigger_curr)
    VALUES (?, ?, '', ?, 'active', '{}', ?, 150)
  `).run(id, name, `stream-${id}`, Date.now());
}

/**
 * v81-schema belief seed: no confidence/use_count/success_count/trial_count/delta_sum columns.
 */
function seedBelief(opts: {
  id: string;
  roleId: string;
  content?: string;
  successEma?: number;
  isAnti?: number;
  injectCount?: number;
  status?: string;
}): void {
  const {
    id,
    roleId,
    content = "test belief",
    successEma = 0.5,
    isAnti = 0,
    injectCount = 0,
    status = "active",
  } = opts;
  getTestDb().prepare(`
    INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
      created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
    VALUES (?, ?, ?, ?, '[]', ?, 0, ?, ?, ?, ?)
  `).run(id, roleId, content, isAnti, Date.now(), Date.now(), status, successEma, injectCount);
}

describe("GET /roles/:id/beliefs", () => {
  it("returns_404_for_unknown_role", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/nonexistent-role-id/beliefs",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "role_not_found" });
    await app.close();
  });

  it("returns_beliefs_sorted_by_successEma_DESC", async () => {
    seedRole("role-test", "Sorted Role");
    seedBelief({ id: "b-low", roleId: "role-test", content: "Low ema belief", successEma: 0.3 });
    seedBelief({ id: "b-high", roleId: "role-test", content: "High ema belief", successEma: 0.9 });
    seedBelief({ id: "b-mid", roleId: "role-test", content: "Mid ema belief", successEma: 0.6 });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/role-test/beliefs",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { beliefs, count } = res.json() as { beliefs: Array<{ content: string; successEma: number }>; count: number };
    expect(count).toBe(3);
    // v3: sorted by successEma DESC
    expect(beliefs[0].successEma).toBeCloseTo(0.9, 2);
    expect(beliefs[1].successEma).toBeCloseTo(0.6, 2);
    expect(beliefs[2].successEma).toBeCloseTo(0.3, 2);
    await app.close();
  });

  it("strips_embedding_bytes", async () => {
    seedRole("role-embed", "Embed Role");
    const now = Date.now();
    // Insert a belief row with an actual embedding blob
    getTestDb().prepare(`
      INSERT INTO beliefs (id, role_id, content, is_anti, evidence_obs_ids,
        embedding, created_at, last_used_at, last_validated_at, status, success_ema, inject_count)
      VALUES (?, ?, ?, ?, '[]', ?, ?, 0, ?, 'active', 0.6, 0)
    `).run(
      "b-embed",
      "role-embed",
      "Belief with embedding",
      0,
      Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
      now,
      now,
    );

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/role-embed/beliefs",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { beliefs } = res.json() as { beliefs: Record<string, unknown>[] };
    expect(beliefs.length).toBe(1);
    expect(beliefs[0]).not.toHaveProperty("embedding");
    expect(beliefs[0]).toHaveProperty("content");
    await app.close();
  });

  it("includeAnti_false_excludes_anti_pattern_beliefs", async () => {
    seedRole("role-anti", "Anti Role");
    seedBelief({ id: "b-normal", roleId: "role-anti", content: "Normal belief", isAnti: 0 });
    seedBelief({ id: "b-anti", roleId: "role-anti", content: "Anti-pattern belief", isAnti: 1 });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/role-anti/beliefs?includeAnti=false",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { beliefs, count } = res.json() as { beliefs: Array<{ isAnti: boolean }>; count: number };
    expect(count).toBe(1);
    expect(beliefs[0].isAnti).toBe(false);
    await app.close();
  });

  it("limit_query_param_clamps_to_500", async () => {
    seedRole("role-many", "Many Beliefs Role");
    for (let i = 0; i < 600; i++) {
      seedBelief({ id: `b-${i}`, roleId: "role-many", content: `Belief ${i}`, successEma: 0.5 });
    }

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/roles/role-many/beliefs?limit=1000",
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const { beliefs, count } = res.json() as { beliefs: unknown[]; count: number };
    expect(count).toBe(500);
    expect(beliefs.length).toBe(500);
    await app.close();
  });
});
