/**
 * Local embedding generation using onnxruntime-web (WASM backend).
 *
 * Model: bge-small-zh-v1.5 (512-dim, Chinese-strong, BAAI/BERT-based)
 * Backend: onnxruntime-web WASM — arch-agnostic, works on darwin/x64 Intel Mac.
 *   onnxruntime-node lacks a darwin/x64 native binding; onnxruntime-web provides
 *   a pure-WASM ONNX runtime that runs on any architecture.
 *
 * Model download: on first use, the ONNX model + tokenizer are fetched from
 * HuggingFace (Xenova/bge-small-zh-v1.5) and cached in ~/.adam/models/.
 *
 * Embedding dimension: 512 (bge-small-zh-v1.5)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { getLogger } from "./logger.js";
import { getRuntimeConfig } from "../config/runtime.js";

const log = getLogger("embedding");

export const EMBEDDING_DIMENSION = 512;

const MODELS_DIR = path.join(homedir(), ".adam", "models");

/** Short model-name → HuggingFace repo and ONNX file info */
const MODEL_REGISTRY: Record<string, { repo: string; onnxFile: string; tokenizerFile: string; dim: number }> = {
  "bge-small-zh-v1.5": {
    repo: "Xenova/bge-small-zh-v1.5",
    onnxFile: "onnx/model.onnx",
    tokenizerFile: "tokenizer.json",
    dim: 512,
  },
  "paraphrase-multilingual-MiniLM-L12-v2": {
    repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    onnxFile: "onnx/model.onnx",
    tokenizerFile: "tokenizer.json",
    dim: 384,
  },
};

const DEFAULT_MODEL = "bge-small-zh-v1.5";
const HF_BASE = "https://huggingface.co";

// ---- Lazy session singleton ----
let ortSession: OrtSession | null = null;
let tokenizerData: TokenizerData | null = null;
let sessionInitializing: Promise<void> | null = null;
let sessionLoadFailed = false;
let sessionLoadError: Error | null = null;

interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  inputNames: string[];
  outputNames: string[];
}

interface OrtTensor {
  data: Float32Array | Int32Array | BigInt64Array;
  dims: number[];
}

