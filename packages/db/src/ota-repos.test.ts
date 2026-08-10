import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReleaseMeta,
  computePackSha256,
  diffReleaseFiles,
  sha256Buffer,
} from "./ota-repos.js";

describe("ota-repos pure helpers", () => {
  it("builds meta and pack hash", () => {
    const a = {
      path: "apps/api/src/a.ts",
      sha256: "a".repeat(64),
      size: 10,
    };
    const b = {
      path: "package.json",
      sha256: "b".repeat(64),
      size: 20,
    };
    const meta = buildReleaseMeta({ version: "0.3.0", files: [b, a] });
    assert.equal(meta.version, "0.3.0");
    assert.equal(meta.fileCount, 2);
    assert.equal(meta.requiresInstall, true); // package.json
    assert.equal(meta.totalBytes, 30);
    assert.equal(meta.packSha256, computePackSha256(meta.files));
    assert.equal(meta.files[0]!.path, "apps/api/src/a.ts");
  });

  it("rejects bad paths", () => {
    assert.throws(
      () =>
        buildReleaseMeta({
          version: "1.0.0",
          files: [{ path: ".env", sha256: "c".repeat(64), size: 1 }],
        }),
      /path_not_allowed/,
    );
  });

  it("diffs local hashes", () => {
    const meta = buildReleaseMeta({
      version: "1.0.0",
      files: [
        { path: "apps/api/src/a.ts", sha256: "a".repeat(64), size: 1 },
        { path: "apps/api/src/b.ts", sha256: "b".repeat(64), size: 1 },
      ],
    });
    const local = new Map<string, string>([["apps/api/src/a.ts", "a".repeat(64)]]);
    const needed = diffReleaseFiles(meta, local);
    assert.equal(needed.length, 1);
    assert.equal(needed[0]!.path, "apps/api/src/b.ts");
  });

  it("hashes buffers", () => {
    const h = sha256Buffer(Buffer.from("hello"));
    assert.equal(h.length, 64);
    assert.equal(h, sha256Buffer(Buffer.from("hello")));
  });
});
