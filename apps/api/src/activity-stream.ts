/**
 * Admin live activity bus: in-process listeners + Redis Pub/Sub fan-in.
 *
 * redis.cmd samples stay local (never LPUSH) to avoid Upstash recursion.
 * Important domain events (message / worker / llm) may PUBLISH + optional backlog.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "@wechat-ai/db";
import { K } from "@wechat-ai/db";

export type StreamLevel = "info" | "warn" | "error";

export type StreamEvent = {
  id: string;
  ts: string;
  type: string;
  level?: StreamLevel;
  source?: string;
  summary: string;
  data?: Record<string, unknown>;
};

export type EmitInput = {
  type: string;
  summary: string;
  level?: StreamLevel;
  source?: string;
  data?: Record<string, unknown>;
  /** Override auto id */
  id?: string;
  /** Override ISO ts */
  ts?: string;
};

export type EmitOpts = {
  /** LPUSH to Redis recent list (default: true for important domain types) */
  persist?: boolean;
  /** PUBLISH to fleet channel (default: true except redis.cmd / stream.*) */
  fleet?: boolean;
};

export type ActivityBusOptions = {
  db: Db;
  source?: string;
  enabled?: boolean;
  /** Max events accepted per second (process-local) */
  maxEps?: number;
  ringSize?: number;
  backlogSize?: number;
  /** Redis cmd sample rate 0..1 */
  redisSample?: number;
  /** Max redis.cmd events per second */
  redisMaxEps?: number;
};

type Listener = (ev: StreamEvent) => void;

const IMPORTANT_PREFIXES = ["message.", "worker.", "llm."];

function isImportantType(type: string): boolean {
  return IMPORTANT_PREFIXES.some((p) => type.startsWith(p));
}

function shouldFleetDefault(type: string): boolean {
  if (type.startsWith("redis.")) return false;
  if (type.startsWith("stream.")) return false;
  return isImportantType(type);
}

function shouldPersistDefault(type: string): boolean {
  return shouldFleetDefault(type);
}

/** Truncate message body for stream privacy. */
export function previewText(
  text: string | null | undefined,
  maxChars: number,
): { preview: string; len: number; truncated: boolean } {
  const raw = text ?? "";
  const len = raw.length;
  if (len <= maxChars) {
    return { preview: raw, len, truncated: false };
  }
  return {
    preview: raw.slice(0, Math.max(0, maxChars)) + "…",
    len,
    truncated: true,
  };
}

/** Redact Redis key for stream display (keep pattern, drop secrets-ish tails). */
export function redactRedisKey(key: string | undefined | null): string {
  if (!key) return "";
  const s = String(key);
  // session / creds / blob: keep prefix only
  if (/:creds$/i.test(s) || /:blob$/i.test(s) || /:session:/i.test(s)) {
    const parts = s.split(":");
    return parts.slice(0, Math.min(3, parts.length)).join(":") + ":*";
  }
  if (s.length > 96) return s.slice(0, 93) + "…";
  return s;
}

export class ActivityBus {
  private readonly db: Db;
  private readonly source: string;
  /** Admin-editable at runtime — see applyRuntimeOptions(). */
  private enabled: boolean;
  private maxEps: number;
  private readonly ringSize: number;
  private readonly backlogSize: number;
  private redisSample: number;
  private readonly redisMaxEps: number;

  private ring: StreamEvent[] = [];
  private listeners = new Set<Listener>();
  private sub: ReturnType<Db["redis"]["duplicate"]> | null = null;
  private started = false;
  private closed = false;

  private windowStart = Date.now();
  private windowCount = 0;
  private dropped = 0;
  private lastDropReport = 0;

  private redisWindowStart = Date.now();
  private redisWindowCount = 0;

  /** Dedup fleet + local echoes (id → expiry ms) */
  private seen = new Map<string, number>();
  private readonly seenTtlMs = 60_000;

  constructor(opts: ActivityBusOptions) {
    this.db = opts.db;
    this.source = opts.source || "api";
    this.enabled = opts.enabled !== false;
    this.maxEps = Math.max(5, opts.maxEps ?? 80);
    this.ringSize = Math.max(50, opts.ringSize ?? 500);
    this.backlogSize = Math.max(50, opts.backlogSize ?? 300);
    this.redisSample = Math.min(1, Math.max(0, opts.redisSample ?? 0.08));
    this.redisMaxEps = Math.max(1, opts.redisMaxEps ?? 15);
  }

