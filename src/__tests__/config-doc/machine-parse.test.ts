/**
 * Tests for `parsePortableConfig(text)` in the config-doc parser.
 *
 * The machine block carries the structured portable config (templates + roles)
 * in a fenced JSON region. The parser must:
 *  - return the structured config
 *  - throw on missing marker, malformed JSON, prototype-pollution keys,
 *    an `__anchor` id not in the doc's anchors, and a step `roleId` not
 *    in the doc's roles.
 *  - keep the existing `getAnchorBytes` and `parseConfigDoc` behavior intact
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupTestDb, clearTestDb, getTestDb } from "../helpers/test-db.js";
import { createRole } from "../../store/roles.js";
import { createTaskTemplate } from "../../store/task-templates.js";
import { renderConfigDoc } from "../../store/config-doc/renderer.js";
import { parseConfigDoc, parsePortableConfig } from "../../store/config-doc/parser.js";
import type { Role, TaskTemplate, TaskStep } from "../../shared/types.js";

const { cleanup } = setupTestDb();

vi.mock("../../store/db.js", () => ({
  getDb: () => getTestDb(),
  closeDb: () => {},
}));

afterAll(() => cleanup());

let tmpExistingPath: string;

beforeEach(() => {
  clearTestDb();
  tmpExistingPath = mkdtempSync(join(tmpdir(), "adam-machine-parse-"));
});

function makeRole(): Role {
  return {
    id: "role-r1",
    name: "审慎者",
    cagPrompt: "CAG prompt with `<!-- /adam:field -->`.",
    learnedRules: { stylePreferences: [], avoidedActions: [], pinnedParameters: [] },
    memoryStreamId: "mem-r1",
    status: "active",
    preferences: {},
    createdAt: 1700000000000,
    skills: ["synth-auto"],
  };
}

function makeTemplate(): TaskTemplate {
  const s0: TaskStep = { id: "s-0", prompt: "setup", roleId: "role-r1" };
  const s1: TaskStep = {
    id: "s-1",
    prompt: "do thing",
    roleId: "role-r1",
    dependsOn: ["s-0"],
    minDependencies: 1,
    outputAs: "out-1",
    autoSelectRole: false,
    persona: { speakAs: "narrator" },
  };
  return {
    id: "tpl-x",
    name: "TestPipeline",
    trigger: { type: "manual" },
    steps: [s0, s1],
    enabled: true,
    createdAt: 1700000000000,
  };
}

describe("parsePortableConfig — happy path", () => {
  it("returns the structured config with sourceIds, anchor refs, and ${TOKEN}s", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);

    const config = parsePortableConfig(text);
    expect(config.templates).toHaveLength(1);
    expect(config.roles).toHaveLength(1);
    expect(config.templates[0].sourceId).toBe(tpl.id);
    expect(config.roles[0].sourceId).toBe(role.id);
    expect(config.roles[0].cagPrompt).toEqual({ __anchor: `role.${role.id}.cagPrompt` });
    expect(config.templates[0].steps[1].prompt).toEqual({ __anchor: `template.${tpl.id}.step.s-1.prompt` });
    expect(config.templates[0].steps[1].roleId).toBe(role.id);
  });

  it("anchor bytes are still extractable from the same doc (back-compat)", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);

    const parsed = parseConfigDoc(text);
    const cagBytes = parsed.getAnchorBytes(`role.${role.id}.cagPrompt`);
    expect(cagBytes.toString("utf8")).toBe(role.cagPrompt);
  });
});

describe("parsePortableConfig — failure modes", () => {
  it("throws when the machine block marker is missing", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);
    // Strip the machine block (open + close + interior)
    const stripped = text.replace(/<!-- adam:machine -->[\s\S]*?<!-- \/adam:machine -->/g, "");
    expect(() => parsePortableConfig(stripped)).toThrow(/machine block/);
  });

  it("throws when the machine block JSON is malformed", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);
    // Replace the interior JSON with garbage (preserve the fence)
    const corrupted = text.replace(/```json\n[\s\S]*?\n```/, "```json\n{not valid json}\n```");
    expect(() => parsePortableConfig(corrupted)).toThrow(/JSON|parse/);
  });

  it("throws when an __anchor id is not in the doc's anchors", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);
    // Replace the anchor id with a bogus one (the machine JSON is pretty-
    // printed with `JSON.stringify(..., null, 2)` so there is a space after
    // the colon — match that exact shape).
    const corrupted = text.replace(
      `"__anchor": "role.${role.id}.cagPrompt"`,
      `"__anchor": "role.${role.id}.cagPrompt.NONEXISTENT"`,
    );
    expect(() => parsePortableConfig(corrupted)).toThrow(/anchor .* not found/);
  });

  it("throws when a step roleId is not in the doc's roles", () => {
    const role = makeRole();
    const tpl = makeTemplate();
    createRole(role);
    createTaskTemplate(tpl);
    const text = renderConfigDoc([tpl.id]);
    // Replace a step roleId with a non-existent one (pretty-printed JSON
    // → space after the colon).
    const corrupted = text.replace(
      `"roleId": "${role.id}"`,
      `"roleId": "role-bogus"`,
    );
    expect(() => parsePortableConfig(corrupted)).toThrow(/roleId .* not in doc roles|dangling/);
  });
});
