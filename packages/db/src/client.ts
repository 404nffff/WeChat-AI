import { randomUUID } from "node:crypto";
import { Redis, type RedisOptions } from "ioredis";

export type Db = RedisStore;

/**
 * Build ioredis options for local Redis or Upstash (rediss:// TLS).
 *
 * Upstash: Console → Connect → copy Redis URL (ioredis):
 *   REDIS_URL=rediss://default:****@xxxx.upstash.io:6379
 *
 * Latency notes (esp. Upstash cross-region):
 * - enableAutoPipelining coalesces concurrent commands in one RTT
 * - keepAlive avoids cold TCP/TLS reconnects
 * - prefer a region close to the API host
 */
export function buildRedisOptions(redisUrl: string): {
  url: string;
  options: RedisOptions;
} {
  const url = redisUrl.trim();
  const isTls =
    url.startsWith("rediss://") ||
    /upstash\.io/i.test(url) ||
    process.env.REDIS_TLS === "true";

  const connectTimeout = Number(
    process.env.REDIS_CONNECT_TIMEOUT_MS ?? "15000",
  );
  const isUpstash = /upstash\.io/i.test(url);

  const options: RedisOptions = {
    // Fewer blind retries on flaky links; fail fast so callers can recover
    maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES ?? "2"),
    enableReadyCheck: true,
    // Connect immediately; queue commands until ready (CLI seed / API both need this)
    lazyConnect: false,
    enableOfflineQueue: true,
    connectTimeout,
    // Critical for remote Redis: concurrent awaits share one pipeline RTT
    enableAutoPipelining:
      process.env.REDIS_AUTO_PIPELINE !== "false",
    // Prevent idle disconnect churn (TLS handshake is expensive)
    keepAlive: Number(process.env.REDIS_KEEPALIVE_MS ?? "10000"),
    // Prefer IPv4 for Upstash (dual-stack DNS can add latency); override with REDIS_FAMILY
    ...(process.env.REDIS_FAMILY
      ? { family: Number(process.env.REDIS_FAMILY) as 0 | 4 | 6 }
      : isUpstash
        ? { family: 4 as const }
        : {}),
    retryStrategy(times) {
      if (times > (isUpstash ? 6 : 8)) return null;
      return Math.min(times * 150, 1500);
    },
    ...(isTls && !url.startsWith("rediss://")
      ? { tls: { rejectUnauthorized: true } }
      : {}),
  };

  let finalUrl = url;
  if (/upstash\.io/i.test(url) && url.startsWith("redis://")) {
    finalUrl = "rediss://" + url.slice("redis://".length);
  }

  return { url: finalUrl, options };
}

/** Optional sampled command hook for admin activity stream (apps/api). */
export type RedisCommandHook = (info: {
  op: string;
  key?: string;
  keys?: number;
  ms?: number;
  ok?: boolean;
}) => void;

let globalCommandHook: RedisCommandHook | null = null;

/** Register process-wide Redis command observer (sampled by caller). */
export function setRedisCommandHook(hook: RedisCommandHook | null): void {
  globalCommandHook = hook;
}

export function getRedisCommandHook(): RedisCommandHook | null {
  return globalCommandHook;
}

export class RedisStore {
  readonly redis: Redis;

  constructor(redisUrl: string) {
    const { url, options } = buildRedisOptions(redisUrl);
    this.redis = new Redis(url, options);
    this.redis.on("error", (err: Error) => {
      if (process.env.LOG_LEVEL === "debug") {
        console.error("[redis]", err.message);
      }
    });
  }

  private note(
    op: string,
    t0: number,
    ok: boolean,
    key?: string,
    keys?: number,
  ): void {
    const hook = globalCommandHook;
    if (!hook) return;
    try {
      hook({ op, key, keys, ms: Date.now() - t0, ok });
    } catch {
      /* never break redis path */
    }
  }

