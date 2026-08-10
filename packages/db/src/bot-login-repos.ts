import type { RedisStore } from "./client.js";
import { K } from "./keys.js";

/** Default QR login session TTL (seconds). Matches UI ~10min window. */
export const BOT_LOGIN_TTL_SEC = 10 * 60;

export type BotLoginSessionStatus =
  | "pending"
  | "wait_scan"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error"
  | "cancelled";

export type BotLoginMode = "create" | "rebind";

/** Serializable view shared across nodes for QR bot login. */
export interface BotLoginSessionRecord {
  sessionId: string;
  displayName: string;
  ownerUserId: string;
  status: BotLoginSessionStatus;
  mode: BotLoginMode;
  rebindBotId?: string;
  qrcode?: string;
  openUrl?: string;
  message?: string;
  botId?: string;
  createdAt: string;
  updatedAt: string;
}

export async function saveBotLoginSession(
  db: RedisStore,
  record: BotLoginSessionRecord,
  ttlSec: number = BOT_LOGIN_TTL_SEC,
): Promise<void> {
  await db.setJson(K.botLogin(record.sessionId), record, ttlSec);
  if (record.ownerUserId) {
    try {
      await db.redis.sadd(K.botLoginsByOwner(record.ownerUserId), record.sessionId);
      // Keep owner index roughly in sync with session TTL
      await db.redis.expire(K.botLoginsByOwner(record.ownerUserId), ttlSec + 60);
    } catch {
      /* index is best-effort */
    }
  }
}

export async function getBotLoginSession(
  db: RedisStore,
  sessionId: string,
): Promise<BotLoginSessionRecord | null> {
  return db.getJson<BotLoginSessionRecord>(K.botLogin(sessionId));
}

export async function deleteBotLoginSession(
  db: RedisStore,
  sessionId: string,
  ownerUserId?: string,
): Promise<void> {
  await db.del(K.botLogin(sessionId));
  if (ownerUserId) {
    try {
      await db.redis.srem(K.botLoginsByOwner(ownerUserId), sessionId);
    } catch {
      /* */
    }
  }
}

/**
 * Mark session cancelled for cross-node cancel; poller checks status each tick.
 * Keeps a short TTL so clients can still observe cancelled state briefly.
 */
export async function markBotLoginCancelled(
  db: RedisStore,
  sessionId: string,
  ownerUserId: string,
  message = "已取消",
): Promise<BotLoginSessionRecord | null> {
  const cur = await getBotLoginSession(db, sessionId);
  if (!cur) return null;
  if (cur.ownerUserId !== ownerUserId) return null;
  if (
    cur.status === "confirmed" ||
    cur.status === "expired" ||
    cur.status === "error" ||
    cur.status === "cancelled"
  ) {
    return cur;
  }
  const next: BotLoginSessionRecord = {
    ...cur,
    status: "cancelled",
    message,
    updatedAt: new Date().toISOString(),
  };
  // Short residual TTL after cancel
  await saveBotLoginSession(db, next, 120);
  return next;
}
