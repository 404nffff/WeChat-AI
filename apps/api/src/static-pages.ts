/**
 * In-memory static HTML / OG buffers with content ETags.
 * Loaded once at boot (after SEO absolute-URL rewrite).
 *
 * The shells are large (admin.html ~486 KB). Letting @fastify/compress brotli
 * them per request burns double-digit milliseconds of event-loop time on every
 * page load and stalls concurrent API calls, so compress once here at boot and
 * hand out the finished buffer.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { etagFromHash } from "./cache-headers.js";

export type ContentEncoding = "br" | "gzip";

export interface EncodedBody {
  encoding: ContentEncoding;
  body: Buffer;
  etag: string;
}

export interface StaticPage {
  body: string | Buffer;
  etag: string;
  contentType: string;
  /** Pre-compressed variants, best-first. Empty when compression is disabled. */
  encoded: EncodedBody[];
}

/**
 * Best pre-compressed variant the client accepts, or null for the raw body.
 * Deliberately simple: no q-value ranking, br preferred over gzip.
 */
export function pickEncoded(
  page: StaticPage,
  acceptEncoding: string | string[] | undefined,
): EncodedBody | null {
  if (!page.encoded.length) return null;
  const raw = Array.isArray(acceptEncoding)
    ? acceptEncoding.join(",")
    : acceptEncoding;
  if (!raw) return null;
  const accepted = raw.toLowerCase();
  for (const v of page.encoded) {
    if (accepted.includes(v.encoding)) return v;
  }
  return null;
}

const PRECOMPRESS_ENABLED = process.env.STATIC_PRECOMPRESS !== "false";

function brotliOpts(size: number, quality: number): zlib.BrotliOptions {
  return {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  };
}

/**
 * Fast pass so boot stays snappy (~20ms for all shells). `upgradeStaticCompression`
 * re-does it at max quality once the server is listening.
 */
function precompress(html: string, baseEtag: string): EncodedBody[] {
  if (!PRECOMPRESS_ENABLED) return [];
  const buf = Buffer.from(html, "utf8");
  const tag = (suffix: string) => `${baseEtag.slice(0, -1)}-${suffix}"`;
  return [
    {
      encoding: "br",
      body: zlib.brotliCompressSync(buf, brotliOpts(buf.length, 5)),
      etag: tag("br"),
    },
    {
      encoding: "gzip",
      body: zlib.gzipSync(buf, { level: 6 }),
      etag: tag("gz"),
    },
  ];
}

/**
 * Recompress the shells at max quality off the hot path (~30% smaller than the
 * boot pass; admin.html 486 KB → ~77 KB). Async zlib, so the event loop keeps
 * serving. Safe to run late: variants are swapped in atomically per page and
 * ETags describe the entity, not the encoding, so cached clients still 304.
 */
export async function upgradeStaticCompression(
  assets: LoadedStaticAssets,
): Promise<void> {
  if (!PRECOMPRESS_ENABLED) return;
  const br = (b: Buffer) =>
    new Promise<Buffer>((res, rej) =>
      zlib.brotliCompress(b, brotliOpts(b.length, 11), (e, out) =>
        e ? rej(e) : res(out),
      ),
    );
  const gz = (b: Buffer) =>
    new Promise<Buffer>((res, rej) =>
      zlib.gzip(b, { level: 9 }, (e, out) => (e ? rej(e) : res(out))),
    );

  for (const page of assets.pages.values()) {
    if (!page.encoded.length) continue;
    const buf = Buffer.from(page.body as string, "utf8");
    const [brBody, gzBody] = await Promise.all([br(buf), gz(buf)]);
    page.encoded = page.encoded.map((v) => ({
      ...v,
      body: v.encoding === "br" ? brBody : gzBody,
    }));
  }
}

function sha16(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/** Rewrite relative SEO URLs to absolute (crawlers require full og:url / og:image). */
export function withAbsoluteSeo(
  html: string,
  publicBase: string,
  pagePath: string,
): string {
  const base = publicBase.replace(/\/$/, "");
  const pageUrl = `${base}${pagePath.startsWith("/") ? pagePath : `/${pagePath}`}`;
  const imageUrl = `${base}/og.jpg`;
  return html
    .replace(
      /(<meta\s+property="og:image"\s+content=")[^"]*(")/i,
      `$1${imageUrl}$2`,
    )
    .replace(
      /(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i,
      `$1${imageUrl}$2`,
    )
    .replace(
      /(<meta\s+property="og:url"\s+content=")[^"]*(")/i,
      `$1${pageUrl}$2`,
    )
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${pageUrl}$2`);
}

export interface LoadedStaticAssets {
  pages: Map<string, StaticPage>;
  og: StaticPage | null;
}

export function loadStaticAssets(
  publicDir: string,
  publicBase: string,
): LoadedStaticAssets {
  const pages = new Map<string, StaticPage>();
  const entries: Array<{ file: string; route: string }> = [
    { file: "index.html", route: "/" },
    { file: "app.html", route: "/app" },
    { file: "docs.html", route: "/docs" },
    { file: "admin.html", route: "/admin" },
    { file: "chatflow.html", route: "/chatflow" },
  ];

  for (const { file, route } of entries) {
    const p = path.join(publicDir, file);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    const html = withAbsoluteSeo(raw, publicBase, route);
    const hash = sha16(html);
    const etag = etagFromHash(hash);
    pages.set(route, {
      body: html,
      etag,
      contentType: "text/html; charset=utf-8",
      encoded: precompress(html, etag),
    });
  }

  let og: StaticPage | null = null;
  const ogPath = path.join(publicDir, "og.jpg");
  if (fs.existsSync(ogPath)) {
    const buf = fs.readFileSync(ogPath);
    og = {
      body: buf,
      etag: etagFromHash(sha16(buf)),
      contentType: "image/jpeg",
      // JPEG is already compressed — never re-encode it
      encoded: [],
    };
  }

  return { pages, og };
}