  async ping(): Promise<string> {
    const t0 = Date.now();
    try {
      const r = await this.redis.ping();
      this.note("ping", t0, true);
      return r;
    } catch (e) {
      this.note("ping", t0, false);
      throw e;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.redis.status === "ready") await this.redis.quit();
      else this.redis.disconnect();
    } catch {
      this.redis.disconnect();
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const t0 = Date.now();
    try {
      const raw = await this.redis.get(key);
      this.note("get", t0, true, key);
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (e) {
      this.note("get", t0, false, key);
      throw e;
    }
  }

  /**
   * Run `task` over key slices with bounded concurrency.
   *
   * Chunks used to be awaited one after another, so a 2000-key MGET cost 10
   * serial round trips to a remote Redis. Running them together turns that
   * into ~1 wall-clock RTT. Capped so a huge key list can't dump megabytes
   * into the socket at once.
   */
  private static readonly CHUNK = 200;
  private static readonly MAX_IN_FLIGHT_CHUNKS = 8;

  private async forEachChunk(
    keys: string[],
    task: (slice: string[], offset: number) => Promise<void>,
  ): Promise<void> {
    const { CHUNK, MAX_IN_FLIGHT_CHUNKS } = RedisStore;
    const offsets: number[] = [];
    for (let off = 0; off < keys.length; off += CHUNK) offsets.push(off);
    for (let i = 0; i < offsets.length; i += MAX_IN_FLIGHT_CHUNKS) {
      const wave = offsets.slice(i, i + MAX_IN_FLIGHT_CHUNKS);
      await Promise.all(
        wave.map((off) => task(keys.slice(off, off + CHUNK), off)),
      );
    }
  }

  /**
   * Batch JSON GET via Redis MGET — chunked for Upstash / large fleets.
   * Order matches `keys`; missing / invalid entries are null.
   */
  async mgetJson<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return [];
    const out: (T | null)[] = new Array(keys.length);
    await this.forEachChunk(keys, async (slice, off) => {
      const t0 = Date.now();
      try {
        const raws = (await this.redis.mget(...slice)) as (string | null)[];
        this.note("mget", t0, true, slice[0], slice.length);
        for (let i = 0; i < slice.length; i++) {
          const raw = raws[i];
          if (!raw) {
            out[off + i] = null;
            continue;
          }
          try {
            out[off + i] = JSON.parse(raw) as T;
          } catch {
            out[off + i] = null;
          }
        }
      } catch (e) {
        this.note("mget", t0, false, slice[0], slice.length);
        throw e;
      }
    });
    return out;
  }

  /**
   * Batch string GET (non-JSON) via MGET — for assignment keys etc.
   * Order matches `keys`; missing entries are null.
   */
  async mgetStrings(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    const out: (string | null)[] = new Array(keys.length);
    await this.forEachChunk(keys, async (slice, off) => {
      const t0 = Date.now();
      try {
        const raws = (await this.redis.mget(...slice)) as (string | null)[];
        this.note("mget", t0, true, slice[0], slice.length);
        for (let i = 0; i < slice.length; i++) {
          out[off + i] = raws[i] ?? null;
        }
      } catch (e) {
        this.note("mget", t0, false, slice[0], slice.length);
        throw e;
      }
    });
    return out;
  }

  async setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    const raw = JSON.stringify(value);
    const t0 = Date.now();
    try {
      if (ttlSec && ttlSec > 0) {
        await this.redis.set(key, raw, "EX", ttlSec);
      } else {
        await this.redis.set(key, raw);
      }
      this.note("set", t0, true, key);
    } catch (e) {
      this.note("set", t0, false, key);
      throw e;
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    const t0 = Date.now();
    try {
      await this.redis.del(...keys);
      this.note("del", t0, true, keys[0], keys.length);
    } catch (e) {
      this.note("del", t0, false, keys[0], keys.length);
      throw e;
    }
  }

