import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { scanLocalOtaHashes } from "./ota-apply.js";

describe("ota-apply scanLocalOtaHashes", () => {
  it("scans allowed files under a fake monorepo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-ota-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}');
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      fs.mkdirSync(path.join(root, "apps", "api", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "apps", "api", "src", "index.ts"),
        "export {}\n",
      );
      fs.mkdirSync(path.join(root, "apps", "api", "node_modules", "x"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(root, "apps", "api", "node_modules", "x", "a.js"),
        "nope",
      );
      fs.mkdirSync(path.join(root, "packages", "db", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "packages", "db", "package.json"),
        "{}",
      );
      fs.writeFileSync(
        path.join(root, "packages", "db", "src", "keys.ts"),
        "export {}\n",
      );
      fs.writeFileSync(path.join(root, "packages", "db", "README.md"), "no");

      const map = scanLocalOtaHashes(root);
      assert.ok(map.has("package.json"));
      assert.ok(map.has("apps/api/src/index.ts"));
      assert.ok(map.has("packages/db/src/keys.ts"));
      assert.ok(map.has("packages/db/package.json"));
      assert.equal(map.has("apps/api/node_modules/x/a.js"), false);
      assert.equal(map.has("packages/db/README.md"), false);

      const h = createHash("sha256")
        .update(fs.readFileSync(path.join(root, "package.json")))
        .digest("hex");
      assert.equal(map.get("package.json"), h);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
