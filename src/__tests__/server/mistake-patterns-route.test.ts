import { describe, it, expect, beforeEach, vi } from "vitest";
import fastify from "fastify";
import { mistakePatternsRoutes } from "../../server/routes/mistake-patterns.js";
import { setAuthKey } from "../../server/auth-key.js";
import { TEST_API_KEY } from "../helpers/test-auth.js";
import { setupTestDb, getTestDb } from "../helpers/test-db.js";

// Mock db so the store uses the test DB
vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

async function buildApp() {
  const app = fastify();
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url;
    if (url === "/healthz" || url === "/readyz" || url.startsWith("/docs") || url.startsWith("/ui")) return;
    const headerKey = request.headers["x-api-key"] as string | undefined;
    if (headerKey && headerKey === TEST_API_KEY) return;
    return reply.status(401).send({ code: "UNAUTHORIZED", message: "Invalid or missing API key" });
  });
  await app.register(mistakePatternsRoutes);
  await app.ready();
  return app;
}

/** Seed 3 patterns directly via the test DB (bypasses module mock complexity). */
function seedPatterns(): Array<{ id: string; status: string }> {
  const db = getTestDb();
  const now = Date.now();
  const statuses = ["acknowledged", "new", "dismissed"];
  const rows: Array<{ id: string; status: string }> = [];
  for (let i = 0; i < 3; i++) {
    const id = `mp-test-${i}-${now}`;
    db.prepare(`
      INSERT INTO mistake_patterns
        (id, dimension_type, dimension_value, count, role_ids, sample_evidence_ids,
         status, first_seen, last_seen, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "event_type",
      `test-value-${i}`,
      i + 1,
      JSON.stringify([]),
      JSON.stringify([]),
      statuses[i],
      now - 1000,
      now,
      now,
      now,
    );
    rows.push({ id, status: statuses[i]! });
  }
  return rows;
}

describe("server/routes/mistake-patterns", () => {
  beforeEach(() => {
    setAuthKey(TEST_API_KEY);
  });

  it("GET /mistake-patterns returns all 3 seeded patterns", async () => {
    const { cleanup } = setupTestDb();
    try {
      seedPatterns();
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: "/mistake-patterns",
          headers: { "x-api-key": TEST_API_KEY },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body).toHaveProperty("mistakePatterns");
        expect(body.mistakePatterns).toHaveLength(3);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("GET /mistake-patterns?status=new returns only new patterns", async () => {
    const { cleanup } = setupTestDb();
    try {
      seedPatterns();
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: "/mistake-patterns?status=new",
          headers: { "x-api-key": TEST_API_KEY },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mistakePatterns).toHaveLength(1);
        expect(body.mistakePatterns[0].status).toBe("new");
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("GET /mistake-patterns/:id returns the pattern", async () => {
    const { cleanup } = setupTestDb();
    try {
      const seeded = seedPatterns();
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/mistake-patterns/${seeded[0]!.id}`,
          headers: { "x-api-key": TEST_API_KEY },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mistakePattern.id).toBe(seeded[0]!.id);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("GET /mistake-patterns/nonexistent returns 404", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: "/mistake-patterns/does-not-exist",
          headers: { "x-api-key": TEST_API_KEY },
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("PATCH /mistake-patterns/:id with valid status updates the row", async () => {
    const { cleanup } = setupTestDb();
    try {
      const db = getTestDb();
      const seeded = seedPatterns();
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/mistake-patterns/${seeded[1]!.id}`,
          headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
          payload: { status: "acknowledged" },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.ok).toBe(true);
        expect(body.status).toBe("acknowledged");

        // Verify DB was updated
        const row = db.prepare("SELECT status FROM mistake_patterns WHERE id = ?").get(seeded[1]!.id) as { status: string } | undefined;
        expect(row?.status).toBe("acknowledged");
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("PATCH /mistake-patterns/:id with invalid status returns 400", async () => {
    const { cleanup } = setupTestDb();
    try {
      const seeded = seedPatterns();
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/mistake-patterns/${seeded[0]!.id}`,
          headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
          payload: { status: "INVALID" },
        });
        expect(response.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });

  it("PATCH /mistake-patterns/nonexistent returns 404", async () => {
    const { cleanup } = setupTestDb();
    try {
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "PATCH",
          url: "/mistake-patterns/does-not-exist",
          headers: { "x-api-key": TEST_API_KEY, "Content-Type": "application/json" },
          payload: { status: "acknowledged" },
        });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    } finally {
      cleanup();
    }
  });
});
