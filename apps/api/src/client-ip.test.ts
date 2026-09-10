import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROXY_SECRET_HEADER,
  isTrustedProxy,
  proxySecretWarning,
  resolveClientIp,
} from "./client-ip.js";

const SECRET = "s3cret-from-the-worker";
const at = (headers: Record<string, string | string[] | undefined>, proxySecret = SECRET) =>
  resolveClientIp({ headers, socketIp: "10.0.0.1", proxySecret });

describe("resolveClientIp with a proxy secret configured", () => {
  it("takes the forwarded IP when the request proves it came from the LB", () => {
    assert.equal(
      at({ [PROXY_SECRET_HEADER]: SECRET, "cf-connecting-ip": "203.0.113.9" }),
      "203.0.113.9",
    );
  });

  it("ignores forwarded IPs from anyone who cannot present the secret", () => {
    // The whole point: a direct-to-origin caller spoofing headers must not get
    // to pick its own rate-limit bucket.
    assert.equal(at({ "cf-connecting-ip": "203.0.113.9" }), "10.0.0.1");
    assert.equal(at({ "x-forwarded-for": "203.0.113.9" }), "10.0.0.1");
    assert.equal(
      at({ [PROXY_SECRET_HEADER]: "wrong", "cf-connecting-ip": "203.0.113.9" }),
      "10.0.0.1",
    );
  });

  it("does not let a longer or shorter guess pass", () => {
    for (const guess of [SECRET + "x", SECRET.slice(0, -1), ""]) {
      assert.equal(
        at({ [PROXY_SECRET_HEADER]: guess, "cf-connecting-ip": "203.0.113.9" }),
        "10.0.0.1",
        `secret guess ${JSON.stringify(guess)} must not be accepted`,
      );
    }
  });

  it("reads the leftmost X-Forwarded-For hop, which the Worker sets to the client", () => {
    assert.equal(
      at({
        [PROXY_SECRET_HEADER]: SECRET,
        "x-forwarded-for": "203.0.113.9, 172.16.0.1, 10.0.0.1",
      }),
      "203.0.113.9",
    );
  });

  it("prefers CF-Connecting-IP over X-Forwarded-For", () => {
    assert.equal(
      at({
        [PROXY_SECRET_HEADER]: SECRET,
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.7",
      }),
      "203.0.113.9",
    );
  });

  it("falls back to the socket when a trusted proxy forwards nothing", () => {
    assert.equal(at({ [PROXY_SECRET_HEADER]: SECRET }), "10.0.0.1");
  });

  it("tolerates a repeated header arriving as an array", () => {
    assert.equal(
      at({
        [PROXY_SECRET_HEADER]: [SECRET, "junk"],
        "cf-connecting-ip": ["203.0.113.9"],
      }),
      "203.0.113.9",
    );
  });

  it("never returns empty, even with no socket and no headers", () => {
    assert.equal(
      resolveClientIp({ headers: {}, socketIp: undefined, proxySecret: SECRET }),
      "unknown",
    );
  });
});

describe("resolveClientIp with no proxy secret configured", () => {
  // Legacy behaviour, kept so upgrading an existing Cloudflare deployment does
  // not collapse every user into the edge's single bucket. Insecure by design;
  // proxySecretWarning() is what tells the operator.
  it("still honours forwarded headers", () => {
    assert.equal(at({ "cf-connecting-ip": "203.0.113.9" }, ""), "203.0.113.9");
  });

  it("does not treat an absent secret as a matching secret", () => {
    assert.equal(isTrustedProxy({ headers: {}, proxySecret: "" }), false);
    assert.equal(
      isTrustedProxy({ headers: { [PROXY_SECRET_HEADER]: "" }, proxySecret: "" }),
      false,
    );
  });
});

describe("proxySecretWarning", () => {
  it("warns while the origin trusts headers on sight", () => {
    assert.match(String(proxySecretWarning("")), /ORIGIN_PROXY_SECRET/);
  });

  it("stays quiet once a secret is set", () => {
    assert.equal(proxySecretWarning(SECRET), null);
  });
});
