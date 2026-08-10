import test from "node:test";
import assert from "node:assert/strict";
import { hashStickerBlob } from "./repos.js";

test("hashStickerBlob is stable 16-hex", () => {
  const a = hashStickerBlob(Buffer.from("hello"));
  const b = hashStickerBlob(Buffer.from("hello"));
  const c = hashStickerBlob(Buffer.from("world"));
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, c);
});
