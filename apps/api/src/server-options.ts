import { randomUUID } from "node:crypto";
import { LogController } from "fastify";
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyServerOptions,
} from "fastify";
import type { AppConfig } from "./config.js";
import { describeRequest, logPath } from "./request-log.js";

/**
 * Silences Fastify's own "incoming request" / "request completed" pair while
 * leaving every error path intact.
 *
 * The obvious `disableRequestLogging: true` cannot be used: it is routed through
 * `isLogDisabled`, which `defaultErrorLog`, `streamError`, `writeHeadError` and
 * `serializerError` all consult first — so it silences framework error logging
 * as well, which is the single most valuable thing the logger does. (It is also
 * deprecated in Fastify 5 and gone in 6.) Overriding just the two noisy methods
 * gets the quiet request log without giving up error reporting.
 */
class QuietRequestLogController extends LogController {
  override incomingRequest(): void {}
  override requestCompleted(): void {}
}

/**
 * Fastify construction options and the request-logging hook.
 *
 * Lives outside index.ts because index.ts self-invokes `main()` and so cannot
 * be imported — and because pino throws at construction on a bad level or
 * redact path, which makes this the one config in the process where a typo is a
 * boot failure. Having it here means a test can build a real instance with it.
 */

export interface ServerOptionsExtras {
  /** Test seam: pino destination. Omit in production to write to stdout. */
  logStream?: NodeJS.WritableStream;
}

export function buildFastifyOptions(
  cfg: AppConfig,
  extras: ServerOptionsExtras = {},
): FastifyServerOptions {
  return {
    // This used to be `cfg.logLevel === "debug"`, which meant the shipped
    // default of LOG_LEVEL=info produced `logger: false` — no request logs, no
    // latency, and none of Fastify's own error logging. A route that threw left
    // nothing behind but a 500 on the wire.
    logger: {
      level: cfg.logLevel,
      serializers: {
        /**
         * Fastify's built-in `req` serializer emits `url` verbatim — query
         * string and all — and `LogController.defaultErrorLog` logs
         * `{ req, res, err }` on every 5xx. That means a 500 on
         * `/api/v1/auth/callback?code=…&state=…` would write a live single-use
         * OAuth credential to the log, defeating the whole point of logPath().
         * Redacting headers does not help: the built-in serializer never emits
         * headers in the first place. So replace it and strip the query here.
         */
        req: (req: FastifyRequest) => ({
          method: req.method,
          path: logPath(req.url),
          host: req.host,
          remoteAddress: req.ip,
        }),
      },
      // Belt and braces: the serializer above emits no headers, but any code
      // that logs a header bag explicitly must still not leak credentials.
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        remove: true,
      },
      ...(extras.logStream ? { stream: extras.logStream } : {}),
    },
    // Fastify's own pair of lines per request carries no latency and floods on
    // health probes; registerRequestLogging emits one useful line instead.
    // Errors still log — see QuietRequestLogController.
    logController: new QuietRequestLogController(),
    genReqId: () => randomUUID().slice(0, 8),
    bodyLimit: 1024 * 1024,
    requestTimeout: 60_000,
    connectionTimeout: 30_000,
    // Do NOT enable trustProxy: origins are reachable directly by IP, so a
    // forged X-Forwarded-For would bypass the login and CDN rate limiters.
    // clientIp() reads cf-connecting-ip explicitly instead.
  };
}

/**
 * One line per completed request. Rules (quiet paths, slow-request warnings,
 * and stripping credential-bearing query strings) live in request-log.ts.
 */
export function registerRequestLogging(
  app: FastifyInstance,
  cfg: AppConfig,
): void {
  app.addHook("onResponse", async (req, reply) => {
    const line = describeRequest({
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      elapsedMs: reply.elapsedTime,
      cfConnectingIp: req.headers["cf-connecting-ip"] as string | undefined,
      socketIp: req.ip,
      slowMs: cfg.logSlowRequestMs,
    });
    if (!line) return;
    const { level, ...fields } = line;
    req.log[level](fields, "request");
  });
}
