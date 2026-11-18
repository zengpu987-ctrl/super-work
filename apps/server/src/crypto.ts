import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Paths } from "./config.js";

let cachedKey: Buffer | null = null;

function loadKey(paths: Paths): Buffer {
  if (cachedKey) return cachedKey;
  fs.mkdirSync(path.dirname(paths.keyFile), { recursive: true, mode: 0o700 });
  try {
    const b64 = fs.readFileSync(paths.keyFile, "utf8").trim();
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 32) throw new Error("invalid key length");
    cachedKey = buf;
    return buf;
  } catch {
    const buf = crypto.randomBytes(32);
    fs.writeFileSync(paths.keyFile, buf.toString("base64"), { mode: 0o600 });
    cachedKey = buf;
    return buf;
  }
}

/** AES-256-GCM：v1.<iv>.<tag>.<ciphertext>，全部 base64url。 */
export function encrypt(paths: Paths, plaintext: string): string {
  const key = loadKey(paths);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decrypt(paths: Paths, payload: string): string {
  const key = loadKey(paths);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unsupported ciphertext");
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const data = Buffer.from(parts[3]!, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
