/**
 * Tests for chat-artifact-publisher.ts — registerChatSentArtifact.
 * Task 3-tests — these FAIL before Task 3-impl (Cannot find module).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  })),
}));

import { listArtifactsByChatSession } from "../../store/artifacts.js";
import { registerChatSentArtifact } from "../../manager/chat-artifact-publisher.js";

let tmpRoot: string;

function seedChatSession(id: string) {
  getTestDb().prepare(
    `INSERT OR IGNORE INTO chat_sessions (id, status, source_type, created_at, last_active_at)
     VALUES (?, 'active', 'web', ?, ?)`,
  ).run(id, Date.now(), Date.now());
}

beforeEach(() => {
  clearTestDb();
  vi.clearAllMocks();
  warnSpy.mockClear();
  tmpRoot = mkdtempSync(join(tmpdir(), "adam-chat-pub-test-"));
  process.env.ADAM_TEST_DIR = tmpRoot;
});

afterAll(() => {
  delete process.env.ADAM_TEST_DIR;
  cleanup();
});

// Case A — happy path
describe("registerChatSentArtifact — happy path (case A)", () => {
  it("creates chat_sent artifact row with correct fields and blob on disk", async () => {
    seedChatSession("sess-1");
    const filePath = join(tmpRoot, "foo.txt");
    writeFileSync(filePath, "hello chat");

    await registerChatSentArtifact({
      mediaUrl: filePath,
      chatSessionId: "sess-1",
      roleId: "role-chat-manager",
      mime: "text/plain",
    });

    const rows = listArtifactsByChatSession("sess-1");
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.sourceKind).toBe("chat_sent");
    expect(row.chatSessionId).toBe("sess-1");
    expect(row.taskId).toBeUndefined();
    expect(row.executionId).toBeUndefined();
    expect(row.roleId).toBe("role-chat-manager");
    expect(row.originalFilename).toBe("foo.txt");
    expect(row.mime).toBe("text/plain");
    expect(row.blobPath).toBeDefined();
    expect(row.blobPath!.startsWith(join(tmpRoot, "artifacts", "chat"))).toBe(true);
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(typeof row.contentHash).toBe("string");
    expect(row.contentHash!.length).toBe(64); // sha256 hex
    expect(existsSync(row.blobPath!)).toBe(true);
  });
});

// Case B — chatSessionId undefined
describe("registerChatSentArtifact — chatSessionId undefined (case B)", () => {
  it("skips registration and logs warn with 'chatSessionId required'", async () => {
    const filePath = join(tmpRoot, "bar.txt");
    writeFileSync(filePath, "data");

    await registerChatSentArtifact({
      mediaUrl: filePath,
      chatSessionId: undefined,
      roleId: "role-chat-manager",
    });

    expect(listArtifactsByChatSession("sess-missing").length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArgs = warnSpy.mock.calls[0];
    expect(JSON.stringify(warnArgs)).toMatch(/chatSessionId required/i);
  });
});

// Case C — mediaUrl outside adam runtime
describe("registerChatSentArtifact — mediaUrl outside adam runtime (case C)", () => {
  it("skips registration and logs warn with 'outside adam runtime'", async () => {
    const outsideFile = join(tmpdir(), `outside-adam-chat-test-${Date.now()}.bin`);
    writeFileSync(outsideFile, "outside");

    await registerChatSentArtifact({
      mediaUrl: outsideFile,
      chatSessionId: "sess-c",
      roleId: "role-chat-manager",
    });

    expect(listArtifactsByChatSession("sess-c").length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArgs = warnSpy.mock.calls[0];
    expect(JSON.stringify(warnArgs)).toMatch(/outside adam runtime/i);

    // Cleanup
    try { rmSync(outsideFile); } catch { /* ignore */ }
  });
});

// Case D — mediaUrl does not exist
describe("registerChatSentArtifact — mediaUrl not found (case D)", () => {
  it("skips registration and logs warn with 'not found'", async () => {
    const nonexistentPath = join(tmpRoot, "nonexistent.bin");
    // Do NOT create the file

    await registerChatSentArtifact({
      mediaUrl: nonexistentPath,
      chatSessionId: "sess-d",
      roleId: "role-chat-manager",
    });

    expect(listArtifactsByChatSession("sess-d").length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArgs = warnSpy.mock.calls[0];
    expect(JSON.stringify(warnArgs)).toMatch(/not found/i);
  });
});

// Case E — createArtifact throws; blob should be unlinked, function does NOT throw
describe("registerChatSentArtifact — createArtifact throws (case E)", () => {
  it("rolls back blob and logs warn; does not throw", async () => {
    const filePath = join(tmpRoot, "case-e.txt");
    writeFileSync(filePath, "rollback test");

    seedChatSession("sess-e");
    const artifactsModule = await import("../../store/artifacts.js");
    const spy = vi.spyOn(artifactsModule, "createArtifact").mockImplementationOnce(() => {
      throw new Error("DB constraint violation");
    });

    let blobPath: string | undefined;
    // Capture blob path by checking directory after attempted write
    const chatDir = join(tmpRoot, "artifacts", "chat");

    await expect(
      registerChatSentArtifact({
        mediaUrl: filePath,
        chatSessionId: "sess-e",
        roleId: "role-chat-manager",
      }),
    ).resolves.toBeUndefined(); // must NOT throw

    expect(listArtifactsByChatSession("sess-e").length).toBe(0);
    expect(warnSpy).toHaveBeenCalledOnce();

    // Blob must have been cleaned up — no .bin files remain
    if (existsSync(chatDir)) {
      const { readdirSync } = await import("node:fs");
      const bins = readdirSync(chatDir).filter((f: string) => f.endsWith(".bin"));
      expect(bins.length).toBe(0);
    }

    spy.mockRestore();
  });
});

// Case F — concurrent calls produce separate rows
describe("registerChatSentArtifact — concurrent calls (case F)", () => {
  it("both succeed; two distinct artifact rows with unique blobPaths", async () => {
    seedChatSession("sess-f");
    const filePath = join(tmpRoot, "concurrent.bin");
    writeFileSync(filePath, "concurrent test data");

    await Promise.all([
      registerChatSentArtifact({ mediaUrl: filePath, chatSessionId: "sess-f", roleId: "role-chat-manager" }),
      registerChatSentArtifact({ mediaUrl: filePath, chatSessionId: "sess-f", roleId: "role-chat-manager" }),
    ]);

    const rows = listArtifactsByChatSession("sess-f");
    expect(rows.length).toBe(2);
    const blobPaths = rows.map((r) => r.blobPath);
    expect(blobPaths[0]).not.toBe(blobPaths[1]); // uuidv4 guarantees uniqueness
  });
});

// Case G — mime absent
describe("registerChatSentArtifact — mime absent (case G)", () => {
  it("artifact row has mime=undefined", async () => {
    seedChatSession("sess-g");
    const filePath = join(tmpRoot, "no-mime.bin");
    writeFileSync(filePath, "no mime");

    await registerChatSentArtifact({
      mediaUrl: filePath,
      chatSessionId: "sess-g",
      roleId: "role-chat-manager",
    });

    const rows = listArtifactsByChatSession("sess-g");
    expect(rows.length).toBe(1);
    expect(rows[0].mime).toBeUndefined();
  });
});
