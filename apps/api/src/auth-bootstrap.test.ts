import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canBootstrapFirstAdmin } from "./auth-bootstrap.js";

/**
 * The register endpoint and the register form both key off this predicate. If
 * they ever disagree the UI blocks a registration the API would have accepted —
 * which is what issue #7 reported — so the rule is pinned here.
 */
describe("canBootstrapFirstAdmin", () => {
  const base = { totalUsers: 0, firstUserIsAdmin: true, adminIdCount: 0 };

  it("lets the first account in on a fresh local-only deployment", () => {
    assert.equal(canBootstrapFirstAdmin(base), true);
  });

  it("is a one-shot: any existing account closes it", () => {
    assert.equal(canBootstrapFirstAdmin({ ...base, totalUsers: 1 }), false);
    assert.equal(canBootstrapFirstAdmin({ ...base, totalUsers: 999 }), false);
  });

  it("respects FIRST_USER_IS_ADMIN=false", () => {
    assert.equal(
      canBootstrapFirstAdmin({ ...base, firstUserIsAdmin: false }),
      false,
    );
  });

  it("never self-promotes past a configured LINUXDO_ADMIN_IDS", () => {
    assert.equal(canBootstrapFirstAdmin({ ...base, adminIdCount: 1 }), false);
    assert.equal(canBootstrapFirstAdmin({ ...base, adminIdCount: 5 }), false);
  });
});
