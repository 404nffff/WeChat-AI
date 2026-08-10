import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { loadConfig, type AppConfig, type LogLevel } from "./config.js";
import {
  buildFastifyOptions,
  registerRequestLogging,
} from "./server-options.js";

/** Collects the JSON lines pino writes, so we can assert on real output. */
class LineSink extends Writable {
  readonly lines: Record<string, unknown>[] = [];
  private buf = "";

  override _write(
    chunk: Buffer | string,
    _enc: unknown,
    cb: (err?: Error | null) => void,
  ): void {
    this.buf += chunk.toString();
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const raw = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (raw) {
        try {
          this.lines.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          this.lines.push({ unparsed: raw });
        }
      }
      nl = this.buf.indexOf("\n");
    }
    cb();
  }

  requestLines(): Record<string, unknown>[] {
    return this.lines.filter((l) => l.msg === "request");
  }
}

function cfgWith(patch: Partial<AppConfig> = {}): AppConfig {
  // Real loadConfig so the options are built from the shape production uses.
  const base = loadConfig({
    LLM_API_KEY: "test",
    REDIS_URL: "redis://127.0.0.1:6379",
  } as NodeJS.ProcessEnv);
  return { ...base, ...patch };
}

/** Boots a throwaway server with the production options and a captured log. */
async function withServer(
  cfg: AppConfig,
  run: (
    app: Awaited<ReturnType<typeof buildApp>>["app"],
    sink: LineSink,
  ) => Promise<void>,
): Promise<void> {
  const { app, sink } = await buildApp(cfg);
  try {
    await run(app, sink);
  } finally {
    await app.close();
  }
}

