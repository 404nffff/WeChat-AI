/**
 * Decides what a completed request should log.
 *
 * Split out of the onResponse hook so the rules — which paths stay quiet, when
 * a 200 still deserves a warning, and above all that query strings never reach
 * the log — are unit-testable instead of buried in a closure.
 */

export type RequestLogLevel = "info" | "warn" | "error";

export interface RequestLogFields {
  level: RequestLogLevel;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string;
}

export interface RequestLogInput {
  method: string;
  /** Raw request URL, query string included */
  url: string;
  status: number;
  elapsedMs: number;
  cfConnectingIp?: string | undefined;
  socketIp?: string | undefined;
  /** Successful requests slower than this log at warn */
  slowMs: number;
}

/**
 * Probe endpoints. Docker's HEALTHCHECK and the Cloudflare LB hit these every
 * few seconds, so a successful probe logs nothing — a failing one still does,
 * which is the only time anyone wants to read them.
 */
const QUIET_PATHS = new Set(["/health", "/health/ready"]);

/**
 * Long-lived responses, where elapsed time measures how long a client stayed
 * connected rather than how slow we were.
 *
 * The admin activity stream calls `reply.hijack()` and holds the socket open for
 * as long as the dashboard is on screen. Fastify still fires onResponse when the
 * raw socket finishes, so without this every dashboard visit would close with a
 * "slow request" warning that means nothing.
 */
const STREAMING_PATHS = new Set(["/api/v1/admin/stream"]);

export function isStreamingPath(path: string): boolean {
  return STREAMING_PATHS.has(path);
}

/**
 * Strip the query string.
 *
 * `/api/v1/auth/callback?code=…&state=…` carries single-use OAuth credentials;
 * writing the full URL would persist them to whatever collects stdout.
 */
export function logPath(url: string): string {
  const path = url.split("?")[0] || "/";
  return path;
}

export function isQuietPath(path: string): boolean {
  return QUIET_PATHS.has(path);
}

export function requestLogLevel(
  status: number,
  ms: number,
  slowMs: number,
  streaming = false,
): RequestLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  // Duration is meaningless for a held-open stream — never escalate on it.
  if (streaming) return "info";
  return ms > slowMs ? "warn" : "info";
}

/** Fields to log, or null when this request should stay quiet. */
export function describeRequest(
  input: RequestLogInput,
): RequestLogFields | null {
  const path = logPath(input.url);
  const status = input.status;
  if (isQuietPath(path) && status < 400) return null;

  const ms = Math.max(0, Math.round(input.elapsedMs));
  return {
    level: requestLogLevel(status, ms, input.slowMs, isStreamingPath(path)),
    method: input.method,
    path,
    status,
    ms,
    // trustProxy is deliberately off, so only Cloudflare's header is trusted
    // here — a client-supplied X-Forwarded-For must not shape our logs either.
    ip: input.cfConnectingIp?.trim() || input.socketIp || "unknown",
  };
}