  /** Run a pipeline in chunks to avoid Upstash / huge-pipeline stalls. */
  private async pipelineChunked(
    keys: string[],
    add: (pipe: ReturnType<Redis["pipeline"]>, key: string) => void,
  ): Promise<Array<[Error | null, unknown] | null>> {
    if (!keys.length) return [];
    const out: Array<[Error | null, unknown] | null> = new Array(keys.length);
    await this.forEachChunk(keys, async (slice, off) => {
      const pipe = this.redis.pipeline();
      for (const k of slice) add(pipe, k);
      const res = await pipe.exec();
      for (let i = 0; i < slice.length; i++) {
        out[off + i] = res?.[i] ?? null;
      }
    });
    return out;
  }

  /** Per-key EXISTS via pipeline (multi-key EXISTS only returns a count). */
  async existsMany(keys: string[]): Promise<boolean[]> {
    const res = await this.pipelineChunked(keys, (pipe, k) => pipe.exists(k));
    return res.map((row) => Number(row?.[1] ?? 0) > 0);
  }

  /** Per-key SCARD via pipeline. */
  async scardMany(keys: string[]): Promise<number[]> {
    const res = await this.pipelineChunked(keys, (pipe, k) => pipe.scard(k));
    return res.map((row) => Number(row?.[1] ?? 0));
  }

  /** Per-key SMEMBERS via pipeline. */
  async smembersMany(keys: string[]): Promise<string[][]> {
    const res = await this.pipelineChunked(keys, (pipe, k) => pipe.smembers(k));
    return res.map((row) => {
      const v = row?.[1];
      return Array.isArray(v) ? (v as string[]) : [];
    });
  }

  /** Per-key GET via pipeline (for mixed key patterns where MGET is awkward). */
  async getMany(keys: string[]): Promise<(string | null)[]> {
    return this.mgetStrings(keys);
  }
}

export function openDatabase(redisUrl: string): RedisStore {
  return new RedisStore(redisUrl);
}

/** @deprecated no-op migrate for Redis */
export async function migrate(_db: RedisStore): Promise<void> {
  // Redis is schema-less
}

export function newId(prefix = ""): string {
  const id = randomUUID().replace(/-/g, "");
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Calendar day keys (usage, proactive caps, p2p daily limits) use China local date. */
export const DEFAULT_DAY_TZ = "Asia/Shanghai";

/**
 * YYYY-MM-DD for `d` in `timeZone` (default Asia/Shanghai).
 * Do NOT use `toISOString().slice(0, 10)` for "today" — that is UTC and is still
 * the previous calendar day in China between 00:00 and 08:00 CST.
 */
export function dayKey(d: Date = new Date(), timeZone = DEFAULT_DAY_TZ): string {
  try {
    // en-CA yields YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone?.trim() || DEFAULT_DAY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Shift a calendar day by `n` days in `timeZone` (negative = past).
 * Safer than `Date.now() ± n*86400000` then UTC-slicing around midnight/DST edges.
 */
export function dayKeyOffset(
  n: number,
  from: Date = new Date(),
  timeZone = DEFAULT_DAY_TZ,
): string {
  const tz = timeZone?.trim() || DEFAULT_DAY_TZ;
  let y: number;
  let m: number;
  let day: number;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(from);
    y = Number(parts.find((p) => p.type === "year")?.value);
    m = Number(parts.find((p) => p.type === "month")?.value);
    day = Number(parts.find((p) => p.type === "day")?.value);
  } catch {
    y = from.getUTCFullYear();
    m = from.getUTCMonth() + 1;
    day = from.getUTCDate();
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(day)) {
    return dayKey(new Date(from.getTime() + n * 86400000), tz);
  }
  // Calendar arithmetic in UTC noon space (no DST in Asia/Shanghai)
  const shifted = new Date(Date.UTC(y, m - 1, day + n, 12, 0, 0));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
