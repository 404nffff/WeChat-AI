import { randomBytes } from "node:crypto";
import type { RedisStore } from "./client.js";
import { newId, nowIso } from "./client.js";
import { K } from "./keys.js";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

export interface InviteCode {
  code: string;
  inviterUserId: string;
  inviterUsername: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "used" | "revoked";
  usedByUserId?: string;
  usedAt?: string;
}

export interface InviteSettings {
  quotaWindowHours: number;
  quotaMax: number;
  codeTtlSec: number;
  maxPendingPerUser: number;
  codeLength: number;
}

export const DEFAULT_INVITE_SETTINGS: InviteSettings = {
  quotaWindowHours: 24,
  quotaMax: 3,
  codeTtlSec: 7 * 24 * 3600,
  maxPendingPerUser: 20,
  codeLength: 10,
};

export function generateInviteCode(length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length]!;
  }
  return out;
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function getInviteSettings(
  db: RedisStore,
  defaults: Partial<InviteSettings> = {},
): Promise<InviteSettings> {
  const base: InviteSettings = {
    ...DEFAULT_INVITE_SETTINGS,
    ...defaults,
  };
  const stored = await db.getJson<Partial<InviteSettings>>(K.inviteSettings);
  if (!stored) return base;
  return {
    quotaWindowHours:
      typeof stored.quotaWindowHours === "number" && stored.quotaWindowHours >= 0
        ? stored.quotaWindowHours
        : base.quotaWindowHours,
    quotaMax:
      typeof stored.quotaMax === "number" && stored.quotaMax >= 0
        ? Math.floor(stored.quotaMax)
        : base.quotaMax,
    codeTtlSec:
      typeof stored.codeTtlSec === "number" && stored.codeTtlSec >= 60
        ? Math.floor(stored.codeTtlSec)
        : base.codeTtlSec,
    maxPendingPerUser:
      typeof stored.maxPendingPerUser === "number" &&
      stored.maxPendingPerUser >= 1
        ? Math.floor(stored.maxPendingPerUser)
        : base.maxPendingPerUser,
    codeLength:
      typeof stored.codeLength === "number" && stored.codeLength >= 6
        ? Math.min(32, Math.floor(stored.codeLength))
        : base.codeLength,
  };
}

export async function setInviteSettings(
  db: RedisStore,
  patch: Partial<InviteSettings>,
  defaults: Partial<InviteSettings> = {},
): Promise<InviteSettings> {
  const cur = await getInviteSettings(db, defaults);
  const next: InviteSettings = {
    quotaWindowHours:
      patch.quotaWindowHours !== undefined
        ? Math.max(0, Number(patch.quotaWindowHours) || 0)
        : cur.quotaWindowHours,
    quotaMax:
      patch.quotaMax !== undefined
        ? Math.max(0, Math.floor(Number(patch.quotaMax) || 0))
        : cur.quotaMax,
    codeTtlSec:
      patch.codeTtlSec !== undefined
        ? Math.max(60, Math.floor(Number(patch.codeTtlSec) || 60))
        : cur.codeTtlSec,
    maxPendingPerUser:
      patch.maxPendingPerUser !== undefined
        ? Math.max(1, Math.floor(Number(patch.maxPendingPerUser) || 1))
        : cur.maxPendingPerUser,
    codeLength:
      patch.codeLength !== undefined
        ? Math.min(32, Math.max(6, Math.floor(Number(patch.codeLength) || 10)))
        : cur.codeLength,
  };
  await db.setJson(K.inviteSettings, next);
  return next;
}

export interface InviteQuotaStatus {
  used: number;
  max: number;
  windowHours: number;
  remaining: number;
  retryAfterSec: number;
}

export async function getInviteQuotaStatus(
  db: RedisStore,
  userId: string,
  settings: InviteSettings,
): Promise<InviteQuotaStatus> {
  const windowMs = Math.max(0, settings.quotaWindowHours) * 3600 * 1000;
  const max = settings.quotaMax;
  if (max <= 0 || windowMs <= 0) {
    return {
      used: 0,
      max: max <= 0 ? Number.POSITIVE_INFINITY : max,
      windowHours: settings.quotaWindowHours,
      remaining: max <= 0 ? Number.POSITIVE_INFINITY : max,
      retryAfterSec: 0,
    };
  }
  const key = K.inviteGenLog(userId);
  const now = Date.now();
  const cutoff = now - windowMs;
  await db.redis.zremrangebyscore(key, 0, cutoff);
  const used = await db.redis.zcard(key);
  let retryAfterSec = 0;
  if (used >= max) {
    const oldest = await db.redis.zrange(key, 0, 0, "WITHSCORES");
    if (oldest.length >= 2) {
      const oldestMs = Number(oldest[1]);
      retryAfterSec = Math.max(
        1,
        Math.ceil((oldestMs + windowMs - now) / 1000),
      );
    } else {
      retryAfterSec = Math.ceil(windowMs / 1000);
    }
  }
  return {
    used,
    max,
    windowHours: settings.quotaWindowHours,
    remaining: Math.max(0, max - used),
    retryAfterSec,
  };
}

export async function countPendingInvites(
  db: RedisStore,
  userId: string,
): Promise<number> {
  return db.redis.scard(K.invitesByUser(userId));
}

export async function peekInviteCode(
  db: RedisStore,
  code: string,
): Promise<InviteCode | null> {
  const c = normalizeInviteCode(code);
  if (!c) return null;
  const rec = await db.getJson<InviteCode>(K.invite(c));
  if (!rec || rec.status !== "pending") return null;
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) return null;
  return rec;
}

