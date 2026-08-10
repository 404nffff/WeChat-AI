import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password.js";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct-horse-battery");
    assert.ok(h.startsWith("scrypt$"));
    assert.equal(await verifyPassword("correct-horse-battery", h), true);
    assert.equal(await verifyPassword("wrong-password", h), false);
  });

  it("rejects weak passwords", () => {
    assert.throws(() => assertPasswordPolicy("short", 8), /weak_password/);
    assert.throws(() => assertPasswordPolicy("   ", 8), /weak_password/);
  });

  it("rejects tampered encoding", async () => {
    const h = await hashPassword("secret-pass-99");
    const bad = h.slice(0, -4) + "XXXX";
    assert.equal(await verifyPassword("secret-pass-99", bad), false);
    assert.equal(await verifyPassword("secret-pass-99", null), false);
    assert.equal(await verifyPassword("secret-pass-99", "not-a-hash"), false);
  });

  it("different salts for same password", async () => {
    const a = await hashPassword("same-password-ok");
    const b = await hashPassword("same-password-ok");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same-password-ok", a), true);
    assert.equal(await verifyPassword("same-password-ok", b), true);
  });
});
