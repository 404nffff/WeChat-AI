import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOG_LEVELS, resolveLogLevel } from "./config.js";
import {
  describeRequest,
  isQuietPath,
  isStreamingPath,
  logPath,
  requestLogLevel,
} from "./request-log.js";

const base = {
  method: "GET",
  url: "/api/v1/me/bots",
  status: 200,
  elapsedMs: 12,
  slowMs: 1000,
};

describe("resolveLogLevel", () => {
  it("accepts every pino level", () => {
    for (const level of LOG_LEVELS) {
      assert.equal(resolveLogLevel(level), level);
    }
  });

  it("normalises case and whitespace", () => {
    assert.equal(resolveLogLevel("  DEBUG "), "debug");
  });

  it("falls back to info rather than letting pino throw at boot", () => {
    for (const bad of ["verbose", "", "  ", undefined, "10", "critical"]) {
      assert.equal(resolveLogLevel(bad), "info", String(bad));
    }
  });
});

describe("logPath", () => {
  it("keeps a plain path", () => {
    assert.equal(logPath("/api/v1/auth/me"), "/api/v1/auth/me");
  });

  it("drops the query string so OAuth credentials never reach the log", () => {
    assert.equal(
      logPath("/api/v1/auth/callback?code=SECRET&state=ALSOSECRET"),
      "/api/v1/auth/callback",
    );
  });

  it("never returns empty", () => {
    assert.equal(logPath(""), "/");
    assert.equal(logPath("?a=1"), "/");
  });
});

describe("requestLogLevel", () => {
  it("escalates on server errors", () => {
    assert.equal(requestLogLevel(500, 5, 1000), "error");
    assert.equal(requestLogLevel(503, 5, 1000), "error");
  });

  it("warns on client errors", () => {
    assert.equal(requestLogLevel(400, 5, 1000), "warn");
    assert.equal(requestLogLevel(404, 5, 1000), "warn");
    assert.equal(requestLogLevel(429, 5, 1000), "warn");
  });

  it("warns on a slow success", () => {
    assert.equal(requestLogLevel(200, 1001, 1000), "warn");
    assert.equal(requestLogLevel(200, 1000, 1000), "info");
  });

  it("treats redirects and 304 as ordinary", () => {
    assert.equal(requestLogLevel(302, 5, 1000), "info");
    assert.equal(requestLogLevel(304, 5, 1000), "info");
  });
});

describe("streaming paths", () => {
  it("recognises the admin activity stream", () => {
    assert.equal(isStreamingPath("/api/v1/admin/stream"), true);
    assert.equal(isStreamingPath("/api/v1/admin/stream/recent"), false);
    assert.equal(isStreamingPath("/api/v1/me/bots"), false);
  });

  it("does not escalate a held-open stream to warn on duration", () => {
    // The SSE route hijacks the reply and stays open for as long as the
    // dashboard is on screen; elapsed time is the viewer's dwell time.
    assert.equal(requestLogLevel(200, 600_000, 1000, true), "info");
    // Real failures still escalate.
    assert.equal(requestLogLevel(500, 600_000, 1000, true), "error");
    assert.equal(requestLogLevel(403, 5, 1000, true), "warn");
  });

  it("logs a long SSE session at info end to end", () => {
    const line = describeRequest({
      method: "GET",
      url: "/api/v1/admin/stream?types=message",
      status: 200,
      elapsedMs: 8 * 60_000,
      slowMs: 1000,
    });
    assert.equal(line?.level, "info");
    assert.equal(line?.path, "/api/v1/admin/stream");
  });
});

describe("isQuietPath", () => {
  it("covers both health endpoints and nothing else", () => {
    assert.equal(isQuietPath("/health"), true);
    assert.equal(isQuietPath("/health/ready"), true);
    assert.equal(isQuietPath("/healthz"), false);
    assert.equal(isQuietPath("/"), false);
    assert.equal(isQuietPath("/api/v1/auth/me"), false);
  });
});

describe("describeRequest", () => {
  it("emits fields for a normal request", () => {
    assert.deepEqual(describeRequest({ ...base, socketIp: "10.0.0.5" }), {
      level: "info",
      method: "GET",
      path: "/api/v1/me/bots",
      status: 200,
      ms: 12,
      ip: "10.0.0.5",
    });
  });

  it("stays quiet for a healthy probe", () => {
    assert.equal(describeRequest({ ...base, url: "/health" }), null);
    assert.equal(describeRequest({ ...base, url: "/health/ready" }), null);
  });

  it("logs a failing probe — the only time anyone reads them", () => {
    const line = describeRequest({
      ...base,
      url: "/health/ready",
      status: 503,
    });
    assert.ok(line);
    assert.equal(line.level, "error");
    assert.equal(line.path, "/health/ready");
  });

  it("prefers the Cloudflare header over the socket address", () => {
    const line = describeRequest({
      ...base,
      cfConnectingIp: " 203.0.113.9 ",
      socketIp: "10.0.0.5",
    });
    assert.equal(line?.ip, "203.0.113.9");
  });

  it("falls back through socket IP to unknown", () => {
    assert.equal(describeRequest({ ...base, socketIp: "10.0.0.5" })?.ip, "10.0.0.5");
    assert.equal(describeRequest({ ...base })?.ip, "unknown");
    assert.equal(
      describeRequest({ ...base, cfConnectingIp: "   ", socketIp: undefined })?.ip,
      "unknown",
    );
  });

  it("rounds and floors latency", () => {
    assert.equal(describeRequest({ ...base, elapsedMs: 12.6 })?.ms, 13);
    assert.equal(describeRequest({ ...base, elapsedMs: -1 })?.ms, 0);
  });

  it("never carries a query string into the fields", () => {
    const line = describeRequest({
      ...base,
      url: "/api/v1/auth/callback?code=SECRET",
      status: 302,
    });
    assert.equal(line?.path, "/api/v1/auth/callback");
    assert.ok(!JSON.stringify(line).includes("SECRET"));
  });
});
