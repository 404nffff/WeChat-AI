import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;
const MAX_PASSWORD_LEN = 128;

/** Encoded: scrypt$N$r$p$saltB64$urlsafe$hashB64$urlsafe */
export function assertPasswordPolicy(
  plain: string,
  minLength = 8,
): void {
  if (typeof plain !== "string" || !plain) {
    throw new Error("weak_password");
  }
  if (plain.length < minLength) {
    throw new Error("weak_password");
  }
  if (plain.length > MAX_PASSWORD_LEN) {
    throw new Error("weak_password");
  }
  if (!plain.trim()) {
    throw new Error("weak_password");
  }
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export async function hashPassword(plain: string): Promise<string> {
  assertPasswordPolicy(plain, 1); // length already checked by caller typically
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(plain, salt, KEYLEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
  });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${b64url(salt)}$${b64url(hash)}`;
}

/**
 * Constant-time-ish verify. Returns false on any parse/mismatch error.
 */
export async function verifyPassword(
  plain: string,
  encoded: string | null | undefined,
): Promise<boolean> {
  if (!plain || !encoded || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return false;
  }
  if (N < 1024 || N > 1 << 20 || r < 1 || p < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = fromB64url(parts[4]!);
    expected = fromB64url(parts[5]!);
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  try {
    const actual = await scryptAsync(plain, salt, expected.length, { N, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Dummy hash for constant-time path when user missing */
export async function dummyPasswordHash(): Promise<string> {
  return hashPassword("dummy-password-for-timing-" + "x".repeat(16));
}
