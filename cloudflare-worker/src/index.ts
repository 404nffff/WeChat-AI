import {
  getOrCreateStates,
  parseOrigins,
  pickCandidates,
  nextRoundRobinIndex,
  runBackgroundProbes,
  probeOrigin,
  type LbEnv,
} from "./origins";
import { proxyRequest } from "./proxy";
import {
  adsenseEnabled,
  maybeInjectAdsense,
  normalizeAdsenseClient,
  tryServeAdsTxt,
} from "./adsense";

export default {
  async fetch(
    request: Request,
    env: LbEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__lb/health") {
      const origins = parseOrigins(env.ORIGINS);
      const states = getOrCreateStates(origins);
      const client = normalizeAdsenseClient(env.ADSENSE_CLIENT);
      return Response.json({
        ok: true,
        service: "wechat-ai-lb",
        mode: "non_blocking_probe",
        adsense: {
          enabled: adsenseEnabled(env),
          client: client || null,
        },
        origins: states.map((s) => ({
          url: s.url,
          healthy: s.healthy,
          lastCheck: s.lastCheck,
          failCount: s.failCount,
        })),
      });
    }

    // Edge-served ads.txt (AdSense site verification / authorization)
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
          hint: "Set wrangler vars ORIGINS to comma-separated node base URLs",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const states = getOrCreateStates(origins);

    // Never block user requests on health probes (default).
    if (String(env.HEALTH_ON_REQUEST || "").toLowerCase() === "true") {
      const timeout = Math.max(
        300,
        Number(env.HEALTH_TIMEOUT_MS ?? "1500") || 1500,
      );
      const healthPath = (env.HEALTH_PATH || "/health").trim() || "/health";
      await Promise.all(
        states.map((s) => probeOrigin(s, healthPath, timeout)),
      );
    } else {
      ctx.waitUntil(runBackgroundProbes(states, env));
    }

    const candidates = pickCandidates(states);
    const start = nextRoundRobinIndex(candidates.length);
    const order =
      candidates.length <= 1
        ? candidates
        : candidates.slice(start).concat(candidates.slice(0, start));

    let lastErr: unknown;
    for (const origin of order) {
      try {
        const res = await proxyRequest(request, origin.url, env);
        if (res.status >= 502 && res.status <= 504 && order.length > 1) {
          lastErr = new Error(`upstream ${res.status}`);
          origin.failCount += 1;
          if (origin.failCount >= 2) origin.healthy = false;
          continue;
        }
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
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
