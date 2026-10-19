/**
 * CDN download and AES-128-ECB decryption for inbound media.
 * Extracted from @tencent-weixin/openclaw-weixin@2.1.1.
 */
import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl } from "./cdn-url.js";
import { getLogger } from "../../../../lib/logger.js";

const log = getLogger("channels");

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)          → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or 32-char hex, got ${decoded.length} bytes`,
  );
}

async function fetchCdnBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 * Prefers fullUrl when available; falls back to building from encryptQueryParam.
 */
export async function downloadAndDecrypt(params: {
  encryptQueryParam?: string;
  aesKeyBase64: string;
  cdnBaseUrl: string;
  fullUrl?: string;
}): Promise<Buffer> {
  const { encryptQueryParam, aesKeyBase64, cdnBaseUrl, fullUrl } = params;
  const key = parseAesKey(aesKeyBase64);
  const url =
    fullUrl?.trim() ||
    (encryptQueryParam ? buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl) : null);
  if (!url) throw new Error("CDN download: need full_url or encrypt_query_param");
  const encrypted = await fetchCdnBytes(url);
  return decryptAesEcb(encrypted, key);
}

/**
 * Download plain (unencrypted) bytes from the CDN.
 * Used when aes_key is absent (some images may be transferred in plaintext).
 */
export async function downloadPlain(params: {
  encryptQueryParam?: string;
  cdnBaseUrl: string;
  fullUrl?: string;
}): Promise<Buffer> {
  const { encryptQueryParam, cdnBaseUrl, fullUrl } = params;
  const url =
    fullUrl?.trim() ||
    (encryptQueryParam ? buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl) : null);
  if (!url) throw new Error("CDN download: need full_url or encrypt_query_param");
  return fetchCdnBytes(url);
}
