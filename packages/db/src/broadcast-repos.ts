import type { RedisStore } from "./client.js";
import { newId, nowIso } from "./client.js";
import { K } from "./keys.js";
import {
  getBotAccount,
  listBotAccounts,
  listPeers,
  listPeersForBots,
} from "./repos.js";

export type BroadcastScope = "all_bots" | "bots" | "targets";

export type BroadcastStatus =
  | "pending"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export interface BroadcastTarget {
  botId: string;
  peerId: string;
}

export interface BroadcastStats {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
}

export interface BroadcastFailure {
  botId: string;
  peerId: string;
  error: string;
}

export interface BroadcastJob {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  status: BroadcastStatus;
  text: string;
  scope: BroadcastScope;
  botIds: string[];
  targets: BroadcastTarget[];
  /** Snapshot of deliverable (bot, peer) pairs at create time */
  recipients: BroadcastTarget[];
  stats: BroadcastStats;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  failures?: BroadcastFailure[];
  /** Cursor into recipients for resume after crash (optional) */
  cursor?: number;
}

export interface ExpandResult {
  recipients: BroadcastTarget[];
  /** Peers considered but missing context_token (not enqueued) */
  skippedNoToken: number;
  /** Requested bots that do not exist */
  missingBots: string[];
}

const DEFAULT_HISTORY = 100;
const MAX_FAILURES = 20;

function emptyStats(total = 0): BroadcastStats {
  return { total, sent: 0, skipped: 0, failed: 0 };
}

/**
 * Expand a broadcast request into (botId, peerId) pairs that currently have
 * a context_token. Does not filter by approved — only token reachability.
 */
