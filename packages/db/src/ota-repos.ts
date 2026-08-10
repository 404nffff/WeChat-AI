import { createHash } from "node:crypto";
import type { RedisStore } from "./client.js";
import { nowIso } from "./client.js";
import { K } from "./keys.js";
import {
  isAllowedOtaPath,
  isValidReleaseVersion,
  normalizeOtaPath,
  pathRequiresInstall,
} from "./ota-paths.js";

/** ~384 KiB raw per chunk — safe for Upstash / pipeline sizes. */
export const OTA_BLOB_CHUNK_BYTES = 384 * 1024;

/** Keep last N release versions in index. */
export const OTA_RELEASE_HISTORY = 20;

/** Update job / status TTL (seconds). */
export const OTA_JOB_TTL_SEC = 30 * 60;

export interface ReleaseFileEntry {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseMeta {
  version: string;
  createdAt: string;
  createdBy?: string | null;
  files: ReleaseFileEntry[];
  requiresInstall: boolean;
  totalBytes: number;
  /** Hash of sorted "path:sha256" lines for integrity */
  packSha256: string;
  fileCount: number;
}

export interface ReleaseBlobMeta {
  sha256: string;
  size: number;
  chunks: number;
}

export type NodeUpdatePhase =
  | "pending"
  | "downloading"
  | "applying"
  | "installing"
  | "restarting"
  | "failed"
  | "done";

export interface NodeUpdateJob {
  version: string;
  requestedAt: string;
  requestedBy?: string | null;
  requestedByUsername?: string | null;
  /** Force re-apply even if already on version */
  force?: boolean;
}

export interface NodeUpdateStatus {
  workerId: string;
  version: string;
  phase: NodeUpdatePhase;
  error?: string | null;
  startedAt: string;
  updatedAt: string;
  progress?: {
    done: number;
    total: number;
    bytesDone?: number;
    bytesTotal?: number;
  };
  changedFiles?: number;
  message?: string | null;
}

export function computePackSha256(files: ReleaseFileEntry[]): string {
  const lines = [...files]
    .map((f) => `${f.path}:${f.sha256}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(lines, "utf8").digest("hex");
}

export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function buildReleaseMeta(input: {
  version: string;
  files: ReleaseFileEntry[];
  createdBy?: string | null;
  createdAt?: string;
}): ReleaseMeta {
  const version = input.version.trim();
  if (!isValidReleaseVersion(version)) {
    throw new Error("invalid_version");
  }
  const files: ReleaseFileEntry[] = [];
  for (const f of input.files) {
    const p = normalizeOtaPath(f.path);
    if (!p || !isAllowedOtaPath(p)) {
      throw new Error(`path_not_allowed:${f.path}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(f.sha256)) {
      throw new Error(`invalid_sha256:${f.path}`);
    }
    if (!Number.isFinite(f.size) || f.size < 0) {
      throw new Error(`invalid_size:${f.path}`);
    }
    files.push({
      path: p,
      sha256: f.sha256.toLowerCase(),
      size: Math.floor(f.size),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // dedupe paths
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.path === files[i - 1]!.path) {
      throw new Error(`duplicate_path:${files[i]!.path}`);
    }
  }
  const requiresInstall = files.some((f) => pathRequiresInstall(f.path));
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  return {
    version,
    createdAt: input.createdAt ?? nowIso(),
    createdBy: input.createdBy ?? null,
    files,
    requiresInstall,
    totalBytes,
    packSha256: computePackSha256(files),
    fileCount: files.length,
  };
}

export async function getCurrentRelease(
  db: RedisStore,
): Promise<ReleaseMeta | null> {
  return db.getJson<ReleaseMeta>(K.releaseCurrent);
}

export async function getReleaseMeta(
  db: RedisStore,
  version: string,
): Promise<ReleaseMeta | null> {
  const v = version.trim();
  if (!v) return null;
  return db.getJson<ReleaseMeta>(K.releaseMeta(v));
}

export async function listReleaseVersions(
  db: RedisStore,
  limit = 20,
): Promise<Array<{ version: string; createdAt: string }>> {
  const lim = Math.max(1, Math.min(100, limit));
  const members = (await db.redis.zrevrange(
    K.releaseVersions,
    0,
    lim - 1,
  )) as string[];
  if (!members.length) return [];
  const metas = await db.mgetJson<ReleaseMeta>(
    members.map((v) => K.releaseMeta(v)),
  );
  const out: Array<{ version: string; createdAt: string }> = [];
  members.forEach((v, i) => {
    const m = metas[i];
    out.push({
      version: v,
      createdAt: m?.createdAt ?? "",
    });
  });
  return out;
}

export async function blobExists(
  db: RedisStore,
  sha256: string,
): Promise<boolean> {
  return (await db.redis.exists(K.releaseBlobMeta(sha256.toLowerCase()))) === 1;
}

export async function putBlobChunks(
  db: RedisStore,
  sha256: string,
  data: Buffer,
): Promise<ReleaseBlobMeta> {
  const hash = sha256.toLowerCase();
  if (sha256Buffer(data) !== hash) {
    throw new Error("blob_sha256_mismatch");
  }
  if (await blobExists(db, hash)) {
    const existing = await db.getJson<ReleaseBlobMeta>(K.releaseBlobMeta(hash));
    if (existing) return existing;
  }
  // empty file: one empty chunk
  const n =
    data.length === 0
      ? 1
      : Math.ceil(data.length / OTA_BLOB_CHUNK_BYTES);
  const pipe = db.redis.pipeline();
  for (let i = 0; i < n; i++) {
    const start = i * OTA_BLOB_CHUNK_BYTES;
    const slice =
      data.length === 0
        ? Buffer.alloc(0)
        : data.subarray(start, start + OTA_BLOB_CHUNK_BYTES);
    pipe.set(K.releaseBlobChunk(hash, i), slice);
  }
  const meta: ReleaseBlobMeta = {
    sha256: hash,
    size: data.length,
    chunks: n,
  };
  pipe.set(K.releaseBlobMeta(hash), JSON.stringify(meta));
  await pipe.exec();
  return meta;
}

export async function getBlob(
  db: RedisStore,
  sha256: string,
): Promise<Buffer | null> {
  const hash = sha256.toLowerCase();
  const meta = await db.getJson<ReleaseBlobMeta>(K.releaseBlobMeta(hash));
  if (!meta || meta.chunks < 1) return null;
  const parts: Buffer[] = [];
  for (let i = 0; i < meta.chunks; i++) {
    const buf = await db.redis.getBuffer(K.releaseBlobChunk(hash, i));
    if (buf == null) return null;
    parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }
  const data = Buffer.concat(parts);
  if (data.length !== meta.size) return null;
  if (sha256Buffer(data) !== hash) return null;
  return data;
}

/**
 * Register release meta + set as current. Blobs must already exist for all files.
 */
export async function publishRelease(
  db: RedisStore,
  meta: ReleaseMeta,
  opts?: { setCurrent?: boolean },
): Promise<void> {
  const setCurrent = opts?.setCurrent !== false;
  // verify blobs present
  const missing: string[] = [];
  for (const f of meta.files) {
    if (!(await blobExists(db, f.sha256))) {
      missing.push(f.path);
      if (missing.length >= 10) break;
    }
  }
  if (missing.length) {
    throw new Error(`missing_blobs:${missing.join(",")}`);
  }
  await db.setJson(K.releaseMeta(meta.version), meta);
  const score = Date.parse(meta.createdAt) || Date.now();
  await db.redis.zadd(K.releaseVersions, score, meta.version);
  // trim history
  const card = await db.redis.zcard(K.releaseVersions);
  if (card > OTA_RELEASE_HISTORY) {
    await db.redis.zremrangebyrank(
      K.releaseVersions,
      0,
      card - OTA_RELEASE_HISTORY - 1,
    );
  }
  if (setCurrent) {
    await db.setJson(K.releaseCurrent, meta);
  }
}

export async function setCurrentRelease(
  db: RedisStore,
  version: string,
): Promise<ReleaseMeta> {
  const meta = await getReleaseMeta(db, version);
  if (!meta) throw new Error("release_not_found");
  await db.setJson(K.releaseCurrent, meta);
  return meta;
}

export async function getWorkerUpdateJob(
  db: RedisStore,
  workerId: string,
): Promise<NodeUpdateJob | null> {
  return db.getJson<NodeUpdateJob>(K.workerUpdate(workerId));
}

export async function getWorkerUpdateStatus(
  db: RedisStore,
  workerId: string,
): Promise<NodeUpdateStatus | null> {
  return db.getJson<NodeUpdateStatus>(K.workerUpdateStatus(workerId));
}

export async function getWorkerUpdateStatuses(
  db: RedisStore,
  workerIds: string[],
): Promise<Map<string, NodeUpdateStatus>> {
  const map = new Map<string, NodeUpdateStatus>();
  if (!workerIds.length) return map;
  const rows = await db.mgetJson<NodeUpdateStatus>(
    workerIds.map((id) => K.workerUpdateStatus(id)),
  );
  workerIds.forEach((id, i) => {
    const row = rows[i];
    if (row) map.set(id, row);
  });
  return map;
}

export async function enqueueWorkerUpdate(
  db: RedisStore,
  workerId: string,
  job: NodeUpdateJob,
): Promise<NodeUpdateStatus> {
  const id = workerId.trim();
  if (!id) throw new Error("workerId required");
  if (!isValidReleaseVersion(job.version)) throw new Error("invalid_version");
  const meta = await getReleaseMeta(db, job.version);
  if (!meta) {
    // also accept current pointer version only if meta stored
    const cur = await getCurrentRelease(db);
    if (!cur || cur.version !== job.version) {
      throw new Error("release_not_found");
    }
  }
  const now = nowIso();
  const status: NodeUpdateStatus = {
    workerId: id,
    version: job.version,
    phase: "pending",
    error: null,
    startedAt: now,
    updatedAt: now,
    progress: { done: 0, total: 0 },
    message: "queued",
  };
  await db.setJson(K.workerUpdate(id), job, OTA_JOB_TTL_SEC);
  await db.setJson(K.workerUpdateStatus(id), status, OTA_JOB_TTL_SEC);
  return status;
}

export async function setWorkerUpdateStatus(
  db: RedisStore,
  status: NodeUpdateStatus,
  ttlSec: number = OTA_JOB_TTL_SEC,
): Promise<void> {
  const next = { ...status, updatedAt: nowIso() };
  await db.setJson(
    K.workerUpdateStatus(status.workerId),
    next,
    Math.max(60, ttlSec),
  );
}

export async function clearWorkerUpdateJob(
  db: RedisStore,
  workerId: string,
): Promise<void> {
  await db.del(K.workerUpdate(workerId));
}

/** Diff local hashes against release; returns files that need download. */
export function diffReleaseFiles(
  release: ReleaseMeta,
  localHashes: Map<string, string>,
): ReleaseFileEntry[] {
  const needed: ReleaseFileEntry[] = [];
  for (const f of release.files) {
    if (localHashes.get(f.path) !== f.sha256) {
      needed.push(f);
    }
  }
  return needed;
}

export function releaseSummary(meta: ReleaseMeta | null): {
  version: string | null;
  fileCount: number;
  totalBytes: number;
  requiresInstall: boolean;
  createdAt: string | null;
  createdBy: string | null;
} {
  if (!meta) {
    return {
      version: null,
      fileCount: 0,
      totalBytes: 0,
      requiresInstall: false,
      createdAt: null,
      createdBy: null,
    };
  }
  return {
    version: meta.version,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
    requiresInstall: meta.requiresInstall,
    createdAt: meta.createdAt,
    createdBy: meta.createdBy ?? null,
  };
}
