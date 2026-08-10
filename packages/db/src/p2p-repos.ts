import { randomBytes } from "node:crypto";
import type { RedisStore } from "./client.js";
import { dayKey, newId, nowIso } from "./client.js";
import { K } from "./keys.js";
import { getBotCredentials, getContextToken, getUser } from "./repos.js";

// ── Types ──────────────────────────────────────────────

export interface PeerEndpoint {
  botId: string;
  peerId: string;
}

export interface PeerIdentity extends PeerEndpoint {
  userId: string;
  username: string;
}

export interface UserWechatBind {
  userId: string;
  username: string;
  botId: string;
  peerId: string;
  boundAt: string;
}

export interface BindCodeRecord {
  code: string;
  userId: string;
  username: string;
  createdAt: string;
}

export interface ConnectRequest {
  id: string;
  from: PeerIdentity;
  to: PeerIdentity;
  createdAt: string;
}

export interface P2PSession {
  id: string;
  a: PeerIdentity;
  b: PeerIdentity;
  createdAt: string;
  lastActivityAt: string;
}

// ── Helpers ────────────────────────────────────────────

const BIND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function peerKey(ep: PeerEndpoint): string {
  return `${ep.botId}|${ep.peerId}`;
}

export function generateBindCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BIND_CODE_ALPHABET[bytes[i]! % BIND_CODE_ALPHABET.length]!;
  }
  return out;
}

function sameEndpoint(a: PeerEndpoint, b: PeerEndpoint): boolean {
  return a.botId === b.botId && a.peerId === b.peerId;
}

// ── Bind codes ─────────────────────────────────────────

export async function createBindCode(
  db: RedisStore,
  userId: string,
  username: string,
  ttlSec: number,
): Promise<BindCodeRecord> {
  // Best-effort: try a few times to avoid collision
  for (let i = 0; i < 8; i++) {
    const code = generateBindCode(6);
    const rec: BindCodeRecord = {
      code,
      userId,
      username,
      createdAt: nowIso(),
    };
    const ok = await db.redis.set(
      K.bindCode(code),
      JSON.stringify(rec),
      "EX",
      Math.max(30, ttlSec),
      "NX",
    );
    if (ok === "OK") return rec;
  }
  throw new Error("failed to allocate bind code");
}

/**
 * Atomically consume a bind code (GET + DEL). Returns null if missing/expired.
 */
export async function consumeBindCode(
  db: RedisStore,
  code: string,
): Promise<BindCodeRecord | null> {
  const rawCode = code.trim().toUpperCase();
  if (!rawCode) return null;
  const key = K.bindCode(rawCode);
  const raw = await db.redis.get(key);
  if (!raw) return null;
  await db.redis.del(key);
  try {
    return JSON.parse(raw) as BindCodeRecord;
  } catch {
    return null;
  }
}

// ── Primary bind ───────────────────────────────────────

export async function getBindByUser(
  db: RedisStore,
  userId: string,
): Promise<UserWechatBind | null> {
  return db.getJson<UserWechatBind>(K.bindUser(userId));
}