  /**
   * Apply admin-editable settings in place (runtime settings reload).
   * Turning the stream on lazily opens the Redis subscriber, which start()
   * would otherwise only ever do at boot.
   */
  applyRuntimeOptions(patch: {
    enabled?: boolean;
    maxEps?: number;
    redisSample?: number;
  }): void {
    if (patch.maxEps !== undefined) this.maxEps = Math.max(5, patch.maxEps);
    if (patch.redisSample !== undefined) {
      this.redisSample = Math.min(1, Math.max(0, patch.redisSample));
    }
    if (patch.enabled === undefined || patch.enabled === this.enabled) return;
    this.enabled = patch.enabled;
    if (this.enabled && !this.started && !this.closed) {
      void this.start().catch(() => undefined);
    }
  }

  isEnabled(): boolean {
    return this.enabled && !this.closed;
  }

  getSource(): string {
    return this.source;
  }

  async start(): Promise<void> {
    if (!this.enabled || this.started || this.closed) return;
    this.started = true;
    try {
      const sub = this.db.redis.duplicate();
      this.sub = sub;
      sub.on("error", (err: Error) => {
        if (process.env.LOG_LEVEL === "debug") {
          console.error("[stream] sub error", err.message);
        }
      });
      await sub.subscribe(K.streamChannel);
      sub.on("message", (_ch: string, raw: string) => {
        try {
          const ev = JSON.parse(raw) as StreamEvent;
          if (!ev?.id || !ev?.type) return;
          this.ingestRemote(ev);
        } catch {
          /* ignore bad payload */
        }
      });
    } catch (err) {
      console.warn(
        "[stream] fleet subscribe unavailable:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    if (this.sub) {
      try {
        await this.sub.unsubscribe(K.streamChannel);
        this.sub.disconnect();
      } catch {
        /* */
      }
      this.sub = null;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Newest-first local ring snapshot. */
  recentLocal(limit = 100): StreamEvent[] {
    const n = Math.max(1, Math.min(limit, this.ring.length));
    return this.ring.slice(0, n);
  }

  async recentMerged(limit = 100): Promise<StreamEvent[]> {
    const n = Math.max(1, Math.min(limit, 300));
    let remote: StreamEvent[] = [];
    try {
      const raw = await this.db.redis.lrange(K.streamRecent, 0, n - 1);
      remote = raw
        .map((r) => {
          try {
            return JSON.parse(r) as StreamEvent;
          } catch {
            return null;
          }
        })
        .filter((x): x is StreamEvent => !!x?.id);
    } catch {
      remote = [];
    }
    const local = this.recentLocal(n);
    const map = new Map<string, StreamEvent>();
    for (const ev of [...remote, ...local]) {
      if (!map.has(ev.id)) map.set(ev.id, ev);
    }
    return [...map.values()]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, n);
  }

  /**
   * Emit a stream event. Rate-limited; may drop under load.
   */
  emit(input: EmitInput, opts: EmitOpts = {}): StreamEvent | null {
    if (!this.isEnabled()) return null;

    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.maxEps) {
      this.dropped++;
      this.maybeReportDrops(now);
      return null;
    }
    this.windowCount++;

    const ev: StreamEvent = {
      id: input.id || `sev_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      ts: input.ts || new Date().toISOString(),
      type: input.type,
      level: input.level || "info",
      source: input.source || this.source,
      summary: input.summary,
      data: input.data,
    };

    this.deliverLocal(ev);

    const fleet = opts.fleet ?? shouldFleetDefault(ev.type);
    const persist = opts.persist ?? shouldPersistDefault(ev.type);

    if (fleet || persist) {
      void this.fanOut(ev, { fleet, persist });
    }

    return ev;
  }

  /** Sampled redis command hook (local only). */
  noteRedisCmd(info: {
    op: string;
    key?: string;
    keys?: number;
    ms?: number;
    ok?: boolean;
  }): void {
    if (!this.isEnabled() || this.redisSample <= 0) return;

    const now = Date.now();
    if (now - this.redisWindowStart >= 1000) {
      this.redisWindowStart = now;
      this.redisWindowCount = 0;
    }
    if (this.redisWindowCount >= this.redisMaxEps) return;
    if (Math.random() > this.redisSample) return;
    this.redisWindowCount++;

    const keyLabel = info.key
      ? redactRedisKey(info.key)
      : info.keys != null
        ? `${info.keys} key(s)`
        : "";
    const msPart = info.ms != null ? ` ${Math.round(info.ms)}ms` : "";
    const okPart = info.ok === false ? " fail" : "";
    this.emit(
      {
        type: "redis.cmd",
        level: info.ok === false ? "warn" : "info",
        summary: `${info.op.toUpperCase()}${keyLabel ? " " + keyLabel : ""}${msPart}${okPart}`,
        data: {
          op: info.op,
          key: keyLabel || undefined,
          keys: info.keys,
          ms: info.ms,
          ok: info.ok !== false,
        },
      },
      { fleet: false, persist: false },
    );
  }

  private maybeReportDrops(now: number): void {
    if (this.dropped <= 0) return;
    if (now - this.lastDropReport < 5000) return;
    const n = this.dropped;
    this.dropped = 0;
    this.lastDropReport = now;
    // Bypass rate limit for meta by delivering directly
    const ev: StreamEvent = {
      id: `sev_drop_${now.toString(36)}`,
      ts: new Date().toISOString(),
      type: "stream.dropped",
      level: "warn",
      source: this.source,
      summary: `rate limit: dropped ${n} event(s) in last window`,
      data: { dropped: n, maxEps: this.maxEps },
    };
    this.deliverLocal(ev);
  }

  private ingestRemote(ev: StreamEvent): void {
    if (this.markSeen(ev.id)) return;
    // Do not re-publish remote events
    this.pushRing(ev);
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* listener errors must not break bus */
      }
    }
  }

  private deliverLocal(ev: StreamEvent): void {
    if (this.markSeen(ev.id)) return;
    this.pushRing(ev);
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* */
      }
    }
  }

  private markSeen(id: string): boolean {
    const now = Date.now();
    if (this.seen.size > 4000) {
      for (const [k, exp] of this.seen) {
        if (exp < now) this.seen.delete(k);
      }
      if (this.seen.size > 4000) {
        // drop oldest ~20%
        let i = 0;
        const n = Math.ceil(this.seen.size * 0.2);
        for (const k of this.seen.keys()) {
          this.seen.delete(k);
          if (++i >= n) break;
        }
      }
    }
    if (this.seen.has(id)) return true;
    this.seen.set(id, now + this.seenTtlMs);
    return false;
  }

  private pushRing(ev: StreamEvent): void {
    this.ring.unshift(ev);
    if (this.ring.length > this.ringSize) {
      this.ring.length = this.ringSize;
    }
  }

  private async fanOut(
    ev: StreamEvent,
    opts: { fleet: boolean; persist: boolean },
  ): Promise<void> {
    // Never persist/fleet full message bodies — local ring + SSE keep fullText
    const fleetEv = stripSensitiveStreamData(ev);
    const raw = JSON.stringify(fleetEv);
    try {
      if (opts.persist) {
        const pipe = this.db.redis.pipeline();
        pipe.lpush(K.streamRecent, raw);
        pipe.ltrim(K.streamRecent, 0, this.backlogSize - 1);
        if (opts.fleet) pipe.publish(K.streamChannel, raw);
        await pipe.exec();
      } else if (opts.fleet) {
        await this.db.redis.publish(K.streamChannel, raw);
      }
    } catch {
      /* non-fatal */
    }
  }
}

/** Drop fullText/text before Redis pub/backlog (privacy + size). */
function stripSensitiveStreamData(ev: StreamEvent): StreamEvent {
  if (!ev.data) return ev;
  if (!("fullText" in ev.data) && !("text" in ev.data)) return ev;
  const data = { ...ev.data };
  delete data.fullText;
  delete data.text;
  return { ...ev, data };
}

// ── Singleton ──────────────────────────────────────────

let bus: ActivityBus | null = null;

export function initActivityBus(opts: ActivityBusOptions): ActivityBus {
  if (bus) {
    void bus.stop();
  }
  bus = new ActivityBus(opts);
  return bus;
}

export function getActivityBus(): ActivityBus | null {
  return bus;
}

export function emitActivity(
  input: EmitInput,
  opts?: EmitOpts,
): StreamEvent | null {
  return bus?.emit(input, opts) ?? null;
}
