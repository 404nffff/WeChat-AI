/**
 * Process-local TTL cache for hot Redis keys (session / user).
 * Cuts 1–2 remote RTTs from almost every authenticated API call.
 *
 * Not a correctness layer — always safe to miss and re-fetch Redis.
 * Disable with REDIS_L1_CACHE=false.
 */

const enabled = process.env.REDIS_L1_CACHE !== "false";

interface Entry<T> {
  value: T;
  exp: number;
}

export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly max: number;

  constructor(ttlMs: number, max = 4000) {
    this.ttlMs = Math.max(100, ttlMs);
    this.max = Math.max(32, max);
  }

  get(key: string): T | undefined {
    if (!enabled) return undefined;
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T): void {
    if (!enabled) return;
    if (this.map.size >= this.max) {
      // Drop oldest ~10% (Map insertion order)
      const n = Math.ceil(this.max * 0.1);
      let i = 0;
      for (const k of this.map.keys()) {
        this.map.delete(k);
        if (++i >= n) break;
      }
    }
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }

  del(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Session sid → userId (+ createdAt). Default 45s. */
export const sessionCache = new TtlCache<{ userId: string; createdAt?: string }>(
  Number(process.env.REDIS_L1_SESSION_MS ?? "45000"),
  8000,
);

/** userId → User JSON shape. Default 30s. */
export const userCache = new TtlCache<unknown>(
  Number(process.env.REDIS_L1_USER_MS ?? "30000"),
  4000,
);

/** Default persona id cache. Default 60s. */
export const defaultPersonaIdCache = new TtlCache<string | null>(
  Number(process.env.REDIS_L1_DEFAULT_PERSONA_MS ?? "60000"),
  4,
);

/** Published prompt by personaId. Default 60s. */
export const promptCache = new TtlCache<string | null>(
  Number(process.env.REDIS_L1_PROMPT_MS ?? "60000"),
  500,
);

/**
 * Single-flight TTL snapshot for whole-collection reads.
 *
 * Square listings (public personas / stickers) previously did
 * SMEMBERS + MGET(all) on *every* page / search / sort request. The set only
 * changes on publish / review, so one short-lived process snapshot serves the
 * whole page-flip session, and concurrent requests share one Redis fetch
 * instead of stampeding it.
 *
 * Multi-node note: a peer node sees a publish after at most `ttlMs`. Same
 * tradeoff already taken by promptCache / userCache above.
 */
export class SnapshotCache<T> {
  private value: T | undefined;
  private exp = 0;
  private inflight: Promise<T> | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = Math.max(0, ttlMs);
  }

  async get(load: () => Promise<T>): Promise<T> {
    if (!enabled || this.ttlMs === 0) return load();
    if (this.value !== undefined && Date.now() < this.exp) return this.value;
    if (this.inflight) return this.inflight;
    const p = load()
      .then((v) => {
        this.value = v;
        this.exp = Date.now() + this.ttlMs;
        return v;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  invalidate(): void {
    this.value = undefined;
    this.exp = 0;
  }
}

/** Default TTL for public square snapshots. Keep short — listings must feel live. */
export const SQUARE_SNAPSHOT_MS = Number(
  process.env.REDIS_L1_SQUARE_MS ?? "10000",
);

/**
 * Super-admin id (earliest-created admin). Resolving it scans every user, and
 * /auth/me asks for it on every admin page load.
 */
export const superAdminIdCache = new TtlCache<string | null>(
  Number(process.env.REDIS_L1_SUPERADMIN_MS ?? "120000"),
  4,
);

export function invalidateSuperAdminCache(): void {
  superAdminIdCache.clear();
}

export function invalidateUserCache(userId: string): void {
  userCache.del(userId);
}

export function invalidateSessionCache(sid: string): void {
  sessionCache.del(sid);
}

export function invalidatePromptCache(personaId: string): void {
  promptCache.del(personaId);
}

export function invalidateDefaultPersonaCache(): void {
  defaultPersonaIdCache.clear();
}