export async function expandBroadcastRecipients(
  db: RedisStore,
  input: {
    scope: BroadcastScope;
    botIds?: string[];
    targets?: BroadcastTarget[];
  },
): Promise<ExpandResult> {
  const missingBots: string[] = [];
  let skippedNoToken = 0;
  const recipients: BroadcastTarget[] = [];

  if (input.scope === "targets") {
    const raw = (input.targets ?? []).filter(
      (t) => t?.botId?.trim() && t?.peerId?.trim(),
    );
    const seen = new Set<string>();
    const pairs: BroadcastTarget[] = [];
    for (const t of raw) {
      const botId = t.botId.trim();
      const peerId = t.peerId.trim();
      const key = `${botId}|${peerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ botId, peerId });
    }
    // One MGET, like the bots branch below — was one GET per target
    const toks = await db.mgetStrings(
      pairs.map((t) => K.contextToken(t.botId, t.peerId)),
    );
    pairs.forEach((t, i) => {
      if (!toks[i]) {
        skippedNoToken++;
        return;
      }
      recipients.push(t);
    });
    return { recipients, skippedNoToken, missingBots };
  }

  let botIds: string[];
  if (input.scope === "all_bots") {
    botIds = (await listBotAccounts(db)).map((b) => b.id);
  } else {
    const requested = [
      ...new Set((input.botIds ?? []).map((id) => id.trim()).filter(Boolean)),
    ];
    const found = await Promise.all(
      requested.map(async (id) => ({ id, bot: await getBotAccount(db, id) })),
    );
    botIds = [];
    for (const row of found) {
      if (row.bot) botIds.push(row.id);
      else missingBots.push(row.id);
    }
  }

  if (!botIds.length) {
    return { recipients, skippedNoToken, missingBots };
  }

  const peers = await listPeersForBots(db, botIds);
  if (!peers.length) {
    return { recipients, skippedNoToken, missingBots };
  }

  // Batch context_token presence via MGET
  const ctxKeys = peers.map((p) =>
    K.contextToken(p.bot_account_id, p.peer_id),
  );
  const tokens = await db.mgetStrings(ctxKeys);
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i]!;
    const tok = tokens[i];
    if (!tok?.trim()) {
      skippedNoToken++;
      continue;
    }
    recipients.push({ botId: p.bot_account_id, peerId: p.peer_id });
  }

  return { recipients, skippedNoToken, missingBots };
}

export async function createBroadcastJob(
  db: RedisStore,
  input: {
    createdBy: string;
    text: string;
    scope: BroadcastScope;
    botIds?: string[];
    targets?: BroadcastTarget[];
    historyLimit?: number;
  },
): Promise<BroadcastJob> {
  const text = input.text.trim();
  if (!text) throw new Error("text required");

  const expanded = await expandBroadcastRecipients(db, {
    scope: input.scope,
    botIds: input.botIds,
    targets: input.targets,
  });

  if (input.scope === "bots" && expanded.missingBots.length) {
    throw new Error(`bots not found: ${expanded.missingBots.join(", ")}`);
  }

  const now = nowIso();
  const job: BroadcastJob = {
    id: newId("bc"),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    text,
    scope: input.scope,
    botIds:
      input.scope === "bots"
        ? [...new Set((input.botIds ?? []).map((x) => x.trim()).filter(Boolean))]
        : [],
    targets:
      input.scope === "targets"
        ? (input.targets ?? [])
            .filter((t) => t?.botId?.trim() && t?.peerId?.trim())
            .map((t) => ({
              botId: t.botId.trim(),
              peerId: t.peerId.trim(),
            }))
        : [],
    recipients: expanded.recipients,
    stats: emptyStats(expanded.recipients.length),
    // Peers without token are pre-skipped at expand; surface as initial skipped
    // so UI can show "will skip M" without inflating total.
    // We keep them out of recipients (cannot send); record count in stats.skipped
    // only when targets mode requested unreachable peers — for all_bots/bots
    // skippedNoToken is informational via expand preview, not job.stats.
    error: null,
    startedAt: null,
    finishedAt: null,
    failures: [],
    cursor: 0,
  };

  // For explicit targets: unreachable ones never entered recipients — count as skipped
  if (input.scope === "targets" && expanded.skippedNoToken > 0) {
    job.stats.skipped = expanded.skippedNoToken;
    job.stats.total = expanded.recipients.length + expanded.skippedNoToken;
  }

  await db.setJson(K.broadcast(job.id), job);
  const history = Math.max(10, input.historyLimit ?? DEFAULT_HISTORY);
  await db.redis.lpush(K.broadcastsAll, job.id);
  await db.redis.ltrim(K.broadcastsAll, 0, history - 1);
  return job;
}

export async function getBroadcastJob(
  db: RedisStore,
  id: string,
): Promise<BroadcastJob | null> {
  return db.getJson<BroadcastJob>(K.broadcast(id));
}

export async function saveBroadcastJob(
  db: RedisStore,
  job: BroadcastJob,
): Promise<void> {
  job.updatedAt = nowIso();
  await db.setJson(K.broadcast(job.id), job);
}

export async function listBroadcastJobs(
  db: RedisStore,
  limit = 50,
): Promise<BroadcastJob[]> {
  const n = Math.max(1, Math.min(200, limit));
  const ids = (await db.redis.lrange(K.broadcastsAll, 0, n - 1)) as string[];
  if (!ids.length) return [];
  const rows = await db.mgetJson<BroadcastJob>(
    ids.map((id) => K.broadcast(id)),
  );
  return rows.filter((j): j is BroadcastJob => Boolean(j));
}

/** Oldest pending job (queue order: list is newest-first, so scan from end). */
export async function findNextPendingBroadcast(
  db: RedisStore,
): Promise<BroadcastJob | null> {
  // Prefer a previously running job that still has work (crash recovery)
  const activeId = (await db.redis.get(K.broadcastActive)) as string | null;
  if (activeId) {
    const active = await getBroadcastJob(db, activeId);
    if (
      active &&
      (active.status === "running" || active.status === "pending") &&
      (active.cursor ?? 0) < (active.recipients?.length ?? 0)
    ) {
      return active;
    }
  }

  // Scan recent jobs for any running first (resume), then oldest pending
  const ids = (await db.redis.lrange(K.broadcastsAll, 0, 99)) as string[];
  if (!ids.length) return null;
  const rows = await db.mgetJson<BroadcastJob>(
    ids.map((id) => K.broadcast(id)),
  );
  const jobs = rows.filter((j): j is BroadcastJob => Boolean(j));

  const running = jobs.find(
    (j) =>
      j.status === "running" &&
      (j.cursor ?? 0) < (j.recipients?.length ?? 0),
  );
  if (running) return running;

  // Pending: process oldest first (list is newest-first → reverse)
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]!;
    if (j.status === "pending") return j;
  }
  return null;
}

export async function hasRunningBroadcast(db: RedisStore): Promise<boolean> {
  const ids = (await db.redis.lrange(K.broadcastsAll, 0, 49)) as string[];
  if (!ids.length) return false;
  const rows = await db.mgetJson<BroadcastJob>(
    ids.map((id) => K.broadcast(id)),
  );
  return rows.some((j) => j?.status === "running");
}

export async function tryAcquireBroadcastLock(
  db: RedisStore,
  jobId: string,
  workerId: string,
  ttlSec = 60,
): Promise<boolean> {
  const ok = await db.redis.set(
    K.broadcastLock(jobId),
    workerId,
    "EX",
    Math.max(15, ttlSec),
    "NX",
  );
  return ok === "OK";
}

export async function renewBroadcastLock(
  db: RedisStore,
  jobId: string,
  workerId: string,
  ttlSec = 60,
): Promise<boolean> {
  const cur = await db.redis.get(K.broadcastLock(jobId));
  if (cur !== workerId) return false;
  await db.redis.set(
    K.broadcastLock(jobId),
    workerId,
    "EX",
    Math.max(15, ttlSec),
  );
  return true;
}

export async function releaseBroadcastLock(
  db: RedisStore,
  jobId: string,
  workerId?: string,
): Promise<void> {
  if (workerId) {
    const cur = await db.redis.get(K.broadcastLock(jobId));
    if (cur && cur !== workerId) return;
  }
  await db.del(K.broadcastLock(jobId));
}

export async function setBroadcastActive(
  db: RedisStore,
  jobId: string | null,
): Promise<void> {
  if (!jobId) {
    await db.del(K.broadcastActive);
    return;
  }
  await db.redis.set(K.broadcastActive, jobId);
}

export async function cancelBroadcastJob(
  db: RedisStore,
  jobId: string,
): Promise<BroadcastJob | null> {
  const job = await getBroadcastJob(db, jobId);
  if (!job) return null;
  if (job.status !== "pending" && job.status !== "running") {
    throw new Error(`cannot cancel job in status ${job.status}`);
  }
  job.status = "cancelled";
  job.finishedAt = nowIso();
  await saveBroadcastJob(db, job);
  const active = await db.redis.get(K.broadcastActive);
  if (active === jobId) {
    await setBroadcastActive(db, null);
  }
  return job;
}

export function pushBroadcastFailure(
  job: BroadcastJob,
  fail: BroadcastFailure,
): void {
  const list = job.failures ?? [];
  list.push(fail);
  if (list.length > MAX_FAILURES) {
    job.failures = list.slice(list.length - MAX_FAILURES);
  } else {
    job.failures = list;
  }
}

/** Peers for a bot with hasContextToken flag (admin send-targets UI). */
export async function listBotSendTargets(
  db: RedisStore,
  botId: string,
): Promise<
  Array<{
    peerId: string;
    displayName: string | null;
    approved: boolean;
    hasContextToken: boolean;
    lastActivityAt: string | null;
  }>
> {
  const bot = await getBotAccount(db, botId);
  if (!bot) return [];
  const peers = await listPeers(db, botId);
  if (!peers.length) return [];
  const tokens = await db.mgetStrings(
    peers.map((p) => K.contextToken(botId, p.peer_id)),
  );
  return peers.map((p, i) => ({
    peerId: p.peer_id,
    displayName: p.display_name,
    approved: Boolean(p.approved),
    hasContextToken: Boolean(tokens[i]?.trim()),
    lastActivityAt: p.last_activity_at ?? null,
  }));
}

/** Public preview for UI before create (does not write). */
export async function previewBroadcast(
  db: RedisStore,
  input: {
    scope: BroadcastScope;
    botIds?: string[];
    targets?: BroadcastTarget[];
  },
): Promise<{
  deliverable: number;
  skippedNoToken: number;
  missingBots: string[];
}> {
  const r = await expandBroadcastRecipients(db, input);
  return {
    deliverable: r.recipients.length,
    skippedNoToken: r.skippedNoToken,
    missingBots: r.missingBots,
  };
}
