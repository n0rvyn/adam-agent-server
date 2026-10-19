/**
 * iLink Bot HTTP API layer.
 * Extracted from @tencent-weixin/openclaw-weixin, adapted for Adam.
 * All OpenClaw dependencies removed.
 */
import crypto from "node:crypto";

import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
} from "./types.js";

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  routeTag?: string; // DP-001: optional SKRouteTag header for iLink API routing
  timeoutMs?: number;
  longPollTimeoutMs?: number;
}

const CHANNEL_VERSION = "2.1.7";

/** iLink-App-Id: must match upstream openclaw-weixin package.json#ilink_appid for full session window. */
export const ILINK_APP_ID = "bot";

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP.
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.0" -> 0x00010000 = 65536; "2.1.1" -> 0x00020101 = 131329
 */
export function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** iLink-App-ClientVersion as uint32. */
export const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; routeTag?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  if (opts.routeTag) {
    headers.SKRouteTag = opts.routeTag;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  routeTag?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, routeTag: params.routeTag, body: params.body });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

export async function getUpdates(
  params: GetUpdatesReq & WeixinApiOptions,
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      routeTag: params.routeTag,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Per ret-code max attempts: ret=-2 (quota/transient) → 2 attempts, ret=-3 (transient) → 3 attempts. */
const RET_CODE_MAX_RETRIES: Record<number, number> = { [-2]: 2, [-3]: 3 };
const SEND_MESSAGE_RETRY_DELAY_MS = 1_000;

export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  const log = (await import("../../../lib/logger.js")).getLogger("channels");
  const retCounts = new Map<number, number>();

  for (;;) {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
      token: params.token,
      routeTag: params.routeTag,
      timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      label: "sendMessage",
    });

    log.info({ status: 200, responseBody: rawText.slice(0, 300) }, "apiFetch sendMessage response");

    try {
      const resp = JSON.parse(rawText);
      if (resp.ret && resp.ret !== 0) {
        const maxRetries = RET_CODE_MAX_RETRIES[resp.ret as number];
        const attempt = (retCounts.get(resp.ret) ?? 0) + 1;
        retCounts.set(resp.ret, attempt);

        if (maxRetries !== undefined && attempt < maxRetries) {
          log.warn({ ret: resp.ret, attempt, maxRetries }, "sendMessage: retriable iLink error, retrying");
          await new Promise((r) => setTimeout(r, SEND_MESSAGE_RETRY_DELAY_MS * attempt));
          continue;
        }
        log.error({ ret: resp.ret, errmsg: resp.errmsg, attempt }, "sendMessage: iLink API error, no more retries");
        throw new Error(`sendMessage failed: iLink ret=${resp.ret}${resp.errmsg ? ` errmsg=${resp.errmsg}` : ""}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        log.warn({ rawText: rawText.slice(0, 200) }, "sendMessage: non-JSON response, treating as success");
      } else throw e;
    }
    return;
  }
}

export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    routeTag: params.routeTag,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText) as GetConfigResp;
}

export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    routeTag: params.routeTag,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    routeTag: params.routeTag,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return JSON.parse(rawText) as GetUploadUrlResp;
}
