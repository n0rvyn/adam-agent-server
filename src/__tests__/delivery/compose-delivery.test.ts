/**
 * Unit tests for the delivery composer (src/delivery/compose-delivery.ts).
 * Covers: no-manifest → null; manifest body/title/attachments resolution;
 * filename rendering ({date}-{title}); missing-title fallback to original name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/artifacts.js", () => ({
  listArtifactsByExecution: vi.fn((id: string) => artifactRows.filter((r) => r.executionId === id)),
}));

const executionRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/template-executions.js", () => ({
  getTemplateExecution: vi.fn((id: string) => executionRows.find((r) => r.id === id)),
}));

const templateRows: Array<Record<string, unknown>> = [];
vi.mock("../../store/task-templates.js", () => ({
  getTaskTemplate: vi.fn((id: string) => templateRows.find((r) => r.id === id)),
}));

import { readFileSync } from "node:fs";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

import { composeDeliveryFromManifest } from "../../delivery/compose-delivery.js";

// Jun 2 2026, local — formatDate uses local components, so this yields "2026-06-02" in any tz.
const STARTED_AT = new Date(2026, 5, 2, 12, 0, 0).getTime();

function seedEveningExecution(manifest: unknown) {
  executionRows.push({ id: "exec-1", templateId: "tmpl-1", startedAt: STARTED_AT });
  templateRows.push({
    id: "tmpl-1",
    name: "晚间播客流水线",
    steps: [
      { id: "定稿", outputAs: "定稿结果" },
      { id: "audio", outputAs: "audio-files" },
    ],
    config: { delivery: { mode: "primary-artifact", payload: manifest } },
  });
  artifactRows.push({ id: "fin", executionId: "exec-1", stepId: "定稿", key: "定稿结果", kind: "file", blobPath: "/tmp/final.md", mime: "text/markdown", originalFilename: "定稿-晚间_20260602.md", sizeBytes: 21000, createdAt: STARTED_AT + 1000 });
  artifactRows.push({ id: "ttl", executionId: "exec-1", stepId: "定稿", key: "标题", kind: "json", value: { title: "鬼影执行" }, sizeBytes: 30, createdAt: STARTED_AT + 1001 });
  artifactRows.push({ id: "aud", executionId: "exec-1", stepId: "audio", key: "audio-files", kind: "file", blobPath: "/tmp/koubogao.mp3", mime: "audio/mp3", originalFilename: "koubogao.mp3", sizeBytes: 24000000, createdAt: STARTED_AT + 2000 });
}

beforeEach(() => {
  artifactRows.length = 0;
  executionRows.length = 0;
  templateRows.length = 0;
  vi.mocked(readFileSync).mockReset().mockReturnValue("# 2026年6月2日晚间综合播客文字稿\n\n晚上好，今天聊鬼影执行……");
});
afterEach(() => vi.clearAllMocks());

describe("composeDeliveryFromManifest", () => {
  it("returns null when the template declares no payload manifest", () => {
    executionRows.push({ id: "exec-1", templateId: "tmpl-1", startedAt: STARTED_AT });
    templateRows.push({ id: "tmpl-1", name: "x", steps: [], config: { delivery: { mode: "primary-artifact" } } });
    expect(composeDeliveryFromManifest("exec-1")).toBeNull();
  });

  it("returns null when the execution is unknown", () => {
    expect(composeDeliveryFromManifest("nope")).toBeNull();
  });

  it("resolves body=full text, title=json field, 2 named+typed attachments", () => {
    seedEveningExecution({
      body: { step: "定稿" },
      title: { step: "定稿", key: "标题", field: "title" },
      attachments: [
        { step: "定稿", name: "{date}-{title}" },
        { step: "audio", name: "{date}-{title}" },
      ],
    });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out).not.toBeNull();
    expect(out!.content).toContain("晚上好，今天聊鬼影执行");
    expect(out!.attachments.map((a) => a.filename)).toEqual([
      "2026-06-02-鬼影执行.md",
      "2026-06-02-鬼影执行.mp3",
    ]);
    expect(out!.attachments.map((a) => a.mediaType)).toEqual(["file", "audio"]);
    // raw artifacts aligned 1:1 for the email packer
    expect(out!.artifacts.map((a) => a.id)).toEqual(["fin", "aud"]);
  });

  it("tolerates attachments wrapped as { item: [...] } from the ChatManager MCP config path", () => {
    seedEveningExecution({
      body: { step: "定稿" },
      title: { step: "定稿", key: "标题", field: "title" },
      // The MCP tool coerces JSON arrays into { item: [...] } — composer must handle it.
      attachments: { item: [{ step: "定稿", name: "{date}-{title}" }, { step: "audio", name: "{date}-{title}" }] },
    });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out!.attachments.map((a) => a.filename)).toEqual([
      "2026-06-02-鬼影执行.md",
      "2026-06-02-鬼影执行.mp3",
    ]);
  });

  it("tolerates DOUBLE-nested { item: { item: [...] } } (ChatManager re-edit wraps again)", () => {
    seedEveningExecution({
      body: { step: "定稿" },
      title: { step: "定稿", key: "标题", field: "title" },
      // Re-editing an already-{item:[...]} value nests it once more; composer must unwrap any depth.
      attachments: { item: { item: [{ step: "定稿", name: "{date}-{title}" }, { step: "audio", name: "{date}-{title}" }] } },
    });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out!.attachments.map((a) => a.filename)).toEqual([
      "2026-06-02-鬼影执行.md",
      "2026-06-02-鬼影执行.mp3",
    ]);
  });

  it("body literal text is used verbatim", () => {
    seedEveningExecution({
      body: { text: "固定正文" },
      attachments: [{ step: "audio" }],
    });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out!.content).toBe("固定正文");
    // no name template → original filename
    expect(out!.attachments[0].filename).toBe("koubogao.mp3");
  });

  it("missing title → {title} name falls back to original filename (no dangling separator)", () => {
    seedEveningExecution({
      body: { step: "定稿" },
      title: { step: "定稿", key: "标题-missing", field: "title" },
      attachments: [{ step: "audio", name: "{date}-{title}" }],
    });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out!.attachments[0].filename).toBe("koubogao.mp3");
  });

  it("materializes a JSON body field into a .md attachment (structured 定稿 {title, body})", () => {
    executionRows.push({ id: "exec-1", templateId: "tmpl-1", startedAt: STARTED_AT });
    templateRows.push({
      id: "tmpl-1",
      name: "晚间播客流水线",
      steps: [{ id: "定稿", outputAs: "定稿结果" }, { id: "audio", outputAs: "audio-files" }],
      config: { delivery: { mode: "primary-artifact", payload: {
        body: { step: "定稿", field: "body" },
        title: { step: "定稿", field: "title" },
        attachments: [
          { step: "定稿", field: "body", name: "{date}-{title}" },
          { step: "audio", name: "{date}-{title}" },
        ],
      } } },
    });
    artifactRows.push({ id: "fin", executionId: "exec-1", stepId: "定稿", key: "定稿结果", kind: "json", value: { title: "鬼影执行", body: "# 标题\n\n晚上好，今天聊鬼影执行……" }, sizeBytes: 200, createdAt: STARTED_AT + 1000 });
    artifactRows.push({ id: "aud", executionId: "exec-1", stepId: "audio", key: "audio-files", kind: "file", blobPath: "/tmp/koubogao.mp3", mime: "audio/mp3", originalFilename: "koubogao.mp3", sizeBytes: 24000000, createdAt: STARTED_AT + 2000 });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out).not.toBeNull();
    expect(out!.content).toBe("# 标题\n\n晚上好，今天聊鬼影执行……");
    expect(out!.content).not.toContain('"title"'); // body is the field, not a JSON dump
    expect(out!.attachments.map((a) => a.filename)).toEqual([
      "2026-06-02-鬼影执行.md",
      "2026-06-02-鬼影执行.mp3",
    ]);
    expect(out!.attachments[0].mediaType).toBe("file");
  });

  it("refuses to stringify a non-text JSON object into the body (no JSON dump shipped)", () => {
    executionRows.push({ id: "exec-1", templateId: "tmpl-1", startedAt: STARTED_AT });
    templateRows.push({
      id: "tmpl-1",
      name: "x",
      steps: [{ id: "定稿", outputAs: "定稿结果" }],
      config: { delivery: { mode: "primary-artifact", payload: { body: { step: "定稿" }, attachments: [] } } },
    });
    artifactRows.push({ id: "fin", executionId: "exec-1", stepId: "定稿", key: "定稿结果", kind: "json", value: { 选稿结果: { candidate_id: "稿-C" } }, sizeBytes: 50, createdAt: STARTED_AT + 1000 });
    const out = composeDeliveryFromManifest("exec-1");
    expect(out!.content).toBe("");
    expect(out!.content).not.toContain("candidate_id");
  });
});