export async function getBindByPeer(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<UserWechatBind | null> {
  const userId = await db.redis.get(K.bindPeer(botId, peerId));
  if (!userId) return null;
  return getBindByUser(db, userId);
}

/**
 * Set primary WeChat bind for a LINUX DO user.
 * Replaces previous bind for that user and clears reverse pointer of old peer.
 * Also ends any connect request / p2p session for both old and new endpoints.
 */
export async function setPrimaryBind(
  db: RedisStore,
  bind: UserWechatBind,
): Promise<{ previous: UserWechatBind | null }> {
  const previous = await getBindByUser(db, bind.userId);

  // If this peer was bound to someone else, clear that user's bind
  const existingPeerOwner = await db.redis.get(
    K.bindPeer(bind.botId, bind.peerId),
  );
  if (existingPeerOwner && existingPeerOwner !== bind.userId) {
    const other = await getBindByUser(db, existingPeerOwner);
    if (
      other &&
      other.botId === bind.botId &&
      other.peerId === bind.peerId
    ) {
      await clearBindPointers(db, other);
      await endSessionsAndRequestsForPeer(db, other.botId, other.peerId);
    }
  }

  if (previous) {
    await clearBindPointers(db, previous);
    await endSessionsAndRequestsForPeer(db, previous.botId, previous.peerId);
  }

  // End state on the new peer endpoint too
  await endSessionsAndRequestsForPeer(db, bind.botId, bind.peerId);

  await db.setJson(K.bindUser(bind.userId), bind);
  await db.redis.set(K.bindPeer(bind.botId, bind.peerId), bind.userId);
  return { previous };
}

export async function clearPrimaryBind(
  db: RedisStore,
  userId: string,
): Promise<UserWechatBind | null> {
  const bind = await getBindByUser(db, userId);
  if (!bind) return null;
  await endSessionsAndRequestsForPeer(db, bind.botId, bind.peerId);
  await clearBindPointers(db, bind);
  return bind;
}

async function clearBindPointers(
  db: RedisStore,
  bind: UserWechatBind,
): Promise<void> {
  await db.del(K.bindUser(bind.userId));
  const mapped = await db.redis.get(K.bindPeer(bind.botId, bind.peerId));
  if (mapped === bind.userId) {
    await db.del(K.bindPeer(bind.botId, bind.peerId));
  }
}

// ── Reachability ───────────────────────────────────────

/** Target can receive pushes if bind exists, context_token exists, bot has credentials. */
export async function isPeerReachable(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<boolean> {
  const [token, creds] = await Promise.all([
    getContextToken(db, botId, peerId),
    getBotCredentials(db, botId),
  ]);
  return Boolean(token && creds?.botToken);
}

// ── Connect requests ───────────────────────────────────

export async function getConnectRequest(
  db: RedisStore,
  requestId: string,
): Promise<ConnectRequest | null> {
  return db.getJson<ConnectRequest>(K.connectReq(requestId));
}

export async function getOutboundRequestId(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<string | null> {
  return db.redis.get(K.connectFrom(botId, peerId));
}

export async function getInboundRequestId(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<string | null> {
  return db.redis.get(K.connectTo(botId, peerId));
}

export async function getOutboundRequest(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<ConnectRequest | null> {
  const id = await getOutboundRequestId(db, botId, peerId);
  if (!id) return null;
  const req = await getConnectRequest(db, id);
  if (!req) {
    await db.del(K.connectFrom(botId, peerId));
    return null;
  }
  return req;
}

export async function getInboundRequest(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<ConnectRequest | null> {
  const id = await getInboundRequestId(db, botId, peerId);
  if (!id) return null;
  const req = await getConnectRequest(db, id);
  if (!req) {
    await db.del(K.connectTo(botId, peerId));
    return null;
  }
  return req;
}

/**
 * Create a connect request. Fails (returns null + reason) if either side busy
 * or keys cannot be claimed with NX.
 */
export async function createConnectRequest(
  db: RedisStore,
  from: PeerIdentity,
  to: PeerIdentity,
  ttlSec: number,
): Promise<
  | { ok: true; request: ConnectRequest }
  | { ok: false; reason: "from_busy" | "to_busy" | "race" }
> {
  // Pre-check
  const [fromOut, fromIn, toOut, toIn, fromSess, toSess] = await Promise.all([
    getOutboundRequestId(db, from.botId, from.peerId),
    getInboundRequestId(db, from.botId, from.peerId),
    getOutboundRequestId(db, to.botId, to.peerId),
    getInboundRequestId(db, to.botId, to.peerId),
    getP2PSessionId(db, from.botId, from.peerId),
    getP2PSessionId(db, to.botId, to.peerId),
  ]);
  if (fromOut || fromIn || fromSess) return { ok: false, reason: "from_busy" };
  if (toOut || toIn || toSess) return { ok: false, reason: "to_busy" };

  const request: ConnectRequest = {
    id: newId("creq"),
    from,
    to,
    createdAt: nowIso(),
  };
  const ttl = Math.max(30, ttlSec);

  const fromOk = await db.redis.set(
    K.connectFrom(from.botId, from.peerId),
    request.id,
    "EX",
    ttl,
    "NX",
  );
  if (fromOk !== "OK") return { ok: false, reason: "race" };

  const toOk = await db.redis.set(
    K.connectTo(to.botId, to.peerId),
    request.id,
    "EX",
    ttl,
    "NX",
  );
  if (toOk !== "OK") {
    await db.del(K.connectFrom(from.botId, from.peerId));
    return { ok: false, reason: "race" };
  }

  await db.setJson(K.connectReq(request.id), request, ttl);
  return { ok: true, request };
}

export async function deleteConnectRequest(
  db: RedisStore,
  request: ConnectRequest,
): Promise<void> {
  await db.del(
    K.connectReq(request.id),
    K.connectFrom(request.from.botId, request.from.peerId),
    K.connectTo(request.to.botId, request.to.peerId),
  );
}

// ── Sessions ───────────────────────────────────────────

export async function getP2PSessionId(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<string | null> {
  return db.redis.get(K.p2pPeer(botId, peerId));
}

export async function getP2PSession(
  db: RedisStore,
  sessionId: string,
): Promise<P2PSession | null> {
  return db.getJson<P2PSession>(K.p2pSession(sessionId));
}

export async function getP2PSessionForPeer(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<P2PSession | null> {
  const id = await getP2PSessionId(db, botId, peerId);
  if (!id) return null;
  const sess = await getP2PSession(db, id);
  if (!sess) {
    await db.del(K.p2pPeer(botId, peerId));
    return null;
  }
  return sess;
}

export async function createP2PSession(
  db: RedisStore,
  a: PeerIdentity,
  b: PeerIdentity,
  idleTtlSec: number,
): Promise<P2PSession> {
  const now = nowIso();
  const session: P2PSession = {
    id: newId("p2p"),
    a,
    b,
    createdAt: now,
    lastActivityAt: now,
  };
  const ttl = Math.max(60, idleTtlSec);
  await db.setJson(K.p2pSession(session.id), session, ttl);
  await db.redis.set(K.p2pPeer(a.botId, a.peerId), session.id, "EX", ttl);
  await db.redis.set(K.p2pPeer(b.botId, b.peerId), session.id, "EX", ttl);
  return session;
}

export async function touchP2PSession(
  db: RedisStore,
  session: P2PSession,
  idleTtlSec: number,
): Promise<P2PSession> {
  const ttl = Math.max(60, idleTtlSec);
  const next: P2PSession = {
    ...session,
    lastActivityAt: nowIso(),
  };
  // Runs on every relayed message — one round trip, not three
  await db.redis
    .pipeline()
    .set(K.p2pSession(session.id), JSON.stringify(next), "EX", ttl)
    .set(K.p2pPeer(session.a.botId, session.a.peerId), session.id, "EX", ttl)
    .set(K.p2pPeer(session.b.botId, session.b.peerId), session.id, "EX", ttl)
    .exec();
  return next;
}

export async function deleteP2PSession(
  db: RedisStore,
  session: P2PSession,
): Promise<void> {
  await db.del(
    K.p2pSession(session.id),
    K.p2pPeer(session.a.botId, session.a.peerId),
    K.p2pPeer(session.b.botId, session.b.peerId),
  );
}

export function otherParty(
  session: P2PSession,
  botId: string,
  peerId: string,
): PeerIdentity | null {
  if (sameEndpoint(session.a, { botId, peerId })) return session.b;
  if (sameEndpoint(session.b, { botId, peerId })) return session.a;
  return null;
}

export function selfParty(
  session: P2PSession,
  botId: string,
  peerId: string,
): PeerIdentity | null {
  if (sameEndpoint(session.a, { botId, peerId })) return session.a;
  if (sameEndpoint(session.b, { botId, peerId })) return session.b;
  return null;
}

// ── Cleanup helpers ────────────────────────────────────

async function endSessionsAndRequestsForPeer(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<void> {
  const sess = await getP2PSessionForPeer(db, botId, peerId);
  if (sess) await deleteP2PSession(db, sess);

  const out = await getOutboundRequest(db, botId, peerId);
  if (out) await deleteConnectRequest(db, out);

  const inn = await getInboundRequest(db, botId, peerId);
  if (inn) await deleteConnectRequest(db, inn);
}

// ── Daily request rate ─────────────────────────────────

export async function incrP2PRequestDay(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<number> {
  const day = dayKey();
  const key = K.p2pRequestDay(botId, peerId, day);
  const n = await db.redis.incr(key);
  if (n === 1) await db.redis.expire(key, 48 * 3600);
  return n;
}

export async function getP2PRequestDayCount(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<number> {
  const day = dayKey();
  const raw = await db.redis.get(K.p2pRequestDay(botId, peerId, day));
  return Number(raw || 0);
}

// ── Block list (LINUX DO userId → SET of blocked userIds) ─

/** True if either side has blocked the other. */
export async function isBlockedEitherWay(
  db: RedisStore,
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const [ab, ba] = await Promise.all([
    db.redis.sismember(K.blockSet(userIdA), userIdB),
    db.redis.sismember(K.blockSet(userIdB), userIdA),
  ]);
  return ab === 1 || ba === 1;
}

export async function blockUser(
  db: RedisStore,
  blockerUserId: string,
  blockedUserId: string,
): Promise<{ ok: true } | { ok: false; reason: "self" | "already" }> {
  if (!blockerUserId || !blockedUserId) {
    return { ok: false, reason: "self" };
  }
  if (blockerUserId === blockedUserId) {
    return { ok: false, reason: "self" };
  }
  const added = await db.redis.sadd(K.blockSet(blockerUserId), blockedUserId);
  // End any in-flight connect / session between their WeChat endpoints
  await endRelationsBetweenUsers(db, blockerUserId, blockedUserId);
  if (added === 0) return { ok: false, reason: "already" };
  return { ok: true };
}

export async function unblockUser(
  db: RedisStore,
  blockerUserId: string,
  blockedUserId: string,
): Promise<boolean> {
  const n = await db.redis.srem(K.blockSet(blockerUserId), blockedUserId);
  return n > 0;
}

export async function listBlockedUserIds(
  db: RedisStore,
  userId: string,
): Promise<string[]> {
  return (await db.redis.smembers(K.blockSet(userId))) as string[];
}

/**
 * End P2P sessions / requests between two LINUX DO users (if both have binds).
 */
async function endRelationsBetweenUsers(
  db: RedisStore,
  userIdA: string,
  userIdB: string,
): Promise<void> {
  const [bindA, bindB] = await Promise.all([
    getBindByUser(db, userIdA),
    getBindByUser(db, userIdB),
  ]);
  if (bindA) await endSessionsAndRequestsForPeer(db, bindA.botId, bindA.peerId);
  if (bindB) await endSessionsAndRequestsForPeer(db, bindB.botId, bindB.peerId);
}

// ── Accept helper ──────────────────────────────────────

/**
 * Accept inbound request: delete request, create session.
 * Returns null if request gone / not for this peer.
 */
export async function acceptConnectRequest(
  db: RedisStore,
  botId: string,
  peerId: string,
  idleTtlSec: number,
): Promise<
  | { ok: true; session: P2PSession; request: ConnectRequest }
  | { ok: false; reason: "no_request" | "not_target" }
> {
  const request = await getInboundRequest(db, botId, peerId);
  if (!request) return { ok: false, reason: "no_request" };
  if (request.to.botId !== botId || request.to.peerId !== peerId) {
    return { ok: false, reason: "not_target" };
  }

  // Clear request first so neither side can double-accept
  await deleteConnectRequest(db, request);

  // Ensure no leftover session on either side
  const [sa, sb] = await Promise.all([
    getP2PSessionForPeer(db, request.from.botId, request.from.peerId),
    getP2PSessionForPeer(db, request.to.botId, request.to.peerId),
  ]);
  if (sa) await deleteP2PSession(db, sa);
  if (sb && sb.id !== sa?.id) await deleteP2PSession(db, sb);

  const session = await createP2PSession(
    db,
    request.from,
    request.to,
    idleTtlSec,
  );
  return { ok: true, session, request };
}

/** Resolve bind + username for display if user still exists. */
export async function resolveBindIdentity(
  db: RedisStore,
  botId: string,
  peerId: string,
): Promise<PeerIdentity | null> {
  const bind = await getBindByPeer(db, botId, peerId);
  if (!bind) return null;
  const user = await getUser(db, bind.userId);
  const username = user?.username || bind.username;
  return {
    botId: bind.botId,
    peerId: bind.peerId,
    userId: bind.userId,
    username,
  };
}