interface OrtModule {
  InferenceSession: {
    create(buffer: ArrayBuffer, options?: object): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => OrtTensor;
  env: { wasm: { wasmPaths: string } };
}

interface TokenizerData {
  model: { vocab: Record<string, number> };
}

function resolveModelName(): string {
  try {
    return getRuntimeConfig().memory?.embeddingModel ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function getModelInfo() {
  const name = resolveModelName();
  return MODEL_REGISTRY[name] ?? MODEL_REGISTRY[DEFAULT_MODEL];
}

function getModelCacheDir(): string {
  const info = getModelInfo();
  const dir = path.join(MODELS_DIR, info.repo.replace("/", "_"));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) return;
  log.info({ file: path.basename(dest) }, "Downloading model file");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  log.info({ file: path.basename(dest), sizeMb: (buffer.length / 1024 / 1024).toFixed(1) }, "Downloaded");
}

async function ensureModelFiles(): Promise<{ modelPath: string; tokenizerPath: string }> {
  const info = getModelInfo();
  const dir = getModelCacheDir();
  const modelPath = path.join(dir, "model.onnx");
  const tokenizerPath = path.join(dir, "tokenizer.json");
  const base = `${HF_BASE}/${info.repo}/resolve/main`;
  await downloadFile(`${base}/${info.onnxFile}`, modelPath);
  await downloadFile(`${base}/${info.tokenizerFile}`, tokenizerPath);
  return { modelPath, tokenizerPath };
}

function loadOrt(): OrtModule {
  // Use createRequire to load onnxruntime-web CJS (WASM ONNX runtime).
  // The main entry (dist/ort.node.min.js) only includes cpu/wasm backends.
  // We load it, locate its dist directory for WASM binaries, then require
  // the "all" bundle (dist/ort.all.min.js) for full WASM InferenceSession support.
  const req = createRequire(import.meta.url);
  // Resolve main entry to locate the package root's dist directory
  const mainEntryPath = req.resolve("onnxruntime-web");
  const ortWebDistDir = path.dirname(mainEntryPath); // .../node_modules/onnxruntime-web/dist
  // Load the "all" bundle directly by path — bypasses exports restrictions
  const ort = req(path.join(ortWebDistDir, "ort.all.min.js")) as OrtModule;
  ort.env.wasm.wasmPaths = ortWebDistDir + "/";
  return ort;
}

async function getSession(): Promise<{ session: OrtSession; ort: OrtModule; tokenizerPath: string }> {
  if (sessionLoadFailed) throw sessionLoadError ?? new Error("Embedding session unavailable.");
  if (ortSession && tokenizerData) {
    const ort = loadOrt();
    const dir = getModelCacheDir();
    return { session: ortSession, ort, tokenizerPath: path.join(dir, "tokenizer.json") };
  }

  if (!sessionInitializing) {
    sessionInitializing = (async () => {
      try {
        const { modelPath, tokenizerPath } = await ensureModelFiles();
        const ort = loadOrt();
        log.info({ model: resolveModelName() }, "Loading ONNX inference session");
        const buf = fs.readFileSync(modelPath);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        ortSession = await ort.InferenceSession.create(ab, { executionProviders: ["wasm"] });
        tokenizerData = JSON.parse(fs.readFileSync(tokenizerPath, "utf-8")) as TokenizerData;
        log.info({ model: resolveModelName() }, "Embedding session ready");
      } catch (err) {
        sessionLoadFailed = true;
        sessionLoadError = err instanceof Error ? err : new Error(String(err));
        log.warn({ err }, "Embedding session failed to load");
        throw sessionLoadError;
      }
    })();
  }

  await sessionInitializing;
  if (!ortSession) throw sessionLoadError ?? new Error("Embedding session unavailable.");
  const ort = loadOrt();
  const dir = getModelCacheDir();
  return { session: ortSession, ort, tokenizerPath: path.join(dir, "tokenizer.json") };
}

// ---- Correct BERT WordPiece Tokenizer ----
//
// Implements the full spec from the model's tokenizer.json:
//   normalizer = BertNormalizer {clean_text:true, handle_chinese_chars:true, lowercase:false}
//   pre_tokenizer = BertPreTokenizer
//   model = WordPiece {unk_token:"[UNK]", continuing_subword_prefix:"##", max_input_chars_per_word:100}
//
// This is a standards-compliant implementation; @huggingface/transformers is not used
// (that library loads onnxruntime-node which has no darwin/x64 native binding).

/** Step 1: BertNormalizer — clean_text + handle_chinese_chars, lowercase:false */
function bertNormalize(text: string): string {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // clean_text: remove null and replacement char
    if (cp === 0 || cp === 0xfffd) continue;
    // clean_text: control chars → space (keep \t \n \r as space)
    const cat = /^\p{Cc}|\p{Cf}/u.test(ch);
    if (cat) {
      if (ch === "\t" || ch === "\n" || ch === "\r") {
        out.push(" ");
      }
      continue;
    }
    // handle_chinese_chars: surround CJK ideographs with spaces
    const isCjk =
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f);
    if (isCjk) {
      out.push(" ", ch, " ");
    } else {
      out.push(ch);
    }
  }
  return out.join("");
}

/** BERT _is_punctuation: ASCII punct ranges OR Unicode Punctuation category */
function isBertPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  // ASCII punctuation: 33-47, 58-64, 91-96, 123-126
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  // Unicode Punctuation categories (P*)
  return /^\p{P}/u.test(ch);
}

/** Step 2: BertPreTokenizer — split on whitespace, then isolate punctuation chars */
function bertPreTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    let current: string[] = [];
    for (const ch of word) {
      if (isBertPunctuation(ch)) {
        if (current.length > 0) {
          tokens.push(current.join(""));
          current = [];
        }
        tokens.push(ch);
      } else {
        current.push(ch);
      }
    }
    if (current.length > 0) tokens.push(current.join(""));
  }
  return tokens;
}

/** Step 3: WordPiece greedy longest-match for a single pre-token */
function wordPieceTokenize(preToken: string, vocab: Record<string, number>, unkId: number): number[] {
  // max_input_chars_per_word: 100 (character count, not byte count)
  const chars = Array.from(preToken);
  if (chars.length > 100) return [unkId];

  const result: number[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let found = false;
    while (end > start) {
      const sub = chars.slice(start, end).join("");
      const lookup = start === 0 ? sub : "##" + sub;
      if (lookup in vocab) {
        result.push(vocab[lookup]);
        start = end;
        found = true;
        break;
      }
      end--;
    }
    if (!found) {
      // Entire pre-token → [UNK]
      return [unkId];
    }
  }
  return result;
}

