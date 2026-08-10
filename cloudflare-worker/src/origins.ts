export interface OriginState {
  url: string;
  healthy: boolean;
  lastCheck: number;
  failCount: number;
}

export interface LbEnv {
  ORIGINS: string;
  HEALTH_PATH?: string;
  HEALTH_INTERVAL_MS?: string;
  HEALTH_TIMEOUT_MS?: string;
  /** If "true", await probes on every request (slow — debug only) */
  HEALTH_ON_REQUEST?: string;
  ORIGIN_HOST_MODE?: string;
  ORIGIN_PROXY_SECRET?: string;
  /**
   * Google AdSense client id, e.g. `ca-pub-…`.
   * When set, Worker injects adsbygoogle.js into public HTML and may serve /ads.txt.
   */
  ADSENSE_CLIENT?: string;
  /** Set to "false" to disable injection even if ADSENSE_CLIENT is set */
  ADSENSE_ENABLED?: string;
  /**
   * Comma-separated path prefixes that never get ads.
   * Default: /admin,/api/,/__lb/,/cdn/,/health
   */
  ADSENSE_SKIP_PATHS?: string;
  /** Optional full ads.txt body; if empty, generated from ADSENSE_CLIENT */
  ADSENSE_ADS_TXT?: string;
}

const states = new Map<string, OriginState>();
let rr = 0;
let bgProbeRunning = false;

export function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    let s = part.trim();
    if (!s) continue;
    s = s.replace(/\/$/, "");
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    try {
      out.push(new URL(s).origin);
    } catch {
      /* skip */
    }
  }
  return [...new Set(out)];
}

export function getOrCreateStates(origins: string[]): OriginState[] {
  for (const url of origins) {
    if (!states.has(url)) {
      states.set(url, {
        url,
        healthy: true,
        lastCheck: 0,
        failCount: 0,
      });
    }
  }
  for (const key of [...states.keys()]) {
    if (!origins.includes(key)) states.delete(key);
  }
  return origins.map((u) => states.get(u)!);
}

export async function probeOrigin(
  state: OriginState,
  healthPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${state.url}${path}`, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { Accept: "application/json, */*", "Cache-Control": "no-store" },
    });
    try {
      await res.arrayBuffer();
    } catch {
      /* */
    }
    const ok = res.status >= 200 && res.status < 400;
    state.healthy = ok;
    state.failCount = ok ? 0 : state.failCount + 1;
    state.lastCheck = Date.now();
    return ok;
  } catch {
    state.healthy = false;
    state.failCount += 1;
    state.lastCheck = Date.now();
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Background probes only — do not await on request path. */
export async function runBackgroundProbes(
  origins: OriginState[],
  env: LbEnv,
): Promise<void> {
  if (bgProbeRunning || !origins.length) return;
  bgProbeRunning = true;
  try {
    const interval = Math.max(
      3000,
      Number(env.HEALTH_INTERVAL_MS ?? "15000") || 15_000,
    );
    const timeout = Math.max(
      300,
      Number(env.HEALTH_TIMEOUT_MS ?? "1500") || 1500,
    );
    const healthPath = (env.HEALTH_PATH || "/health").trim() || "/health";
    const now = Date.now();
    const due = origins.filter((s) => now - s.lastCheck >= interval);
    for (let i = 0; i < due.length; i += 4) {
      const chunk = due.slice(i, i + 4);
      await Promise.all(chunk.map((s) => probeOrigin(s, healthPath, timeout)));
    }
  } finally {
    bgProbeRunning = false;
  }
}

export function pickCandidates(origins: OriginState[]): OriginState[] {
  const healthy = origins.filter((s) => s.healthy);
  return healthy.length ? healthy : origins;
}

export function nextRoundRobinIndex(len: number): number {
  if (len <= 1) return 0;
  const i = rr % len;
  rr = (rr + 1) % len;
  return i;
}

export function pickOrigin(candidates: OriginState[]): OriginState {
  if (candidates.length === 1) return candidates[0]!;
  return candidates[nextRoundRobinIndex(candidates.length)]!;
}
