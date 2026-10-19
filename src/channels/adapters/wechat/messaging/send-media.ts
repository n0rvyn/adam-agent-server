/**
 * Outbound media message sending: upload to CDN then send IMAGE/VIDEO/FILE message.
 * Extracted from @tencent-weixin/openclaw-weixin@2.1.1.
 */
import path from "node:path";

import { sendMessage } from "../api.js";
import type { WeixinApiOptions } from "../api.js";
import type { MessageItem, SendMessageReq } from "../types.js";
import { MessageItemType, MessageState, MessageType } from "../types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import { uploadImageToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin, uploadVoiceToWeixin } from "../cdn/upload.js";
import { getMimeFromFilename } from "../media/mime.js";
import { getLogger } from "../../../../lib/logger.js";

const log = getLogger("channels");

function generateClientId(): string {
  return `adam-wechat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Strip markdown formatting for plain-text Weixin delivery. */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, then strip leading/trailing pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  return result;
}

/**
 * Send a plain text message downstream.
 */
export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateClientId();
  const plainText = markdownToPlainText(text);

  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: plainText
        ? [{ type: MessageItemType.TEXT, text_item: { text: plainText } }]
        : undefined,
      context_token: opts.contextToken,
    },
  };

  await sendMessage({ baseUrl: opts.baseUrl, token: opts.token, routeTag: opts.routeTag, body: req });
  return { messageId: clientId };
}

/**
 * Send one or more MessageItems downstream (text caption + media item).
 * Each item is sent as its own request.
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;

  const items: MessageItem[] = [];
  const plainText = markdownToPlainText(text);
  if (plainText) {
    items.push({ type: MessageItemType.TEXT, text_item: { text: plainText } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken,
      },
    };
    await sendMessage({ baseUrl: opts.baseUrl, token: opts.token, routeTag: opts.routeTag, body: req });
  }

  log.debug(`${label}: sent to=${to} messageId=${lastClientId}`);
  return { messageId: lastClientId };
}

/** Send an image message downstream using a previously uploaded file. */
export async function sendImageMessage(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessage" });
}

/** Send a video message downstream using a previously uploaded file. */
export async function sendVideoMessage(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessage" });
}

/** Send a file attachment downstream using a previously uploaded file. */
export async function sendFileMessage(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;

  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessage" });
}

/** Map audio file extension to VoiceItem.encode_type (DP-001: chosen option B). */
function voiceEncodeTypeFromExt(ext: string): number | undefined {
  const map: Record<string, number> = {
    ".mp3": 7,
    ".ogg": 8,
    ".wav": 1,
    ".amr": 5,
    ".silk": 6,
  };
  return map[ext.toLowerCase()];
}

/**
 * Send a voice message downstream using a previously uploaded file.
 * NOTE: Not currently used by sendWeixinMediaFile — iLink Bot API silently drops VOICE (type=3).
 * Audio is routed through sendFileMessage instead. Retained for future use when iLink adds VOICE support.
 * @see sendWeixinMediaFile audio/* branch
 * @see https://github.com/n0rvyn/adam/issues/121
 */
export async function sendVoiceMessage(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinApiOptions & { contextToken?: string };
  fileName?: string;
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts, fileName } = params;
  const ext = fileName ? path.extname(fileName) : "";

  const voiceItem: MessageItem = {
    type: MessageItemType.VOICE,
    voice_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      encode_type: voiceEncodeTypeFromExt(ext),
    },
  };

  return sendMediaItems({ to, text, mediaItem: voiceItem, opts, label: "sendVoiceMessage" });
}

/**
 * Upload a local file and send it as a Weixin message, routing by MIME type:
 *   video/*  → uploadVideoToWeixin + sendVideoMessage
 *   image/*  → uploadImageToWeixin + sendImageMessage
 *   audio/*  → uploadVoiceToWeixin + sendVoiceMessage
 *   else     → uploadFileAttachmentToWeixin + sendFileMessage
 */
export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinApiOptions & { contextToken?: string };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const { filePath, to, text, opts, cdnBaseUrl } = params;
  const mime = getMimeFromFilename(filePath);
  const apiOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token, routeTag: opts.routeTag };

  if (mime.startsWith("video/")) {
    log.debug(`sendWeixinMediaFile: uploading video filePath=${filePath} to=${to}`);
    const uploaded = await uploadVideoToWeixin({ filePath, toUserId: to, opts: apiOpts, cdnBaseUrl });
    return sendVideoMessage({ to, text, uploaded, opts });
  }

  if (mime.startsWith("image/")) {
    log.debug(`sendWeixinMediaFile: uploading image filePath=${filePath} to=${to}`);
    const uploaded = await uploadImageToWeixin({ filePath, toUserId: to, opts: apiOpts, cdnBaseUrl });
    return sendImageMessage({ to, text, uploaded, opts });
  }

  if (mime.startsWith("audio/")) {
    // iLink Bot API silently drops VOICE (type=3) messages — upload and send audio as FILE (type=4) instead.
    // See: GitHub issue #121, @tencent-weixin/openclaw-weixin@2.1.6 also routes audio to FILE.
    const fileName = path.basename(filePath);
    log.debug(`sendWeixinMediaFile: uploading audio as file filePath=${filePath} name=${fileName} to=${to}`);
    const uploaded = await uploadFileAttachmentToWeixin({ filePath, fileName, toUserId: to, opts: apiOpts, cdnBaseUrl });
    return sendFileMessage({ to, text, fileName, uploaded, opts });
  }

  // File attachment: pdf, doc, zip, etc.
  const fileName = path.basename(filePath);
  log.debug(`sendWeixinMediaFile: uploading file attachment filePath=${filePath} name=${fileName} to=${to}`);
  const uploaded = await uploadFileAttachmentToWeixin({ filePath, fileName, toUserId: to, opts: apiOpts, cdnBaseUrl });
  return sendFileMessage({ to, text, fileName, uploaded, opts });
}
