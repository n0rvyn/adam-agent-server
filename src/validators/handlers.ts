import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { HandlerRuntimeError } from "./errors.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HandlerArgs = unknown;
export type HandlerFn = (filePath: string, args?: HandlerArgs) => Promise<number | string | boolean>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireFileExists(handlerKey: string, filePath: string): void {
  if (!existsSync(filePath)) {
    throw new HandlerRuntimeError(handlerKey, `file not found: ${filePath}`);
  }
}

async function runFfprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("ffprobe", args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new HandlerRuntimeError("audio.*", "ffprobe not found on PATH — install ffmpeg/ffprobe");
    }
    throw new HandlerRuntimeError("audio.*", `ffprobe failed: ${(err as Error).message}`);
  }
}

async function runFfmpegToBuffer(filePath: string, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn("ffmpeg", [
      "-v", "error",
      "-i", filePath,
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-",
    ]);
    proc.stdout.on("data", (c) => chunks.push(c));
    let stderr = "";
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new HandlerRuntimeError("audio.*", "ffmpeg not found on PATH — install ffmpeg/ffprobe"));
      } else {
        reject(new HandlerRuntimeError("audio.*", `ffmpeg failed: ${err.message}`));
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new HandlerRuntimeError("audio.*", `ffmpeg exit ${code}: ${stderr.trim()}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

// AJV schema cache keyed by SHA-256 of the canonicalized schema source
const ajvSchemaCache = new Map<string, (data: unknown) => boolean>();

async function compileAjvSchema(schema: object): Promise<(data: unknown) => boolean> {
  // Reject schemas that reference remote URIs (defense-in-depth; AJV does not auto-fetch by default
  // but the threat model in §Security explicitly forbids any external fetch surface).
  const schemaJson = JSON.stringify(schema);
  if (/"\$ref"\s*:\s*"https?:\/\//.test(schemaJson)) {
    throw new HandlerRuntimeError("json.schema_valid", "remote $ref not supported in schema");
  }
  const sig = createHash("sha256").update(schemaJson).digest("hex");
  const hit = ajvSchemaCache.get(sig);
  if (hit) return hit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvClass = ((await import("ajv")).default as unknown as { new (opts?: object): { compile: (s: object) => (d: unknown) => boolean } });
  const ajv = new AjvClass({ strict: false, allErrors: false });
  const fn = ajv.compile(schema);
  ajvSchemaCache.set(sig, fn);
  return fn;
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export const handlers: Record<string, HandlerFn> = {

  "audio.duration_s": async (filePath) => {
    requireFileExists("audio.duration_s", filePath);
    const { stdout } = await runFfprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const dur = parseFloat(stdout.trim());
    if (!Number.isFinite(dur)) {
      throw new HandlerRuntimeError("audio.duration_s", `ffprobe returned non-numeric duration: ${stdout.trim()}`);
    }
    return dur;
  },

  "audio.zc_rate_per_s": async (filePath) => {
    requireFileExists("audio.zc_rate_per_s", filePath);
    const sampleRate = 24000;
    const pcmBuf = await runFfmpegToBuffer(filePath, sampleRate);
    const samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) crossings++;
    }
    const durationS = samples.length / sampleRate;
    return durationS > 0 ? crossings / durationS : 0;
  },

  "audio.rms": async (filePath) => {
    requireFileExists("audio.rms", filePath);
    const sampleRate = 24000;
    const pcmBuf = await runFfmpegToBuffer(filePath, sampleRate);
    const samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 32768;
      sumSq += v * v;
    }
    return samples.length > 0 ? Math.sqrt(sumSq / samples.length) : 0;
  },

  "markdown.word_count": async (filePath) => {
    requireFileExists("markdown.word_count", filePath);
    const buf = await readFile(filePath, "utf-8");
    return buf.trim().length === 0 ? 0 : buf.trim().split(/\s+/).length;
  },

  "image.width_px": async (filePath) => {
    requireFileExists("image.width_px", filePath);
    const { imageSize } = await import("image-size");
    const buf = await readFile(filePath);
    const dim = imageSize(buf);
    if (typeof dim.width !== "number") throw new HandlerRuntimeError("image.width_px", "could not determine image width");
    return dim.width;
  },

  "image.height_px": async (filePath) => {
    requireFileExists("image.height_px", filePath);
    const { imageSize } = await import("image-size");
    const buf = await readFile(filePath);
    const dim = imageSize(buf);
    if (typeof dim.height !== "number") throw new HandlerRuntimeError("image.height_px", "could not determine image height");
    return dim.height;
  },

  "pdf.page_count": async (filePath) => {
    requireFileExists("pdf.page_count", filePath);
    const { PDFDocument } = await import("pdf-lib");
    const buf = await readFile(filePath);
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    return doc.getPageCount();
  },

  "json.schema_valid": async (filePath, args) => {
    requireFileExists("json.schema_valid", filePath);
    if (!args || typeof args !== "object" || !("schema" in args)) {
      throw new HandlerRuntimeError("json.schema_valid", "missing schema arg");
    }
    const validate = await compileAjvSchema((args as { schema: object }).schema);
    const buf = await readFile(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf);
    } catch (e) {
      throw new HandlerRuntimeError("json.schema_valid", `file is not valid JSON: ${(e as Error).message}`);
    }
    return validate(parsed) === true;
  },

};
