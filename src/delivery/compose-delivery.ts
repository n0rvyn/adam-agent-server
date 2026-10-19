/**
 * Delivery payload composer.
 *
 * Turns an execution's artifacts + the template's declarative `delivery.payload` manifest
 * into a concrete outbound payload: { content (body), attachments[] (ready to ship) }.
 *
 * This is the ONLY place that knows how to map declared sources (step/key/field) to actual
 * body text, a title, and named+typed attachments. The send path (OutboundGateway) stays a
 * dumb pipe that ships whatever this returns. Both the live-completion path and the redelivery
 * path call this, so they produce identical payloads.
 *
 * Returns null when the template declares no `payload` manifest — callers then use the legacy
 * body (assembleSummary) + all-file-attachments behavior, leaving non-manifest templates
 * completely unchanged.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { getLogger } from "../lib/logger.js";
import { getTemplateExecution } from "../store/template-executions.js";
import { getTaskTemplate } from "../store/task-templates.js";
import { listArtifactsByExecution, type Artifact } from "../store/artifacts.js";
import {
  buildAttachmentFromArtifact,
  extractH1Title,
  filenameForArtifact,
  mediaTypeForArtifact,
  sanitizeFilenameSegment,
} from "../lib/artifact-attachments.js";
import type {
  OutboundAttachment,
  TaskTemplate,
  DeliveryPayloadManifest,
  DeliveryPayloadRef,
  DeliveryPayloadAttachment,
} from "../shared/types.js";

const log = getLogger("scheduler");

export interface ComposedDelivery {
  content: string;
  /** Ready-to-ship attachments (renamed/typed). */
  attachments: OutboundAttachment[];
  /** The raw artifacts behind `attachments`, aligned 1:1 — passed to the email size-cap packer unchanged. */
  artifacts: Artifact[];
}

/** Resolve a ref's artifact key, defaulting to the step's declared outputAs. */
function resolveKey(template: TaskTemplate, step: string, key?: string): string | undefined {
  return key ?? template.steps?.find((s) => s.id === step)?.outputAs ?? undefined;
}

