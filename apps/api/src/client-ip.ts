import { timingSafeEqual } from "node:crypto";

/**
 * Whose IP is this, really?
 *
 * Rate limiting on login, registration and invite peeking is the only thing
 * standing between a password and a brute-force loop, and it buckets by IP. So
 * the IP has to be one the caller cannot choose.
 *
 * trustProxy stays off (see server-options.ts) because origins are reachable
 * directly by IP, which means `CF-Connecting-IP` and `X-Forwarded-For` are just
 * strings an attacker types. Reading them unconditionally — as this code used
 * to — hands every request a fresh bucket and switches the limiter off.
 *
 * The Cloudflare Worker in front already stamps `X-WeChat-AI-Proxy-Secret`
 * (cloudflare-worker/src/proxy.ts) with a value only it and the origin know, so
 * that header is the proof of provenance: with it, the forwarded IP is the
 * Worker's word and can be trusted; without it, only the socket can.
 */

/** Header the LB Worker stamps on every proxied request. */
export const PROXY_SECRET_HEADER = "x-wechat-ai-proxy-secret";

export type HeaderBag = Record<string, string | string[] | undefined>;

export interface ClientIpInput {
  headers: HeaderBag;
  /** Peer address of the TCP connection — unforgeable, but the LB's when proxied. */
  socketIp?: string;
  /** `ORIGIN_PROXY_SECRET`; empty when the operator has not configured one. */
  proxySecret: string;
}

function first(v: string | string[] | undefined): string | undefined {
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
}

/** Constant-time compare that does not leak the secret's length. */
function secretMatches(expected: string, got: string | undefined): boolean {
  if (!expected || !got) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) {
    // Still burn a comparison so a wrong length is not the fast path.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * True when this request demonstrably came through our own load balancer.
 *
 * Only ever true if the operator configured a secret — an unset
 * `ORIGIN_PROXY_SECRET` must never make an absent header look like a match.
 */
export function isTrustedProxy(input: ClientIpInput): boolean {
  return secretMatches(input.proxySecret, first(input.headers[PROXY_SECRET_HEADER]));
}

/**
 * The address to rate-limit against.
 *
 * Behind a verified proxy: the client IP the Worker forwarded. Otherwise: the
 * socket, whatever headers claim.
 *
 * When no secret is configured the forwarded headers are still honoured, purely
 * so upgrading does not silently collapse an existing Cloudflare deployment
 * into one shared bucket (every user throttling every other user). That path is
 * the insecure one and `warnIfProxySecretMissing` says so at boot — configure
 * the secret on both ends to close it.
 */
export function resolveClientIp(input: ClientIpInput): string {
  const forwarded =
    first(input.headers["cf-connecting-ip"]) ||
    first(input.headers["x-forwarded-for"])?.split(",")[0]?.trim();

  if (input.proxySecret) {
    if (isTrustedProxy(input) && forwarded) return forwarded;
    return input.socketIp || "unknown";
  }

  return forwarded || input.socketIp || "unknown";
}

/**
 * One line at boot when the origin is accepting forwarded IPs on trust.
 * Silent once a secret is set, and silent for single-node deployments that
 * never see a proxy header at all — nothing to warn about there.
 */
export function proxySecretWarning(proxySecret: string): string | null {
  if (proxySecret) return null;
  return (
    "[security] ORIGIN_PROXY_SECRET is unset — CF-Connecting-IP / X-Forwarded-For " +
    "are trusted without proof, so a forged header bypasses the auth rate limits. " +
    "Set it here and in the Worker (wrangler secret put ORIGIN_PROXY_SECRET)."
  );
}