async function buildApp(cfg: AppConfig) {
  const sink = new LineSink();
  const app = Fastify(buildFastifyOptions(cfg, { logStream: sink }));
  registerRequestLogging(app, cfg);
  app.get("/ok", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  app.get("/health/ready", async (_req, reply) =>
    reply.code(503).send({ ok: false }),
  );
  app.get("/boom", async () => {
    throw new Error("kaboom");
  });
  app.get("/api/v1/auth/callback", async (_req, reply) =>
    reply.code(302).header("location", "/app").send(),
  );
  // Same path, but it throws — this is the shape that reaches Fastify's
  // defaultErrorLog, which logs the serialized request.
  app.get("/api/v1/auth/callback-boom", async () => {
    throw new Error("Reached the max retries per request limit");
  });
  await app.ready();
  return { app, sink };
}

describe("buildFastifyOptions", () => {
  it("produces a logger config pino actually accepts", () => {
    // The whole point of the extraction: a bad level or redact path throws at
    // construction, so this is the boot smoke test.
    for (const level of ["silent", "error", "info", "debug", "trace"] as LogLevel[]) {
      const sink = new LineSink();
      const app = Fastify(
        buildFastifyOptions(cfgWith({ logLevel: level }), { logStream: sink }),
      );
      assert.equal(app.log.level, level);
      void app.close();
    }
  });

  it("silences Fastify's own request lines via logController, not the deprecated flag", () => {
    const opts = buildFastifyOptions(cfgWith());
    // disableRequestLogging would also gag defaultErrorLog (and is removed in
    // Fastify 6), so it must stay unset.
    assert.equal(opts.disableRequestLogging, undefined);
    assert.ok(opts.logController);
  });

  it("still refuses to trust proxy headers", () => {
    // Load-bearing security property: trustProxy would let a forged
    // X-Forwarded-For walk past the login and CDN rate limiters.
    assert.equal(buildFastifyOptions(cfgWith()).trustProxy, undefined);
  });

  it("assigns short request ids", () => {
    const genReqId = buildFastifyOptions(cfgWith()).genReqId;
    assert.ok(genReqId);
    const id = genReqId({} as never);
    assert.equal(typeof id, "string");
    assert.equal(String(id).length, 8);
    assert.notEqual(id, genReqId({} as never));
  });
});

describe("request logging", () => {
  it("logs one line per request at info", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      const res = await app.inject({ method: "GET", url: "/ok" });
      assert.equal(res.statusCode, 200);
      const lines = sink.requestLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.level, 30); // info
      assert.equal(lines[0]!.method, "GET");
      assert.equal(lines[0]!.path, "/ok");
      assert.equal(lines[0]!.status, 200);
      assert.equal(typeof lines[0]!.ms, "number");
      assert.equal(typeof lines[0]!.reqId, "string");
    });
  });

  it("stays silent for a healthy probe but logs a failing one", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({ method: "GET", url: "/health" });
      assert.equal(sink.requestLines().length, 0);

      await app.inject({ method: "GET", url: "/health/ready" });
      const lines = sink.requestLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.status, 503);
      assert.equal(lines[0]!.level, 50); // error
    });
  });

  it("logs a thrown route error — the regression that motivated this", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      const res = await app.inject({ method: "GET", url: "/boom" });
      assert.equal(res.statusCode, 500);
      // Fastify's own error log (only emitted because the logger is enabled)
      assert.ok(
        sink.lines.some((l) => String(l.msg ?? "").includes("kaboom")),
        "the framework error must be logged, not swallowed",
      );
      // Plus our own request line, escalated to error
      const lines = sink.requestLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.level, 50);
    });
  });

  it("never writes the OAuth code or state to the log", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({
        method: "GET",
        url: "/api/v1/auth/callback?code=SUPERSECRET&state=ALSOSECRET",
      });
      const dump = JSON.stringify(sink.lines);
      assert.ok(!dump.includes("SUPERSECRET"), dump);
      assert.ok(!dump.includes("ALSOSECRET"), dump);
      assert.equal(sink.requestLines()[0]!.path, "/api/v1/auth/callback");
    });
  });

  it("keeps the OAuth code out even when the callback 500s", async () => {
    // The dangerous path: Fastify's defaultErrorLog logs the serialized
    // request on a 5xx, and its built-in `req` serializer emits `url` with the
    // query string intact. Redacting headers does nothing about that — the
    // serializer never emits headers — so this needs a custom `req` serializer.
    // The OAuth code is still unredeemed at that point, i.e. a live credential.
    await withServer(cfgWith(), async (app, sink) => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/callback-boom?code=SUPERSECRET&state=ALSOSECRET",
      });
      assert.equal(res.statusCode, 500);
      const dump = JSON.stringify(sink.lines);
      assert.ok(
        sink.lines.some((l) => String(l.msg ?? "").includes("max retries")),
        "the 5xx must still be logged",
      );
      assert.ok(!dump.includes("SUPERSECRET"), dump);
      assert.ok(!dump.includes("ALSOSECRET"), dump);
      // The path is still there — we strip the query, not the whole URL.
      assert.ok(dump.includes("/api/v1/auth/callback-boom"));
    });
  });

  it("the framework request serializer emits no header bag at all", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({
        method: "GET",
        url: "/boom",
        headers: { cookie: "wa_session=COOKIESECRET", "x-custom": "visible" },
      });
      const errLine = sink.lines.find((l) => l.req);
      assert.ok(errLine, "expected a line carrying a serialized request");
      const req = errLine.req as Record<string, unknown>;
      assert.equal(req.headers, undefined);
      assert.equal(req.url, undefined, "url must be replaced by path");
      assert.equal(req.path, "/boom");
      assert.equal(req.method, "GET");
    });
  });

  it("never writes the session cookie or authorization header", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({
        method: "GET",
        url: "/boom",
        headers: {
          cookie: "wa_session=COOKIESECRET",
          authorization: "Bearer TOKENSECRET",
          "x-api-key": "KEYSECRET",
        },
      });
      const dump = JSON.stringify(sink.lines);
      for (const secret of ["COOKIESECRET", "TOKENSECRET", "KEYSECRET"]) {
        assert.ok(!dump.includes(secret), `${secret} leaked: ${dump}`);
      }
    });
  });

  it("prefers the Cloudflare client IP", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({
        method: "GET",
        url: "/ok",
        headers: { "cf-connecting-ip": "203.0.113.7" },
      });
      assert.equal(sink.requestLines()[0]!.ip, "203.0.113.7");
    });
  });

  it("threads the slow-request threshold through to the hook", async () => {
    // A local inject is sub-millisecond, so drive the branch from the config
    // rather than racing the clock: below zero, every request counts as slow.
    await withServer(cfgWith({ logSlowRequestMs: -1 }), async (app, sink) => {
      await app.inject({ method: "GET", url: "/ok" });
      assert.equal(sink.requestLines()[0]!.level, 40); // warn
    });
    await withServer(cfgWith({ logSlowRequestMs: 60_000 }), async (app, sink) => {
      await app.inject({ method: "GET", url: "/ok" });
      assert.equal(sink.requestLines()[0]!.level, 30); // info
    });
  });

  it("emits nothing at all when the level is silent", async () => {
    await withServer(cfgWith({ logLevel: "silent" }), async (app, sink) => {
      await app.inject({ method: "GET", url: "/ok" });
      await app.inject({ method: "GET", url: "/boom" });
      assert.equal(sink.lines.length, 0);
    });
  });

  it("logs 4xx at warn", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({ method: "GET", url: "/nope" });
      const lines = sink.requestLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0]!.status, 404);
      assert.equal(lines[0]!.level, 40); // warn
    });
  });

  it("treats a redirect as ordinary traffic", async () => {
    await withServer(cfgWith(), async (app, sink) => {
      await app.inject({ method: "GET", url: "/api/v1/auth/callback" });
      assert.equal(sink.requestLines()[0]!.level, 30);
    });
  });
});
