import type { LbEnv } from "./origins";

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

/** Response headers from origin that must not reach clients */
const STRIP_RESPONSE_HEADERS = [
  "x-wechat-ai-origin",
  "x-railway-edge",
  "x-railway-request-id",
  "x-railway-cdn-edge",
  "x-hikari-trace",
  "server-timing",
] as const;

export function buildUpstreamHeaders(
  req: Request,
  originUrl: string,
  env: LbEnv,
  clientHost: string,
): Headers {
  const out = new Headers();
  req.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) return;
    if (lk.startsWith("cf-")) return;
    out.set(key, value);
  });

  const mode = (env.ORIGIN_HOST_MODE || "preserve").toLowerCase();
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
    out.set(
      "X-Forwarded-For",
      prior ? `${clientIp}, ${prior}` : clientIp,
    );
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

export async function proxyRequest(
  req: Request,
  originBase: string,
  env: LbEnv,
): Promise<Response> {
  const incoming = new URL(req.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    originBase.endsWith("/") ? originBase : originBase + "/",
  );

  const clientHost = incoming.host;
  const headers = buildUpstreamHeaders(req, originBase, env, clientHost);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // @ts-expect-error duplex required for streaming body in Workers
    init.duplex = "half";
  }

  const upstream = await fetch(target.toString(), init);
  const resHeaders = new Headers(upstream.headers);
  resHeaders.set("X-WeChat-AI-LB", "1");
  // Strip origin infra / ops headers (do not leak Railway host, edge, etc.)
  for (const h of STRIP_RESPONSE_HEADERS) {
    resHeaders.delete(h);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
}
