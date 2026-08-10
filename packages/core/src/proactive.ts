/**
 * Idle-based proactive outreach eligibility (pure helpers + types).
 * Scheduling / I/O lives in the worker; this package only decides "should we?".
 */

export interface ProactivePolicy {
  /** Global hard off (env PROACTIVE_ENABLED) */
  globalEnabled: boolean;
  /** Default idle hours when bot does not override */
  defaultIdleHours: number;
  defaultMinIntervalHours: number;
  defaultMaxPerDay: number;
  /** Default quiet hours "H-H" or empty to disable */
  defaultQuietHours: string;
  /** Cooldown after a skip/attempt without a full min-interval write (hours) */
  attemptCooldownHours: number;
}

export interface ProactiveEligibilityInput {
  botStatus: string;
  botProactiveEnabled: boolean | number | undefined;
  peerApproved: boolean | number | undefined;
  peerProactiveEnabled: boolean | number | undefined;
  hasContextToken: boolean;
  /** ISO last activity; falls back to createdAt if missing */
  lastActivityAt?: string | null;
  peerCreatedAt?: string | null;
  lastProactiveAt?: string | null;
  lastProactiveAttemptAt?: string | null;
  dayCount: number;
  idleHours: number;
  minIntervalHours: number;
  maxPerDay: number;
  quietHours?: string | null;
  /** Override "now" for tests */
  now?: Date;
  /** Timezone for quiet hours (default Asia/Shanghai) */
  quietTimeZone?: string;
  attemptCooldownHours?: number;
}

export type ProactiveSkipReason =
  | "global_off"
  | "bot_inactive"
  | "bot_off"
  | "peer_unapproved"
  | "peer_off"
  | "no_context_token"
  | "not_idle"
  | "min_interval"
  | "day_cap"
  | "quiet_hours"
  | "attempt_cooldown";

export interface ProactiveEligibilityResult {
  ok: boolean;
  reason?: ProactiveSkipReason;
  /** Hours since last activity (for prompts/logs) */
  idleHoursActual?: number;
}

function isTruthyFlag(v: boolean | number | undefined | null): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string" && (v === "1" || v === "true")) return true;
  return false;
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse "0-8" or "22-6" (overnight wrap) quiet window.
 * Returns null if disabled / invalid.
 */
export function parseQuietHours(
  raw: string | null | undefined,
): { start: number; end: number } | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > 23 ||
    end < 0 ||
    end > 23
  ) {
    return null;
  }
  if (start === end) return null; // empty window
  return { start, end };
}

/** Hour-of-day 0–23 in the given IANA timezone. */
export function hourInTimeZone(
  date: Date,
  timeZone = "Asia/Shanghai",
): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(date);
    const h = parts.find((p) => p.type === "hour")?.value;
    const n = h != null ? Number(h) : date.getHours();
    // Some engines emit "24" for midnight
    if (n === 24) return 0;
    return Number.isFinite(n) ? n : date.getHours();
  } catch {
    return date.getHours();
  }
}

/** True if `hour` is inside [start, end) with overnight wrap. */
export function isInQuietHours(
  hour: number,
  window: { start: number; end: number },
): boolean {
  const { start, end } = window;
  if (start < end) {
    return hour >= start && hour < end;
  }
  // overnight e.g. 22-6 → 22,23,0,1,2,3,4,5
  return hour >= start || hour < end;
}

export function resolveActivityMs(input: {
  lastActivityAt?: string | null;
  peerCreatedAt?: string | null;
}): number | null {
  return (
    parseIsoMs(input.lastActivityAt) ?? parseIsoMs(input.peerCreatedAt) ?? null
  );
}

/**
 * Pure eligibility check for one bot+peer pair.
 * Does not acquire locks or touch Redis.
 */
