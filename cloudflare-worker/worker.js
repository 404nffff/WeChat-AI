const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

/** @type {Map<string, { url: string, healthy: boolean, lastCheck: number, failCount: number }>} */
const states = new Map();
let rr = 0;
let bgProbeRunning = false;

function parseOrigins(raw) {
  if (!raw || !String(raw).trim()) return [];
  const out = [];
  for (const part of String(raw).split(/[,\n]/)) {
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

function getOrCreateStates(origins) {
  for (const url of origins) {
    if (!states.has(url)) {
      // Start optimistic healthy — never block first request on probe
      states.set(url, { url, healthy: true, lastCheck: 0, failCount: 0 });
    }
  }
  for (const key of [...states.keys()]) {
    if (!origins.includes(key)) states.delete(key);
  }
  return origins.map((u) => states.get(u));
}

async function probeOrigin(state, healthPath, timeoutMs) {
  const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${state.url}${path}`, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { Accept: "application/json, */*", "Cache-Control": "no-store" },
      // Avoid CF caching the health fetch oddly
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ok = res.status >= 200 && res.status < 400;
    // drain body so connection can reuse
    try {
      await res.arrayBuffer();
    } catch {
      /* */
    }
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

/**
 * Background-only probes. Never call this with await on the request path
 * unless HEALTH_ON_REQUEST=true (debug).
 */
async function runBackgroundProbes(origins, env) {
  if (bgProbeRunning || !origins.length) return;
  bgProbeRunning = true;
  try {
    const interval = Math.max(
      3000,
      Number(env.HEALTH_INTERVAL_MS || "15000") || 15000,
    );
    const timeout = Math.max(
      300,
      Number(env.HEALTH_TIMEOUT_MS || "1500") || 1500,
    );
    // Lightweight process check by default (NOT /health/ready + Redis)
    const healthPath = (env.HEALTH_PATH || "/health").trim() || "/health";
    const now = Date.now();
    const due = origins.filter((s) => now - s.lastCheck >= interval);
    if (!due.length) return;
    // Cap concurrency: probe at most 4 at a time to avoid stampede
    for (let i = 0; i < due.length; i += 4) {
      const chunk = due.slice(i, i + 4);
      await Promise.all(chunk.map((s) => probeOrigin(s, healthPath, timeout)));
    }
  } finally {
    bgProbeRunning = false;
  }
}

/** Prefer known-healthy; if none known yet, use all (optimistic). */
function pickCandidates(origins) {
  const healthy = origins.filter((s) => s.healthy);
  if (healthy.length) return healthy;
  // All marked bad — still try them (avoid total outage from stale probes)
  return origins;
}

function buildUpstreamHeaders(req, originUrl, env, clientHost) {
  const out = new Headers();
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk.startsWith("cf-")) return;
    out.set(key, value);
  });

  const mode = String(env.ORIGIN_HOST_MODE || "preserve").toLowerCase();
  if (mode === "origin") {
    try {
      out.set("Host", new URL(originUrl).host);
    } catch {
      /* */
    }
  } else if (clientHost) {
    out.set("Host", clientHost);
  }

  const clientIp =
    req.headers.get("CF-Connecting-IP") ||
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "";
  if (clientIp) {
    out.set("CF-Connecting-IP", clientIp);
    out.set("X-Real-IP", clientIp);
    const prior = req.headers.get("X-Forwarded-For");
    out.set("X-Forwarded-For", prior ? `${clientIp}, ${prior}` : clientIp);
  }

  const proto =
    req.headers.get("X-Forwarded-Proto") ||
    (new URL(req.url).protocol === "https:" ? "https" : "http");
  out.set("X-Forwarded-Proto", proto);
  if (clientHost) out.set("X-Forwarded-Host", clientHost);

  if (env.ORIGIN_PROXY_SECRET) {
    out.set("X-WeChat-AI-Proxy-Secret", env.ORIGIN_PROXY_SECRET);
  }

  return out;
}

async function proxyRequest(req, originBase, env) {
  const incoming = new URL(req.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    originBase.endsWith("/") ? originBase : originBase + "/",
  );

  const headers = buildUpstreamHeaders(req, originBase, env, incoming.host);
  /** @type {RequestInit} */
  const init = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // @ts-ignore
    init.duplex = "half";
  }

  const upstream = await fetch(target.toString(), init);
  const resHeaders = new Headers(upstream.headers);
  resHeaders.set("X-WeChat-AI-LB", "1");
  // Strip origin infra / ops headers (do not leak Railway host, edge, etc.)
  for (const h of [
    "x-wechat-ai-origin",
    "x-railway-edge",
    "x-railway-request-id",
    "x-railway-cdn-edge",
    "x-hikari-trace",
    "server-timing",
  ]) {
    resHeaders.delete(h);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}

// ── Google AdSense (edge inject + ads.txt) ──────────────────────────

function normalizeAdsenseClient(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  const ca = s.match(/^ca-pub-(\d+)$/i);
  if (ca) return `ca-pub-${ca[1]}`;
  const pub = s.match(/^pub-(\d+)$/i);
  if (pub) return `ca-pub-${pub[1]}`;
  if (/^\d+$/.test(s)) return `ca-pub-${s}`;
  return null;
}

function adsTxtFromClient(client) {
  const pub = client.replace(/^ca-/i, "");
  return `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`;
}

function parseSkipPaths(env) {
  const raw =
    (env.ADSENSE_SKIP_PATHS && String(env.ADSENSE_SKIP_PATHS).trim()) ||
    "/admin,/api/,/__lb/,/cdn/,/health";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathSkipped(pathname, skips) {
  const path = (pathname || "/").toLowerCase();
  for (const skip of skips) {
    const sk = skip.toLowerCase();
    if (sk.endsWith("/")) {
      if (path === sk.slice(0, -1) || path.startsWith(sk)) return true;
    } else if (path === sk || path.startsWith(sk + "/")) {
      return true;
    }
  }
  return false;
}

function adsenseEnabled(env) {
  if (String(env.ADSENSE_ENABLED || "true").toLowerCase() === "false") {
    return false;
  }
  return Boolean(normalizeAdsenseClient(env.ADSENSE_CLIENT));
}

function shouldInjectAdsense(pathname, env) {
  if (!adsenseEnabled(env)) return false;
  return !pathSkipped(pathname, parseSkipPaths(env));
}

function injectAdsenseScript(response, client) {
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

function maybeInjectAdsense(request, response, env) {
  if (request.method !== "GET") return response;
  const pathname = new URL(request.url).pathname;
  if (!shouldInjectAdsense(pathname, env)) return response;
  const client = normalizeAdsenseClient(env.ADSENSE_CLIENT);
  if (!client) return response;
  return injectAdsenseScript(response, client);
}

function tryServeAdsTxt(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/ads.txt") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const custom = env.ADSENSE_ADS_TXT && String(env.ADSENSE_ADS_TXT).trim();
  let body = null;
  if (custom) {
    body = custom.endsWith("\n") ? custom : custom + "\n";
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/__lb/health") {
      const origins = parseOrigins(env.ORIGINS);
      const list = getOrCreateStates(origins);
      const client = normalizeAdsenseClient(env.ADSENSE_CLIENT);
      return Response.json({
        ok: true,
        service: "wechat-ai-lb",
        mode: "non_blocking_probe",
        adsense: {
          enabled: adsenseEnabled(env),
          client: client || null,
        },
        origins: list.map((s) => ({
          url: s.url,
          healthy: s.healthy,
          lastCheck: s.lastCheck,
          failCount: s.failCount,
        })),
      });
    }

    const adsTxt = tryServeAdsTxt(request, env);
    if (adsTxt) return adsTxt;

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return new Response("WebSocket not supported", { status: 426 });
    }

    const origins = parseOrigins(env.ORIGINS);
    if (!origins.length) {
      return new Response(
        JSON.stringify({
          error: "ORIGINS not configured",
          hint: "Settings → Variables → ORIGINS = http://ip1:8787,http://ip2:8787",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const list = getOrCreateStates(origins);

    // Optional debug: old blocking path (DO NOT use in production)
    if (String(env.HEALTH_ON_REQUEST || "").toLowerCase() === "true") {
      const timeout = Math.max(
        300,
        Number(env.HEALTH_TIMEOUT_MS || "1500") || 1500,
      );
      const healthPath = (env.HEALTH_PATH || "/health").trim() || "/health";
      await Promise.all(
        list.map((s) => probeOrigin(s, healthPath, timeout)),
      );
    } else if (ctx && typeof ctx.waitUntil === "function") {
      // Fire-and-forget: never await on request path
      ctx.waitUntil(runBackgroundProbes(list, env));
    }

    const candidates = pickCandidates(list);
    // Try primary + failover without long waits (only real proxy errors)
    const order = [...candidates];
    // rotate start
    if (order.length > 1) {
      const start = rr % order.length;
      rr = (rr + 1) % order.length;
      const rotated = order.slice(start).concat(order.slice(0, start));
      let lastErr;
      for (const origin of rotated) {
        try {
          const res = await proxyRequest(request, origin.url, env);
          // Soft signal: 5xx from origin → try next if multi
          if (res.status >= 502 && res.status <= 504 && rotated.length > 1) {
            lastErr = new Error(`upstream ${res.status}`);
            continue;
          }
          // mark success
          origin.healthy = true;
          origin.failCount = 0;
          return maybeInjectAdsense(request, res, env);
        } catch (err) {
          origin.failCount += 1;
          if (origin.failCount >= 2) origin.healthy = false;
          lastErr = err;
        }
      }
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      return new Response(
        JSON.stringify({ error: "all origins failed", detail: msg }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      const res = await proxyRequest(request, order[0].url, env);
      return maybeInjectAdsense(request, res, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: "origin failed", detail: msg }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
