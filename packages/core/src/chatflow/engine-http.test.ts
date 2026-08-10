import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LlmClient } from "@wechat-ai/llm";
import { ChatflowEngine } from "./engine.js";
import { ChatflowError, type ChatflowGraph } from "./types.js";

/**
 * The http node never touches the LLM, so a bare stub is enough — constructing
 * a real LlmClient would drag credentials into a unit test for no gain.
 */
const stubLlm = {} as LlmClient;

function httpGraph(url: string, extra: Record<string, unknown> = {}): ChatflowGraph {
  return {
    version: 1,
    nodes: [
      { id: "start", type: "start", data: {} },
      { id: "call", type: "http", data: { url, method: "GET", ...extra } },
      { id: "answer", type: "answer", data: { answer: "{{call.text}}" } },
    ],
    edges: [
      { id: "e1", source: "start", target: "call" },
      { id: "e2", source: "call", target: "answer" },
    ],
  };
}

const RUN_INPUT = {
  userText: "hi",
  botName: "bot",
  systemPrompt: "sys",
  history: [],
  memories: [],
};

/** Records what each request looked like so header handling can be asserted. */
interface Recorder {
  server: http.Server;
  port: number;
  seen: Array<{ url: string; auth: string | undefined }>;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, rec: Recorder) => void,
): Promise<Recorder> {
  const rec: Recorder = { server: null as unknown as http.Server, port: 0, seen: [] };
  rec.server = http.createServer((req, res) => {
    rec.seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    handler(req, res, rec);
  });
  await new Promise<void>((resolve) => rec.server.listen(0, "127.0.0.1", resolve));
  rec.port = (rec.server.address() as AddressInfo).port;
  return rec;
}

async function stopServer(rec: Recorder | undefined): Promise<void> {
  if (!rec) return;
  await new Promise<void>((resolve) => rec.server.close(() => resolve()));
}

describe("chatflow http node: allowlist gating", () => {
  it("blocks everything when the allowlist and tools host are both empty", async () => {
    const engine = new ChatflowEngine({ platformLlm: stubLlm, httpAllowHosts: [] });
    await assert.rejects(
      () => engine.run(httpGraph("https://api.example.com/x"), RUN_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.equal(err.code, "http_blocked");
        assert.match(err.message, /no TOOLS_BASE_URL/);
        return true;
      },
    );
  });

  it("still refuses a host that is not listed", async () => {
    const engine = new ChatflowEngine({
      platformLlm: stubLlm,
      httpAllowHosts: ["api.allowed.com"],
    });
    await assert.rejects(
      () => engine.run(httpGraph("https://api.evil.com/x"), RUN_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.match(err.message, /not allowlisted/);
        return true;
      },
    );
  });

  it("`*` does NOT open up internal space", async () => {
    const engine = new ChatflowEngine({ platformLlm: stubLlm, httpAllowHosts: ["*"] });
    for (const target of [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://100.100.100.200/latest/meta-data/",
      "http://127.0.0.1:8000/admin",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://2130706433/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://redis/",
    ]) {
      await assert.rejects(
        () => engine.run(httpGraph(target), RUN_INPUT),
        (err: unknown) => {
          assert.ok(err instanceof ChatflowError, `${target} should be a ChatflowError`);
          assert.equal(err.code, "http_blocked", `${target} should be http_blocked`);
          assert.match(err.message, /private host blocked/, target);
          return true;
        },
        `expected ${target} to be refused`,
      );
    }
  });

  it("`*` still rejects non-http schemes", async () => {
    const engine = new ChatflowEngine({ platformLlm: stubLlm, httpAllowHosts: ["*"] });
    await assert.rejects(
      () => engine.run(httpGraph("file:///etc/passwd"), RUN_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.match(err.message, /only allows http/);
        return true;
      },
    );
  });
});

