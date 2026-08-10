/**
 * Simple sliding-window rate limiter (in-memory, per process).
 *
 * Keys are attacker-influenced (client IP on the public /cdn/s route, username
 * on login), so the map is bounded. Evicting a bucket is always safe in this
 * direction: the key simply gets a fresh window, it can never turn an allow
 * into a deny.
 */

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(
    private max: number,
    private windowMs: number,
    maxKeys = 20_000,
  ) {
    this.maxKeys = Math.max(64, maxKeys);
  }

  /**
   * Runtime settings reload. Existing buckets are kept: raising the cap frees
   * callers immediately, lowering it applies from the next request onward.
   */
  setLimits(max: number, windowMs = this.windowMs): void {
    this.max = Math.max(1, max);
    this.windowMs = Math.max(1_000, windowMs);
  }

  /** Drop timestamps that fell out of the window, in place (no re-allocation). */
  private prune(list: number[], cutoff: number): number[] {
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    if (i > 0) list.splice(0, i);
    return list;
  }

  private evictIfFull(): void {
    if (this.hits.size < this.maxKeys) return;
    // Drop the oldest ~10% by insertion order
    const n = Math.ceil(this.maxKeys * 0.1);
    let i = 0;
    for (const k of this.hits.keys()) {
      this.hits.delete(k);
      if (++i >= n) break;
    }
  }

  /** Returns true if the key is allowed; records a hit when allowed. */
  tryTake(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(key);
    const prev = existing ? this.prune(existing, cutoff) : [];
    if (prev.length >= this.max) {
      // `prev` is the same array instance already in the map
      return false;
    }
    if (!prev.length) {
      // Window went empty — forget the key so idle callers stop occupying it,
      // then re-insert at the tail so eviction order stays LRU-ish.
      this.hits.delete(key);
      this.evictIfFull();
    }
    prev.push(now);
    this.hits.set(key, prev);
    return true;
  }

  remaining(key: string, now = Date.now()): number {
    const cutoff = now - this.windowMs;
    const existing = this.hits.get(key);
    const prev = existing ? this.prune(existing, cutoff) : [];
    return Math.max(0, this.max - prev.length);
  }

  /** Tracked key count — for tests / diagnostics. */
  get size(): number {
    return this.hits.size;
  }
}
