let currentKey = "";
let currentBuffer: Buffer = Buffer.alloc(0);

export function setAuthKey(key: string): void {
  currentKey = key;
  currentBuffer = Buffer.from(key);
}

export function getAuthKey(): string {
  return currentKey;
}

export function getAuthKeyBuffer(): Buffer {
  return currentBuffer;
}
