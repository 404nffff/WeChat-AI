import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedOtaPath,
  isValidReleaseVersion,
  normalizeOtaPath,
  pathRequiresInstall,
} from "./ota-paths.js";

describe("ota-paths", () => {
  it("normalizes and rejects traversal", () => {
    assert.equal(normalizeOtaPath("apps/api/src/index.ts"), "apps/api/src/index.ts");
    assert.equal(normalizeOtaPath("apps\\api\\src\\a.ts"), "apps/api/src/a.ts");
    assert.equal(normalizeOtaPath("../etc/passwd"), null);
    assert.equal(normalizeOtaPath("/abs"), null);
    assert.equal(normalizeOtaPath("apps/api/../../x"), null);
  });

  it("allows whitelist paths", () => {
    assert.equal(isAllowedOtaPath("package.json"), true);
    assert.equal(isAllowedOtaPath("apps/api/src/routes.ts"), true);
    assert.equal(isAllowedOtaPath("apps/api/public/admin.html"), true);
    assert.equal(isAllowedOtaPath("packages/db/src/keys.ts"), true);
    assert.equal(isAllowedOtaPath("packages/db/package.json"), true);
    assert.equal(isAllowedOtaPath("scripts/release-pack.mjs"), true);
  });

  it("denies secrets, data, node_modules, non-src package files", () => {
    assert.equal(isAllowedOtaPath(".env"), false);
    assert.equal(isAllowedOtaPath("apps/api/data/x.db"), false);
    assert.equal(isAllowedOtaPath("apps/api/node_modules/x"), false);
    assert.equal(isAllowedOtaPath("packages/db/README.md"), false);
    assert.equal(isAllowedOtaPath("Dockerfile"), false);
    assert.equal(isAllowedOtaPath("cloudflare-worker/src/index.ts"), false);
  });

  it("detects install triggers", () => {
    assert.equal(pathRequiresInstall("pnpm-lock.yaml"), true);
    assert.equal(pathRequiresInstall("packages/core/package.json"), true);
    assert.equal(pathRequiresInstall("apps/api/src/index.ts"), false);
  });

  it("validates version labels", () => {
    assert.equal(isValidReleaseVersion("0.2.1"), true);
    assert.equal(isValidReleaseVersion("0.2.1-ota.1"), true);
    assert.equal(isValidReleaseVersion(""), false);
    assert.equal(isValidReleaseVersion("../x"), false);
  });
});