describe("chatflow http node: redirects", () => {
  let target: Recorder | undefined;

  before(async () => {
    target = await startServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("payload-body");
        return;
      }
      if (req.url === "/to-metadata") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (req.url === "/to-loopback") {
        res.writeHead(302, { Location: "http://127.0.0.1:9/" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
  });

  after(async () => {
    await stopServer(target);
  });

  /** The tools host is exempt, which lets a loopback test server stand in for an allowed origin. */
  function engineForLocal(): ChatflowEngine {
    return new ChatflowEngine({
      platformLlm: stubLlm,
      toolsBaseUrl: `http://127.0.0.1:${target!.port}`,
      httpAllowHosts: ["*"],
    });
  }

  it("fetches an allowed host and exposes the body to the flow", async () => {
    const out = await engineForLocal().run(
      httpGraph(`http://127.0.0.1:${target!.port}/ok`),
      RUN_INPUT,
    );
    assert.equal(out.text, "payload-body");
  });

  it("refuses a redirect into cloud metadata", async () => {
    // The whole point: the guard sees only the first URL unless hops are
    // re-checked, so without redirect: "manual" this would succeed.
    await assert.rejects(
      () =>
        engineForLocal().run(
          httpGraph(`http://127.0.0.1:${target!.port}/to-metadata`),
          RUN_INPUT,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.equal(err.code, "http_blocked");
        assert.match(err.message, /169\.254\.169\.254/);
        return true;
      },
    );
  });

  it("refuses a redirect to a loopback port that is not the tools host", async () => {
    await assert.rejects(
      () =>
        engineForLocal().run(
          httpGraph(`http://127.0.0.1:${target!.port}/to-loopback`),
          RUN_INPUT,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.equal(err.code, "http_blocked");
        return true;
      },
    );
  });

  it("caps a redirect loop instead of spinning", async () => {
    await assert.rejects(
      () =>
        engineForLocal().run(
          httpGraph(`http://127.0.0.1:${target!.port}/loop`),
          RUN_INPUT,
        ),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.match(err.message, /exceeded \d+ redirects/);
        return true;
      },
    );
  });
});

describe("chatflow http node: credential handling", () => {
  let toolsSrv: Recorder | undefined;
  let otherSrv: Recorder | undefined;

  before(async () => {
    otherSrv = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("other-origin");
    });
    toolsSrv = await startServer((req, res) => {
      if (req.url === "/hop") {
        res.writeHead(302, { Location: `http://127.0.0.1:${otherSrv!.port}/landed` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("tools-origin");
    });
  });

  after(async () => {
    await stopServer(toolsSrv);
    await stopServer(otherSrv);
  });

  it("sends the tools key to the tools host", async () => {
    const engine = new ChatflowEngine({
      platformLlm: stubLlm,
      toolsBaseUrl: `http://127.0.0.1:${toolsSrv!.port}`,
      toolsApiKey: "secret-tools-key",
      httpAllowHosts: ["*"],
    });
    await engine.run(httpGraph(`http://127.0.0.1:${toolsSrv!.port}/direct`), RUN_INPUT);
    assert.equal(toolsSrv!.seen.at(-1)?.auth, "Bearer secret-tools-key");
  });

  it("cannot be redirected off the tools origin to leak the key", async () => {
    // Only the exact tools host:port is exempt from the internal-space check,
    // so a hop to any other loopback port dies before a socket is opened —
    // which is also why the second server must see no request at all.
    //
    // (fetchHttpNode additionally strips Authorization whenever the origin
    // changes. That path only matters for public->public redirects, which a
    // unit test cannot exercise without real network egress; the assertion
    // below is the reachable half of the same invariant.)
    const engine = new ChatflowEngine({
      platformLlm: stubLlm,
      toolsBaseUrl: `http://127.0.0.1:${toolsSrv!.port}`,
      toolsApiKey: "secret-tools-key",
      httpAllowHosts: ["*"],
    });
    await assert.rejects(
      () => engine.run(httpGraph(`http://127.0.0.1:${toolsSrv!.port}/hop`), RUN_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.equal(err.code, "http_blocked");
        return true;
      },
    );
    assert.deepEqual(
      otherSrv!.seen,
      [],
      "the redirect target must never have been contacted",
    );
  });

  it("refuses a sibling port on the tools machine", async () => {
    // The regression this pins: the exemption used to match on hostname only,
    // so with a loopback TOOLS_BASE_URL every other local port — including
    // this service's own API — was reachable through an http node.
    const engine = new ChatflowEngine({
      platformLlm: stubLlm,
      toolsBaseUrl: `http://127.0.0.1:${toolsSrv!.port}`,
      toolsApiKey: "secret-tools-key",
      httpAllowHosts: ["*"],
    });
    await assert.rejects(
      () => engine.run(httpGraph(`http://127.0.0.1:${otherSrv!.port}/landed`), RUN_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof ChatflowError);
        assert.equal(err.code, "http_blocked");
        assert.match(err.message, /loopback/);
        return true;
      },
    );
  });
});