/** Find the artifact for a (step, key); when several match, take the newest. */
function findArtifact(artifacts: Artifact[], step: string, key?: string): Artifact | undefined {
  const matches = artifacts.filter((a) => a.stepId === step && (key ? a.key === key : true));
  if (matches.length === 0) return undefined;
  return matches.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

/**
 * Normalize an array that may have been wrapped as `{ item: [...] }` by the ChatManager MCP config
 * path (its tool-arg coercion turns JSON arrays into an object with an `item` list). Re-editing an
 * already-wrapped value nests it further (`{ item: { item: [...] } }`), so unwrap ANY depth of
 * `item` envelopes until the underlying array surfaces. Accepts a real array or any wrap depth;
 * anything else → [].
 */
function asArray<T>(v: unknown): T[] {
  let cur: unknown = v;
  while (cur && typeof cur === "object" && !Array.isArray(cur) && "item" in (cur as object)) {
    cur = (cur as { item: unknown }).item;
  }
  return Array.isArray(cur) ? (cur as T[]) : [];
}

function isCollectionValue(v: unknown): v is { items: Array<{ key: string }> } {
  return !!v && typeof v === "object" && (v as { type?: string }).type === "artifact_collection"
    && Array.isArray((v as { items?: unknown }).items);
}

/**
 * Resolve a referenced artifact to its underlying deliverable file artifact(s).
 * - file artifact → itself
 * - artifact_collection json → its member file artifacts, deduped per filename (newest wins),
 *   which transparently absorbs the double-publish case.
 */
function fileArtifactsFor(artifacts: Artifact[], art: Artifact | undefined): Artifact[] {
  if (!art) return [];
  if (art.kind === "file" && art.blobPath) return [art];
  if (art.kind === "json" && isCollectionValue(art.value)) {
    const byKey = new Map(
      artifacts.filter((a) => a.stepId === art.stepId).map((a) => [a.key, a] as const),
    );
    const files = art.value.items
      .map((it) => byKey.get(it.key))
      .filter((a): a is Artifact => !!a && a.kind === "file" && !!a.blobPath);
    const latest = new Map<string, Artifact>();
    for (const f of files) {
      const name = f.originalFilename ?? f.key ?? f.id;
      const prev = latest.get(name);
      if (!prev || f.createdAt > prev.createdAt) latest.set(name, f);
    }
    return [...latest.values()];
  }
  return [];
}

function resolveText(artifacts: Artifact[], template: TaskTemplate, ref: DeliveryPayloadRef): string {
  const art = findArtifact(artifacts, ref.step, resolveKey(template, ref.step, ref.key));
  if (!art) return "";
  if (ref.field && art.kind === "json") {
    const v = (art.value as Record<string, unknown> | undefined)?.[ref.field];
    return v == null ? "" : String(v);
  }
  const file = fileArtifactsFor(artifacts, art)[0];
  if (file?.blobPath) {
    try {
      return readFileSync(file.blobPath, "utf-8");
    } catch (err) {
      log.warn({ blobPath: file.blobPath, error: err instanceof Error ? err.message : String(err) }, "compose: body file unreadable");
      return "";
    }
  }
  if (art.kind === "json") {
    if (typeof art.value === "string") return art.value;
    // A non-text JSON object reached the BODY position — a manifest misconfiguration (the body
    // should be markdown/text, not a structured object). Never JSON.stringify it into a human-facing
    // body; that shipped a raw JSON dump to subscribers on 2026-06-03. Warn + empty so the empty-body
    // / completeness guard surfaces it instead of delivering garbage.
    log.warn({ step: ref.step, key: ref.key, field: ref.field }, "compose: body ref resolved to a non-text JSON object; refusing to stringify into body");
    return "";
  }
  return "";
}

function resolveTitle(artifacts: Artifact[], template: TaskTemplate, ref: DeliveryPayloadRef): string | undefined {
  const art = findArtifact(artifacts, ref.step, resolveKey(template, ref.step, ref.key));
  if (!art) return undefined;
  if (ref.field && art.kind === "json") {
    const v = (art.value as Record<string, unknown> | undefined)?.[ref.field];
    const s = v == null ? "" : String(v).trim();
    return s.length > 0 ? s : undefined;
  }
  const file = fileArtifactsFor(artifacts, art)[0];
  if (file) return extractH1Title(file);
  if (art.kind === "json" && typeof art.value === "string") return art.value.trim() || undefined;
  return undefined;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TYPE_TO_MEDIA: Record<string, OutboundAttachment["mediaType"]> = {
  audio: "audio",
  video: "video",
  image: "image",
  markdown: "file",
  file: "file",
};

/** Render an attachment filename from a name template; preserves the artifact's extension. */
function renderName(nameTemplate: string, date: string, title: string | undefined, artifact: Artifact): string {
  const original = filenameForArtifact(artifact);
  // If the template needs {title} but we have none, don't emit a dangling separator — keep original.
  if (nameTemplate.includes("{title}") && !title) return original;
  const ext = extname(original);
  const base = sanitizeFilenameSegment(
    nameTemplate.replace(/\{date\}/g, date).replace(/\{title\}/g, title ?? ""),
  );
  return base ? `${base}${ext}` : original;
}

function buildAttachment(
  artifacts: Artifact[],
  entry: DeliveryPayloadAttachment,
  template: TaskTemplate,
  executionId: string,
  date: string,
  title: string | undefined,
): Array<{ artifact: Artifact; attachment: OutboundAttachment }> {
  // Field-sourced attachment: materialize a JSON field (e.g. 定稿.body) into a .md file on disk.
  // Used when a step's deliverable is structured ({title, body}) so body+title resolve as fields
  // while the body still ships as a real markdown attachment.
  if (entry.field) {
    const art = findArtifact(artifacts, entry.step, resolveKey(template, entry.step, entry.key));
    if (!art || art.kind !== "json") return [];
    const raw = (art.value as Record<string, unknown> | undefined)?.[entry.field];
    const text = raw == null ? "" : String(raw);
    if (text.trim().length === 0) return [];
    const path = join(tmpdir(), `adam-delivery-${art.id}-${sanitizeFilenameSegment(entry.field)}.md`);
    try {
      writeFileSync(path, text, "utf-8");
    } catch (err) {
      log.warn({ path, error: err instanceof Error ? err.message : String(err) }, "compose: failed to materialize field attachment");
      return [];
    }
    const synthetic: Artifact = {
      id: `mat-${art.id}-${entry.field}`,
      sourceKind: "template_step",
      executionId,
      stepId: art.stepId,
      key: art.key,
      kind: "file",
      blobPath: path,
      mime: "text/markdown",
      originalFilename: `${entry.field}.md`,
      sizeBytes: Buffer.byteLength(text, "utf-8"),
      createdAt: art.createdAt,
      roleId: art.roleId,
    };
    const filename = entry.name ? renderName(entry.name, date, title, synthetic) : filenameForArtifact(synthetic);
    const mediaType = entry.type && entry.type !== "auto" ? TYPE_TO_MEDIA[entry.type] : "file";
    return [{ artifact: synthetic, attachment: buildAttachmentFromArtifact(synthetic, { mediaType, filename }) }];
  }

  const art = findArtifact(artifacts, entry.step, resolveKey(template, entry.step, entry.key));
  const files = fileArtifactsFor(artifacts, art);
  return files.map((f) => {
    const filename = entry.name ? renderName(entry.name, date, title, f) : filenameForArtifact(f);
    const mediaType = entry.type && entry.type !== "auto" ? TYPE_TO_MEDIA[entry.type] : mediaTypeForArtifact(f);
    return { artifact: f, attachment: buildAttachmentFromArtifact(f, { mediaType, filename }) };
  });
}

export function composeDeliveryFromManifest(executionId: string): ComposedDelivery | null {
  const execution = getTemplateExecution(executionId);
  if (!execution) return null;
  const template = getTaskTemplate(execution.templateId);
  const manifest = template?.config?.delivery?.payload as DeliveryPayloadManifest | undefined;
  if (!template || !manifest) return null;

  const artifacts = listArtifactsByExecution(executionId);
  const date = formatDate(execution.startedAt);
  const title = manifest.title ? resolveTitle(artifacts, template, manifest.title) : undefined;

  let content = "";
  if (manifest.body) {
    content = "text" in manifest.body ? manifest.body.text : resolveText(artifacts, template, manifest.body);
  }

  const attachments: OutboundAttachment[] = [];
  const usedArtifacts: Artifact[] = [];
  for (const entry of asArray<DeliveryPayloadAttachment>(manifest.attachments)) {
    for (const { artifact, attachment } of buildAttachment(artifacts, entry, template, executionId, date, title)) {
      usedArtifacts.push(artifact);
      attachments.push(attachment);
    }
  }

  return { content, attachments, artifacts: usedArtifacts };
}