/**
 * Atomically consume a pending invite. Returns null if missing/expired/used.
 */
export async function consumeInviteCode(
  db: RedisStore,
  code: string,
  usedByUserId: string,
): Promise<InviteCode | null> {
  const c = normalizeInviteCode(code);
  if (!c) return null;
  const key = K.invite(c);
  const raw = await db.redis.get(key);
  if (!raw) return null;
  let rec: InviteCode;
  try {
    rec = JSON.parse(raw) as InviteCode;
  } catch {
    await db.redis.del(key);
    return null;
  }
  if (rec.status !== "pending") {
    await db.redis.del(key);
    return null;
  }
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
    await db.redis.del(key);
    if (rec.inviterUserId) {
      await db.redis.srem(K.invitesByUser(rec.inviterUserId), c);
    }
    return null;
  }
  await db.redis.del(key);
  if (rec.inviterUserId) {
    await db.redis.srem(K.invitesByUser(rec.inviterUserId), c);
  }
  const used: InviteCode = {
    ...rec,
    status: "used",
    usedByUserId,
    usedAt: nowIso(),
  };
  return used;
}

export async function createInviteCode(
  db: RedisStore,
  input: {
    inviterUserId: string;
    inviterUsername: string;
    settings: InviteSettings;
  },
): Promise<
  | { ok: true; invite: InviteCode; quota: InviteQuotaStatus }
  | {
      ok: false;
      error: "invite_quota" | "invite_pending_limit";
      quota?: InviteQuotaStatus;
      maxPending?: number;
    }
> {
  const { inviterUserId, inviterUsername, settings } = input;
  const pending = await countPendingInvites(db, inviterUserId);
  if (pending >= settings.maxPendingPerUser) {
    return {
      ok: false,
      error: "invite_pending_limit",
      maxPending: settings.maxPendingPerUser,
    };
  }

  const quota = await getInviteQuotaStatus(db, inviterUserId, settings);
  if (
    settings.quotaMax > 0 &&
    settings.quotaWindowHours > 0 &&
    quota.remaining <= 0
  ) {
    return { ok: false, error: "invite_quota", quota };
  }

  const ttl = Math.max(60, settings.codeTtlSec);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const len = settings.codeLength || 10;

  for (let i = 0; i < 12; i++) {
    const code = generateInviteCode(len);
    const rec: InviteCode = {
      code,
      inviterUserId,
      inviterUsername,
      createdAt: nowIso(),
      expiresAt,
      status: "pending",
    };
    const ok = await db.redis.set(
      K.invite(code),
      JSON.stringify(rec),
      "EX",
      ttl,
      "NX",
    );
    if (ok !== "OK") continue;

    await db.redis.sadd(K.invitesByUser(inviterUserId), code);

    // Record generation for quota (member unique)
    if (settings.quotaMax > 0 && settings.quotaWindowHours > 0) {
      const logKey = K.inviteGenLog(inviterUserId);
      const now = Date.now();
      const member = `${now}:${code}:${newId("ig")}`;
      await db.redis.zadd(logKey, now, member);
      const windowMs = settings.quotaWindowHours * 3600 * 1000;
      await db.redis.zremrangebyscore(logKey, 0, now - windowMs);
      // Keep log a bit longer than window
      await db.redis.pexpire(logKey, windowMs + 3600_000);
    }

    const nextQuota = await getInviteQuotaStatus(
      db,
      inviterUserId,
      settings,
    );
    return { ok: true, invite: rec, quota: nextQuota };
  }
  throw new Error("failed to allocate invite code");
}

export async function listPendingInvites(
  db: RedisStore,
  userId: string,
): Promise<InviteCode[]> {
  const codes = (await db.redis.smembers(K.invitesByUser(userId))) as string[];
  if (!codes.length) return [];
  const rows = await db.mgetJson<InviteCode>(
    codes.map((c) => K.invite(c)),
  );
  const out: InviteCode[] = [];
  const stale: string[] = [];
  for (let i = 0; i < codes.length; i++) {
    const rec = rows[i];
    const code = codes[i]!;
    if (!rec || rec.status !== "pending") {
      stale.push(code);
      continue;
    }
    if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) {
      stale.push(code);
      await db.redis.del(K.invite(code));
      continue;
    }
    out.push(rec);
  }
  if (stale.length) {
    await db.redis.srem(K.invitesByUser(userId), ...stale);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function revokeInviteCode(
  db: RedisStore,
  userId: string,
  code: string,
): Promise<boolean> {
  const c = normalizeInviteCode(code);
  if (!c) return false;
  const rec = await db.getJson<InviteCode>(K.invite(c));
  if (!rec) {
    await db.redis.srem(K.invitesByUser(userId), c);
    return false;
  }
  if (rec.inviterUserId !== userId) return false;
  await db.redis.del(K.invite(c));
  await db.redis.srem(K.invitesByUser(userId), c);
  return true;
}

/** Revoke all pending invites for a user (e.g. on account delete). */
export async function revokeAllInvitesForUser(
  db: RedisStore,
  userId: string,
): Promise<number> {
  const codes = (await db.redis.smembers(K.invitesByUser(userId))) as string[];
  if (!codes.length) return 0;
  for (const c of codes) {
    await db.redis.del(K.invite(c));
  }
  await db.redis.del(K.invitesByUser(userId));
  return codes.length;
}
