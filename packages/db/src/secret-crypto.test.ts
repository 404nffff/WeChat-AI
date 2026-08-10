import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  maskApiKey,
} from "./secret-crypto.js";

describe("secret-crypto", () => {
  it("round-trips encrypt/decrypt", () => {
    const secret = "test-provider-secret-key";
    const plain = "sk-live-abcdefghijklmnopqrstuvwxyz";
    const enc = encryptSecret(plain, secret);
    assert.notEqual(enc, plain);
    assert.equal(decryptSecret(enc, secret), plain);
  });

  it("memoized key derivation stays correct across secrets", () => {
    // deriveKey is cached; a cache keyed wrongly would cross-decrypt.
    const a = encryptSecret("payload-a", "secret-alpha-0001");
    const b = encryptSecret("payload-b", "secret-beta-0002");
    assert.equal(decryptSecret(a, "secret-alpha-0001"), "payload-a");
    assert.equal(decryptSecret(b, "secret-beta-0002"), "payload-b");
    assert.throws(() => decryptSecret(a, "secret-beta-0002"));
    assert.throws(() => decryptSecret(b, "secret-alpha-0001"));
    // Repeat after cache warm-up
    assert.equal(decryptSecret(a, "secret-alpha-0001"), "payload-a");
  });

  it("survives cache overflow (more secrets than the cache holds)", () => {
    const enc = encryptSecret("keep-me", "original-secret-xyz");
    for (let i = 0; i < 32; i++) {
      encryptSecret("noise", `rotating-secret-${i}`);
    }
    assert.equal(decryptSecret(enc, "original-secret-xyz"), "keep-me");
  });

  it("maskApiKey hides middle", () => {
    const m = maskApiKey("sk-abcdefghijklmnop");
    assert.ok(m.includes("****"));
    assert.ok(!m.includes("abcdefghijklmnop"));
    assert.equal(maskApiKey("short"), "****");
  });
});