export function isProactiveEligible(
  input: ProactiveEligibilityInput,
): ProactiveEligibilityResult {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();

  if (input.botStatus && input.botStatus !== "active") {
    return { ok: false, reason: "bot_inactive" };
  }
  if (!isTruthyFlag(input.botProactiveEnabled)) {
    return { ok: false, reason: "bot_off" };
  }
  if (!isTruthyFlag(input.peerApproved)) {
    return { ok: false, reason: "peer_unapproved" };
  }
  if (!isTruthyFlag(input.peerProactiveEnabled)) {
    return { ok: false, reason: "peer_off" };
  }
  if (!input.hasContextToken) {
    return { ok: false, reason: "no_context_token" };
  }

  const quiet = parseQuietHours(input.quietHours);
  if (quiet) {
    const hour = hourInTimeZone(now, input.quietTimeZone ?? "Asia/Shanghai");
    if (isInQuietHours(hour, quiet)) {
      return { ok: false, reason: "quiet_hours" };
    }
  }

  // maxPerDay <= 0 means unlimited
  const maxPerDay = Number(input.maxPerDay);
  if (Number.isFinite(maxPerDay) && maxPerDay > 0 && input.dayCount >= maxPerDay) {
    return { ok: false, reason: "day_cap" };
  }

  const activityMs = resolveActivityMs({
    lastActivityAt: input.lastActivityAt,
    peerCreatedAt: input.peerCreatedAt,
  });
  if (activityMs == null) {
    return { ok: false, reason: "not_idle" };
  }

  const idleMs = nowMs - activityMs;
  const idleHoursActual = idleMs / (3600 * 1000);
  if (idleHoursActual < input.idleHours) {
    return { ok: false, reason: "not_idle", idleHoursActual };
  }

  const lastProactiveMs = parseIsoMs(input.lastProactiveAt);
  const minInterval = Math.max(0, Number(input.minIntervalHours) || 0);
  if (lastProactiveMs != null && minInterval > 0) {
    const sinceProactiveH = (nowMs - lastProactiveMs) / (3600 * 1000);
    if (sinceProactiveH < minInterval) {
      return { ok: false, reason: "min_interval", idleHoursActual };
    }
  }

  const attemptCooldown =
    input.attemptCooldownHours != null && input.attemptCooldownHours > 0
      ? input.attemptCooldownHours
      : Math.min(1, input.minIntervalHours);
  const lastAttemptMs = parseIsoMs(input.lastProactiveAttemptAt);
  // Only apply attempt cooldown when last attempt was not a successful send
  // (if last_proactive_at equals last_proactive_attempt_at, min_interval already covers it)
  if (
    lastAttemptMs != null &&
    (lastProactiveMs == null || lastAttemptMs > lastProactiveMs)
  ) {
    const sinceAttemptH = (nowMs - lastAttemptMs) / (3600 * 1000);
    if (sinceAttemptH < attemptCooldown) {
      return { ok: false, reason: "attempt_cooldown", idleHoursActual };
    }
  }

  return { ok: true, idleHoursActual };
}

export function mergeBotProactiveConfig(
  bot: {
    proactive_enabled?: number;
    proactive_idle_hours?: number;
    proactive_min_interval_hours?: number;
    proactive_max_per_day?: number;
    /** undefined = use default; null or "" = explicitly disabled */
    proactive_quiet_hours?: string | null;
  },
  defaults: {
    idleHours: number;
    minIntervalHours: number;
    maxPerDay: number;
    quietHours: string;
  },
): {
  enabled: boolean;
  idleHours: number;
  minIntervalHours: number;
  maxPerDay: number;
  quietHours: string;
} {
  let quietHours = defaults.quietHours;
  if (bot.proactive_quiet_hours === null) {
    quietHours = "";
  } else if (bot.proactive_quiet_hours !== undefined) {
    quietHours = String(bot.proactive_quiet_hours);
  }

  return {
    enabled: isTruthyFlag(bot.proactive_enabled),
    idleHours:
      bot.proactive_idle_hours != null && bot.proactive_idle_hours > 0
        ? bot.proactive_idle_hours
        : defaults.idleHours,
    // Allow explicit 0 (= no min interval)
    minIntervalHours:
      bot.proactive_min_interval_hours != null &&
      Number.isFinite(bot.proactive_min_interval_hours)
        ? Math.max(0, bot.proactive_min_interval_hours)
        : defaults.minIntervalHours,
    // Allow explicit 0 (= unlimited daily)
    maxPerDay:
      bot.proactive_max_per_day != null &&
      Number.isFinite(bot.proactive_max_per_day)
        ? Math.max(0, bot.proactive_max_per_day)
        : defaults.maxPerDay,
    quietHours,
  };
}
