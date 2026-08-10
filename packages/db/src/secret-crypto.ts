/**
 * Encrypt user secrets at rest (e.g. custom LLM API keys).
 * AES-256-GCM; key derived from LLM_PROVIDER_SECRET via scrypt.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

const PREFIX = "v1";

/** Fixed salt — the derived key depends only on `secret`, so it is memoizable. */
const SALT = createHash("sha256").update("wechat-ai-llm-provider-v1").digest();

/**
 * scryptSync costs ~30ms of SYNCHRONOUS main-thread time and was re-run on
 * every encrypt/decrypt — i.e. on every inbound message that uses a user's
 * custom LLM provider, freezing Fastify and every bot long-poll for that long.
 * The derivation is deterministic, so memoize it.
 *
 * Bounded to a handful of entries (in practice there is exactly one process
 * secret). Keys are never logged.
 */
const keyCache = new Map<string, Buffer>();
const KEY_CACHE_MAX = 8;

function deriveKey(secret: string): Buffer {
  const hit = keyCache.get(secret);
  if (hit) return hit;
  const key = scryptSync(secret, SALT, 32);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(secret, key);
  return key;
}

export function encryptSecret(plain: string, secret: string): string {
  if (!secret || secret.length < 8) {
    throw new Error("LLM_PROVIDER_SECRET too short (min 8)");
  }
  if (!plain) throw new Error("empty secret");
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    enc.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encoded: string, secret: string): string {
  if (!secret || secret.length < 8) {
    throw new Error("LLM_PROVIDER_SECRET too short (min 8)");
  }
  const parts = (encoded || "").split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("invalid encrypted secret format");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const data = Buffer.from(parts[3], "base64url");
  const key = deriveKey(secret);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export function maskApiKey(key: string): string {
  const s = (key || "").trim();
  if (s.length <= 8) return "****";
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}
