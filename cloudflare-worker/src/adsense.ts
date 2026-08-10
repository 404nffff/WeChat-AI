import type { LbEnv } from "./origins";

/** Normalize to `ca-pub-…` or null if unset/invalid. */
export function normalizeAdsenseClient(
  raw: string | undefined | null,
): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  const ca = s.match(/^ca-pub-(\d+)$/i);
  if (ca) return `ca-pub-${ca[1]}`;
  const pub = s.match(/^pub-(\d+)$/i);
  if (pub) return `ca-pub-${pub[1]}`;
  if (/^\d+$/.test(s)) return `ca-pub-${s}`;
  // Strict: only accept known shapes (avoid injecting arbitrary URLs)
  return null;
}

/** Publisher id for ads.txt (`pub-…`). */
export function publisherIdFromClient(client: string): string {
  return client.replace(/^ca-/i, "");
}

export function adsTxtFromClient(client: string): string {
  const pub = publisherIdFromClient(client);
  // Standard AdSense authorization record (CERTIFICATION_AUTHORITY_ID is fixed for Google)
  return `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`;
}

/**
 * Paths that should never get ads (app consoles, API, LB internals, CDN, health).
 * Comma-separated env `ADSENSE_SKIP_PATHS` overrides the default list.
 *
 * /app and /chatflow are logged-in consoles with no ad slots — injecting the
 * loader there only cost a third-party DNS+TLS+~100KB (and a hanging socket
 * where googlesyndication is unreachable), and the HTMLRewriter pass strips
 * Content-Encoding, defeating the origin's pre-compressed shells.
 */
export function parseSkipPaths(env: LbEnv): string[] {
  const raw =
    env.ADSENSE_SKIP_PATHS?.trim() ||
    "/admin,/app,/chatflow,/api/,/__lb/,/cdn/,/health";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pathSkipped(pathname: string, skips: string[]): boolean {
  const path = pathname.toLowerCase() || "/";
  for (const skip of skips) {
    const sk = skip.toLowerCase();
    if (sk.endsWith("/")) {
      if (path === sk.slice(0, -1) || path.startsWith(sk)) return true;
    } else if (path === sk || path.startsWith(`${sk}/`)) {
      return true;
    }
  }
  return false;
}

export function adsenseEnabled(env: LbEnv): boolean {
  if (String(env.ADSENSE_ENABLED || "true").toLowerCase() === "false") {
    return false;
  }
  return Boolean(normalizeAdsenseClient(env.ADSENSE_CLIENT));
}

export function shouldInjectAdsense(
  pathname: string,
  env: LbEnv,
): boolean {
  if (!adsenseEnabled(env)) return false;
  return !pathSkipped(pathname, parseSkipPaths(env));
}

/**
 * Inject AdSense loader into `<head>` of successful HTML responses.
 * Strips Content-Length / Content-Encoding because the body changes.
 */
export function injectAdsenseScript(
  response: Response,
  client: string,
): Response {
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text/html")) return response;
  if (response.status < 200 || response.status >= 300) return response;

  const safe = client.replace(/[^a-zA-Z0-9-]/g, "");
  if (!/^ca-pub-\d+$/i.test(safe)) return response;

  const snippet =
    `\n<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${safe}" crossorigin="anonymous"></script>\n`;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("X-WeChat-AI-Adsense", "1");

  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(snippet, { html: true });
      },
    })
    .transform(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
}

/** Apply injection when request path + env allow it. */
export function maybeInjectAdsense(
  request: Request,
  response: Response,
  env: LbEnv,
): Response {
  if (request.method !== "GET") return response;
  const pathname = new URL(request.url).pathname;
  if (!shouldInjectAdsense(pathname, env)) return response;
  const client = normalizeAdsenseClient(env.ADSENSE_CLIENT);
  if (!client) return response;
  return injectAdsenseScript(response, client);
}

/** Serve `/ads.txt` from Worker when AdSense is configured (or custom body). */
export function tryServeAdsTxt(
  request: Request,
  env: LbEnv,
): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/ads.txt") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const custom = env.ADSENSE_ADS_TXT?.trim();
  let body: string | null = null;
  if (custom) {
    body = custom.endsWith("\n") ? custom : `${custom}\n`;
  } else {
    const client = normalizeAdsenseClient(env.ADSENSE_CLIENT);
    if (client) body = adsTxtFromClient(client);
  }
  if (!body) return null;

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
    "X-WeChat-AI-Adsense": "ads.txt",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}
