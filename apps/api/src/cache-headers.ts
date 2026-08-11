/**
 * Shared Cache-Control helpers for Cloudflare-friendly origin responses.
 *
 * Prefer Cloudflare-CDN-Cache-Control for longer edge TTL than browsers.
 * Authenticated JSON stays private, no-store.
 */

import type { FastifyReply } from "fastify";

/** Landing / docs HTML (browser short, edge longer). */
export const CC_HTML_MARKETING =
  "public, max-age=300" as const;
export const CDN_HTML_MARKETING =
  "public, max-age=3600, stale-while-revalidate=86400" as const;

/** App / admin SPA shells. */
export const CC_HTML_APP = "public, max-age=60" as const;
export const CDN_HTML_APP =
  "public, max-age=3600, stale-while-revalidate=86400" as const;

/** OG share image. */
export const CC_OG = "public, max-age=86400, immutable" as const;
export const CDN_OG = "public, max-age=604800" as const;

/** Public approved sticker CDN. */
export const CC_CDN_STICKER =
  "public, max-age=31536000, immutable" as const;
export const CDN_CDN_STICKER = "public, max-age=31536000" as const;

/**
 * Private sticker bytes (own / pending / admin review). Content-addressed, so
 * revalidate cheaply with an ETag instead of re-sending the blob every time.
 */
export const CC_PRIVATE_STICKER =
  "private, max-age=300, must-revalidate" as const;

/**
 * Login QR image. Locally rendered from a link that embeds a login ticket, so
 * it must never be shared or stored by an intermediary.
 */
export const CC_PRIVATE_QR = "private, no-store" as const;

/** Default for authenticated / dynamic APIs. */
export const CC_PRIVATE_NO_STORE = "private, no-store" as const;

/** Health checks — never cache. */
export const CC_NO_STORE = "no-store" as const;

export function setPublicCache(
  reply: FastifyReply,
  browser: string,
  edge?: string,
  extra?: { etag?: string; cacheTag?: string },
): void {
  reply.header("Cache-Control", browser);
  if (edge) {
    reply.header("Cloudflare-CDN-Cache-Control", edge);
  }
  if (extra?.etag) {
    reply.header("ETag", extra.etag);
  }
  if (extra?.cacheTag) {
    reply.header("Cache-Tag", extra.cacheTag);
  }
}

export function setPrivateNoStore(reply: FastifyReply): void {
  reply.header("Cache-Control", CC_PRIVATE_NO_STORE);
}

/** Quoted weak or strong ETag from a hex hash. */
export function etagFromHash(hash: string, weak = false): string {
  const h = hash.replace(/"/g, "");
  return weak ? `W/"${h}"` : `"${h}"`;
}

export function ifNoneMatchHits(
  ifNoneMatch: string | string[] | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  const want = etag.replace(/^W\//, "").replace(/"/g, "");
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t === "*") return true;
    const got = t.replace(/^W\//, "").replace(/"/g, "");
    if (got === want) return true;
  }
  return false;
}
