/**
 * Media download dispatcher for inbound WeChat messages.
 * Handles IMAGE, VOICE, FILE, VIDEO items by downloading from CDN, decrypting, and saving locally.
 * Extracted from @tencent-weixin/openclaw-weixin@2.1.1.
 */
import * as fsAsync from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

import { getLogger } from "../../../../lib/logger.js";
import type { MessageItem } from "../types.js";
import { MessageItemType } from "../types.js";
import { downloadAndDecrypt, downloadPlain } from "../cdn/download.js";
import { silkToWav } from "./silk-transcode.js";
import { getMimeFromFilename, getExtensionFromMime } from "./mime.js";

const log = getLogger("channels");

/** Maximum file size for saved media (100 MB). */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface DownloadedMedia {
  path: string;
  mimeType: string;
  type: "image" | "audio" | "video" | "file";
}

/** Determine file extension from a MIME type string. */
function extFromMime(mimeType: string): string {
  return getExtensionFromMime(mimeType) ?? ".bin";
}

/**
 * Save a buffer to the media directory.
 * Returns the local file path.
 */
async function saveMedia(
  buf: Buffer,
  mimeType: string | undefined,
  subdir: string,
  channelId: string,
  maxBytes = MAX_MEDIA_BYTES,
  originalFilename?: string,
): Promise<string> {
  if (buf.length > maxBytes) {
    throw new Error(`Media too large: ${buf.length} bytes exceeds ${maxBytes} bytes`);
  }

  const mediaDir = path.join(homedir(), ".adam", "wechat", "media", channelId, subdir);
  await fsAsync.mkdir(mediaDir, { recursive: true });

  // Use original filename if provided and safe
  let filename: string;
  if (originalFilename && /^[a-zA-Z0-9._-]+$/.test(originalFilename)) {
    filename = originalFilename;
  } else {
    const ext = mimeType ? extFromMime(mimeType) : ".bin";
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    filename = `${ts}-${rand}${ext}`;
  }

  const filePath = path.join(mediaDir, filename);
  await fsAsync.writeFile(filePath, buf);
  log.debug(`saveMedia: saved ${buf.length} bytes to ${filePath}`);
  return filePath;
}

/**
 * Download and process media from a single MessageItem.
 * Returns DownloadedMedia on success, null on unsupported type or failure.
 * Download failures do not block message delivery — they are logged and null is returned.
 */
export async function downloadMediaFromItem(
  item: MessageItem,
  deps: { cdnBaseUrl: string; channelId: string },
): Promise<DownloadedMedia | null> {
  const { cdnBaseUrl, channelId } = deps;

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return null;

    // Prefer image_item.aeskey (hex) over media.aes_key (base64)
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media?.aes_key;

    try {
      const buf = aesKeyBase64
        ? await downloadAndDecrypt({
            encryptQueryParam: img.media?.encrypt_query_param,
            aesKeyBase64,
            cdnBaseUrl,
            fullUrl: img.media?.full_url,
          })
        : await downloadPlain({
            encryptQueryParam: img.media?.encrypt_query_param,
            cdnBaseUrl,
            fullUrl: img.media?.full_url,
          });

      const savedPath = await saveMedia(buf, "image/png", "inbound", channelId);
      return { path: savedPath, mimeType: "image/png", type: "image" };
    } catch (err) {
      log.error({ channelId }, `Image download/decrypt failed: ${String(err)}`);
      return null;
    }
  }

  if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key) {
      return null;
    }

    try {
      const silkBuf = await downloadAndDecrypt({
        encryptQueryParam: voice.media.encrypt_query_param,
        aesKeyBase64: voice.media.aes_key,
        cdnBaseUrl,
        fullUrl: voice.media.full_url,
      });

      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const savedPath = await saveMedia(wavBuf, "audio/wav", "inbound", channelId);
        log.debug(`Voice: saved WAV to ${savedPath}`);
        return { path: savedPath, mimeType: "audio/wav", type: "audio" };
      } else {
        const savedPath = await saveMedia(silkBuf, "audio/silk", "inbound", channelId);
        log.debug(`Voice: silk transcode unavailable, saved raw SILK to ${savedPath}`);
        return { path: savedPath, mimeType: "audio/silk", type: "audio" };
      }
    } catch (err) {
      log.error({ channelId }, `Voice download/transcode failed: ${String(err)}`);
      return null;
    }
  }

  if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key) {
      return null;
    }

    try {
      const buf = await downloadAndDecrypt({
        encryptQueryParam: fileItem.media.encrypt_query_param,
        aesKeyBase64: fileItem.media.aes_key,
        cdnBaseUrl,
        fullUrl: fileItem.media.full_url,
      });

      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const savedPath = await saveMedia(buf, mime, "inbound", channelId, MAX_MEDIA_BYTES, fileItem.file_name);
      return { path: savedPath, mimeType: mime, type: "file" };
    } catch (err) {
      log.error({ channelId }, `File download failed: ${String(err)}`);
      return null;
    }
  }

  if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key) {
      return null;
    }

    try {
      const buf = await downloadAndDecrypt({
        encryptQueryParam: videoItem.media.encrypt_query_param,
        aesKeyBase64: videoItem.media.aes_key,
        cdnBaseUrl,
        fullUrl: videoItem.media.full_url,
      });

      const savedPath = await saveMedia(buf, "video/mp4", "inbound", channelId);
      return { path: savedPath, mimeType: "video/mp4", type: "video" };
    } catch (err) {
      log.error({ channelId }, `Video download failed: ${String(err)}`);
      return null;
    }
  }

  return null;
}
