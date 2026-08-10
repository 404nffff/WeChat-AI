import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOW_ANY_HOST,
  allowsAnyHost,
  blockedHostReason,
  blockedResolvedReason,
  ipReason,
  normalizeHost,
} from "./http-guard.js";

/** Reads better than `!== null` at every call site. */
function blocked(host: string): boolean {
  return blockedHostReason(host) !== null;
}

describe("chatflow http guard: public hosts", () => {
  it("allows ordinary public names and addresses", () => {
    for (const host of [
      "api.openai.com",
      "example.com",
      "sub.domain.example.co.uk",
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "wechat.smnet-ai.asia",
      "2c2ch1u11-share-api-0.hf.space",
      // 172.x outside 16-31 is public
      "172.15.0.1",
      "172.32.0.1",
      // 100.x outside the CGNAT block is public
      "100.63.255.255",
      "100.128.0.1",
      // octal-looking but normalises to 8.0.0.1
      "010.0.0.1",
      "[2606:4700::1111]",
    ]) {
      assert.equal(blockedHostReason(host), null, `expected allowed: ${host}`);
    }
  });
});

describe("chatflow http guard: loopback and private ranges", () => {
  it("blocks loopback in every encoding the URL parser emits", () => {
    // The old string check only knew the literal "127.0.0.1".
    for (const host of [
      "127.0.0.1",
      "127.0.0.2",
      "127.1.2.3",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "127.1",
      "localhost",
      "LOCALHOST",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[64:ff9b::7f00:1]",
    ]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("blocks RFC1918 space", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.1.1",
    ]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("blocks the unspecified address", () => {
    for (const host of ["0.0.0.0", "0", "[::]"]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });
});

describe("chatflow http guard: cloud metadata", () => {
  it("blocks the link-local metadata endpoints", () => {
    // AWS / Azure IMDS, and GCP addressed by IP. None of these is a string the
    // old blacklist matched.
    for (const host of ["169.254.169.254", "169.254.170.2", "169.254.0.1"]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
    assert.match(blockedHostReason("169.254.169.254")!, /metadata|link-local/);
  });

  it("blocks Alibaba Cloud metadata inside the CGNAT block", () => {
    assert.ok(blocked("100.100.100.200"));
    assert.ok(blocked("100.64.0.1"));
    assert.ok(blocked("100.127.255.255"));
  });

  it("blocks metadata hostnames including the GCP one", () => {
    for (const host of [
      "metadata",
      "metadata.google.internal",
      "anything.internal",
    ]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });
});

describe("chatflow http guard: intranet names", () => {
  it("blocks single-label hosts such as docker service names", () => {
    for (const host of ["wechat-ai-tools", "redis", "db", "kubelet"]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("blocks internal suffixes, trailing dot and case included", () => {
    for (const host of [
      "printer.local",
      "EVIL.LOCAL.",
      "host.localhost",
      "svc.cluster.internal",
      "nas.home.arpa",
      "fileserver.lan",
      "wiki.corp",
    ]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("blocks IPv6 unique-local and link-local", () => {
    for (const host of ["[fd00::1]", "[fc00::1]", "[fe80::1]", "[ff02::1]"]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("blocks hosts it cannot parse rather than passing them through", () => {
    for (const host of ["", " ", "a b", "[not:an:ip", "%%%"]) {
      assert.ok(blocked(host), `expected blocked: ${JSON.stringify(host)}`);
    }
  });
});

describe("chatflow http guard: gaps found by the SSRF audit", () => {
  it("blocks all of fe00::/8, not just fe80::/10", () => {
    // Regression: the mask `(b[1] & 0xc0) === 0x80` matched fe80-febf only, so
    // site-local fec0::/10 and the unassigned fe00-fe7f block passed through.
    for (const host of [
      "[fe00::1]",
      "[fe40::1]",
      "[fe7f::1]",
      "[fec0::1]",
      "[fedf::1]",
      "[feff:ffff::1]",
      "[fe80::1]",
    ]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
  });

  it("default-denies IPv6 outside global unicast 2000::/3", () => {
    for (const host of ["[100::1]", "[0100::1]", "[4000::1]", "[1000::1]"]) {
      assert.ok(blocked(host), `expected blocked: ${host}`);
    }
    // ...while real global unicast stays reachable.
    for (const host of ["[2606:4700::1111]", "[2001:4860:4860::8888]", "[3fff::1]"]) {
      assert.equal(blockedHostReason(host), null, `expected allowed: ${host}`);
    }
  });

  it("blocks cloud metadata endpoints that use a public-looking name", () => {
    // metadata.tencentyun.com is neither an internal suffix nor an IP range,
    // and it serves CVM role credentials without a token step.
    assert.ok(blocked("metadata.tencentyun.com"));
    assert.ok(blocked("metadata.goog"));
    assert.ok(blocked("instance-data"));
  });

  it("blocks Kubernetes .svc names", () => {
    assert.ok(blocked("kubernetes.default.svc"));
    assert.ok(blocked("redis.default.svc"));
  });

  it("ipReason judges v4 and v6 literals identically to the host check", () => {
    assert.match(ipReason("127.0.0.1")!, /loopback/);
    assert.match(ipReason("169.254.169.254")!, /metadata|link-local/);
    assert.match(ipReason("100.100.100.200")!, /metadata|NAT/);
    assert.match(ipReason("fec0::1")!, /fe00::\/8/);
    assert.equal(ipReason("8.8.8.8"), null);
    assert.equal(ipReason("2606:4700::1111"), null);
    assert.equal(ipReason("not-an-ip"), null);
  });
});

describe("chatflow http guard: DNS resolution", () => {
  /** Fixed answers — a real resolver would make these tests measure the network. */
  const fakeDns = (map: Record<string, string[]>) => async (host: string) => {
    const hit = map[host];
    if (!hit) throw new Error("ENOTFOUND");
    return hit;
  };

  it("blocks a public name that resolves into internal space", async () => {
    // Lexically these are ordinary .io names; only the answer gives them away.
    // nip.io-style wildcard resolvers need no attacker infrastructure at all.
    const dns = fakeDns({
      "169-254-169-254.nip.io": ["169.254.169.254"],
      "100-100-100-200.nip.io": ["100.100.100.200"],
      "evil.example.com": ["10.0.0.5"],
      "wechat-ai-tools.wechat-ai_default": ["172.17.0.3"],
    });

    const imds = await blockedResolvedReason("169-254-169-254.nip.io", dns);
    assert.match(imds!, /169\.254\.169\.254/);
    assert.match(imds!, /link-local|metadata/);

    assert.match(
      (await blockedResolvedReason("100-100-100-200.nip.io", dns))!,
      /100\.100\.100\.200/,
    );
    assert.match(
      (await blockedResolvedReason("evil.example.com", dns))!,
      /10\.0\.0\.5/,
    );
    // Dotted Docker service name — the single-label rule cannot see this one.
    assert.match(
      (await blockedResolvedReason("wechat-ai-tools.wechat-ai_default", dns))!,
      /172\.17\.0\.3/,
    );
  });

  it("blocks when ANY answer is internal, not just the first", async () => {
    const dns = fakeDns({ "split.example.com": ["93.184.216.34", "10.1.2.3"] });
    assert.match(
      (await blockedResolvedReason("split.example.com", dns))!,
      /10\.1\.2\.3/,
    );
  });

  it("blocks an IPv6 answer in internal space", async () => {
    const dns = fakeDns({ "v6.example.com": ["fec0::1"] });
    assert.match((await blockedResolvedReason("v6.example.com", dns))!, /fe00::\/8/);
  });

  it("allows a name that resolves to public addresses", async () => {
    const dns = fakeDns({ "api.example.com": ["93.184.216.34", "2606:4700::1111"] });
    assert.equal(await blockedResolvedReason("api.example.com", dns), null);
  });

  it("does not turn an unresolvable name into a block", async () => {
    // Nothing can egress to a name that will not resolve, and a DNS blip must
    // not abort the whole flow with a hard http_blocked.
    const dns = fakeDns({});
    assert.equal(await blockedResolvedReason("nope.example.com", dns), null);
  });

  it("skips resolution for literals, which were already judged", async () => {
    let called = false;
    const dns = async (_h: string) => {
      called = true;
      return ["10.0.0.1"];
    };
    assert.equal(await blockedResolvedReason("8.8.8.8", dns), null);
    assert.equal(await blockedResolvedReason("127.0.0.1", dns), null);
    assert.equal(await blockedResolvedReason("[::1]", dns), null);
    assert.equal(called, false, "literals must not hit the resolver");
  });
});

describe("chatflow http guard: helpers", () => {
  it("normalizeHost unbrackets, lowercases and drops the trailing dot", () => {
    assert.equal(normalizeHost("  EXAMPLE.COM.  "), "example.com");
    assert.equal(normalizeHost("[::1]"), "::1");
    assert.equal(normalizeHost("evil.local..."), "evil.local");
  });

  it("allowsAnyHost only fires on the sentinel", () => {
    assert.equal(allowsAnyHost([ALLOW_ANY_HOST]), true);
    assert.equal(allowsAnyHost([" * "]), true);
    assert.equal(allowsAnyHost(["api.example.com", "*"]), true);
    assert.equal(allowsAnyHost(["api.example.com"]), false);
    assert.equal(allowsAnyHost([]), false);
    assert.equal(allowsAnyHost(undefined), false);
    // Not a wildcard matcher — only the bare sentinel opens things up.
    assert.equal(allowsAnyHost(["*.example.com"]), false);
  });
});
