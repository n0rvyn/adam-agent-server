/**
 * AES-128-ECB crypto utilities for CDN upload and download.
 * Extracted from @tencent-weixin/openclaw-weixin@2.1.1.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

/** Encrypt buffer with AES-128-ECB (PKCS7 padding is default). */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary).
 * pkcs7 padded size = ceil((n + 1) / 16) * 16
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
