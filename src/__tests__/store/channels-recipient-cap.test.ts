/**
 * Task 5-tests: channels.recipient_cap_map schema + store helpers
 *
 * Tests FAIL before Task 5-impl because getRecipientCap / setRecipientCap don't exist yet.
 * Expected fail signal: "is not a function" or "is not exported" on getRecipientCap / setRecipientCap.
 *
 * After Task 5-impl: 7/7 pass.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDbRef(),
}));

let dbRef: ReturnType<typeof setupTestDb>["db"];
function getTestDbRef() { return dbRef; }

import { createChannel, getRecipientCap, setRecipientCap } from "../../store/channels.js";
import type { Channel } from "../../shared/types.js";

const MB = 1024 * 1024;

function makeChannel(id: string): Channel {
  return {
    id,
    name: `Test Channel ${id}`,
    platform: "email",
    enabled: true,
    status: "connected",
    config: { smtpHost: "smtp.example.com" },
    createdAt: Date.now(),
    messageCount: 0,
  };
}

beforeAll(() => {
  const { db } = setupTestDb();
  dbRef = db;
});

afterAll(() => {
  dbRef.close();
});

beforeEach(() => {
  clearTestDb();
});

// Case A: schema columns present
describe("channels-recipient-cap — Case A: schema columns present", () => {
  it("recipient_cap_map_json and default_recipient_cap_bytes columns exist", () => {
    const cols = dbRef.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("recipient_cap_map_json");
    expect(names).toContain("default_recipient_cap_bytes");
  });
});

// Case B: getRecipientCap returns 20 MB when channel has no cap_map and no default
describe("channels-recipient-cap — Case B: fallback to 20 MB hard default", () => {
  it("returns 20971520 when no cap_map and no default set", () => {
    const ch = makeChannel("ch-b1");
    createChannel(ch);
    const cap = getRecipientCap("ch-b1", "qq.com");
    expect(cap).toBe(20 * MB); // 20_971_520
  });
});

// Case C: getRecipientCap falls through to hard default when domain not in map
describe("channels-recipient-cap — Case C: domain not in map falls to default", () => {
  it("returns hard default when domain not in map and no channel default set", () => {
    const ch = makeChannel("ch-c1");
    createChannel(ch);
    // Set 163.com cap, then query qq.com → should return 20MB hard default
    setRecipientCap("ch-c1", "163.com", 50 * MB);
    const cap = getRecipientCap("ch-c1", "qq.com");
    expect(cap).toBe(20 * MB);
  });
});

// Case D: getRecipientCap returns domain-specific value when present
describe("channels-recipient-cap — Case D: domain-specific cap returned", () => {
  it("returns qq.com-specific cap when set", () => {
    const ch = makeChannel("ch-d1");
    createChannel(ch);
    setRecipientCap("ch-d1", "qq.com", 18 * MB);
    const cap = getRecipientCap("ch-d1", "qq.com");
    expect(cap).toBe(18 * MB);
  });
});

// Case E: setting two different domains doesn't lose either
describe("channels-recipient-cap — Case E: multiple domains coexist", () => {
  it("qq.com cap is preserved after setting 163.com cap", () => {
    const ch = makeChannel("ch-e1");
    createChannel(ch);
    setRecipientCap("ch-e1", "qq.com", 18 * MB);
    setRecipientCap("ch-e1", "163.com", 50 * MB);
    expect(getRecipientCap("ch-e1", "qq.com")).toBe(18 * MB);
    expect(getRecipientCap("ch-e1", "163.com")).toBe(50 * MB);
  });
});

// Case F: setRecipientCap rejects values outside [1MB, 200MB]
describe("channels-recipient-cap — Case F: bounds validation", () => {
  it("throws RangeError for cap=0", () => {
    const ch = makeChannel("ch-f1");
    createChannel(ch);
    expect(() => setRecipientCap("ch-f1", "qq.com", 0)).toThrow(RangeError);
  });

  it("throws RangeError for cap=300MB (above 200MB max)", () => {
    const ch = makeChannel("ch-f2");
    createChannel(ch);
    expect(() => setRecipientCap("ch-f2", "qq.com", 300 * MB)).toThrow(RangeError);
  });
});

// Case G: Malformed recipient_cap_map_json on read → log warn + return default (no throw)
describe("channels-recipient-cap — Case G: malformed cap_map JSON falls through to default", () => {
  it("returns hard default and does not throw when cap_map_json is malformed", () => {
    const ch = makeChannel("ch-g1");
    createChannel(ch);
    // Directly corrupt the JSON in the DB
    dbRef.prepare("UPDATE channels SET recipient_cap_map_json = ? WHERE id = ?").run("NOT_JSON{{{", "ch-g1");
    // Should not throw; returns 20MB hard default
    const cap = getRecipientCap("ch-g1", "qq.com");
    expect(cap).toBe(20 * MB);
  });
});