/**
 * Tokenize text using the BERT WordPiece spec from tokenizer.json.
 * Exported so tests can call it directly without an ONNX session.
 *
 * Returns BigInt64Array-based token/mask arrays, padded to `maxLength`.
 * The model file must already be cached (tokenizer.json contains the vocab).
 */
export function tokenize(
  text: string,
  vocab: Record<string, number>,
  maxLength = 512,
): { inputIds: BigInt64Array; attentionMask: BigInt64Array; tokenTypeIds: BigInt64Array } {
  const clsId = vocab["[CLS]"] ?? 101;
  const sepId = vocab["[SEP]"] ?? 102;
  const unkId = vocab["[UNK]"] ?? 100;
  const padId = vocab["[PAD]"] ?? 0;

  // Run the three normalizer/pre-tokenizer/WordPiece stages
  const normalized = bertNormalize(text);
  const preTokens = bertPreTokenize(normalized);

  const wordPieceIds: number[] = [];
  for (const pt of preTokens) {
    const ids = wordPieceTokenize(pt, vocab, unkId);
    wordPieceIds.push(...ids);
  }

  // TemplateProcessing: [CLS] + ids (truncated to fit) + [SEP]
  // Truncate body to maxLength - 2 so [CLS] and [SEP] always fit
  const body = wordPieceIds.slice(0, maxLength - 2);
  const tokenIds: number[] = [clsId, ...body, sepId];

  const len = tokenIds.length; // always ≤ maxLength
  const inputIds = new BigInt64Array(maxLength);
  const attentionMask = new BigInt64Array(maxLength);
  const tokenTypeIds = new BigInt64Array(maxLength);

  for (let i = 0; i < maxLength; i++) {
    if (i < len) {
      inputIds[i] = BigInt(tokenIds[i]);
      attentionMask[i] = 1n;
    } else {
      inputIds[i] = BigInt(padId);
      attentionMask[i] = 0n;
    }
    tokenTypeIds[i] = 0n;
  }

  return { inputIds, attentionMask, tokenTypeIds };
}

/**
 * Generate embedding for a text string.
 * Downloads model on first use (~40 MB, bge-small-zh-v1.5).
 * Returns Float32Array of dimension EMBEDDING_DIMENSION (512), L2-normalized.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const { session, ort } = await getSession();
  const vocab = tokenizerData!.model.vocab;
  const { inputIds, attentionMask, tokenTypeIds } = tokenize(text, vocab);
  const seqLen = inputIds.length;

  const feeds: Record<string, OrtTensor> = {
    input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, seqLen]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, seqLen]),
  };

  const results = await session.run(feeds);
  const output = results["last_hidden_state"] ?? results[Object.keys(results)[0]];
  const data = output.data as Float32Array;
  const hiddenSize = EMBEDDING_DIMENSION;
  const embedding = new Float32Array(hiddenSize);
  let tokenCount = 0;

  for (let t = 0; t < seqLen; t++) {
    if (attentionMask[t] === 1n) {
      tokenCount++;
      for (let h = 0; h < hiddenSize; h++) {
        embedding[h] += data[t * hiddenSize + h];
      }
    }
  }

  if (tokenCount > 0) {
    for (let h = 0; h < hiddenSize; h++) embedding[h] /= tokenCount;
  }

  // L2 normalize
  let norm = 0;
  for (let h = 0; h < hiddenSize; h++) norm += embedding[h] * embedding[h];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let h = 0; h < hiddenSize; h++) embedding[h] /= norm;
  }

  return embedding;
}

/**
 * Returns true if the embedding model files are cached locally
 * (or if the session has been successfully initialized).
 */
export function isModelAvailable(): boolean {
  if (sessionLoadFailed) return false;
  if (ortSession) return true;
  // Check if model files already exist locally
  try {
    const dir = getModelCacheDir();
    return fs.existsSync(path.join(dir, "model.onnx")) && fs.existsSync(path.join(dir, "tokenizer.json"));
  } catch {
    return false;
  }
}
