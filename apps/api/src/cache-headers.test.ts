import test from "node:test";
import assert from "node:assert/strict";
import {
  etagFromHash,
  ifNoneMatchHits,
  CC_PRIVATE_NO_STORE,
  CC_CDN_STICKER,
} from "./cache-headers.js";

test("etagFromHash quotes hash", () => {
  assert.equal(etagFromHash("abc123"), '"abc123"');
  assert.equal(etagFromHash("abc123", true), 'W/"abc123"');
});

test("ifNoneMatchHits matches strong and weak", () => {
  const etag = etagFromHash("deadbeef");
  assert.equal(ifNoneMatchHits(etag, etag), true);
  assert.equal(ifNoneMatchHits(`W/${etag}`, etag), true);
  assert.equal(ifNoneMatchHits('"other"', etag), false);
  assert.equal(ifNoneMatchHits(undefined, etag), false);
  assert.equal(ifNoneMatchHits("*", etag), true);
});

test("cache constants present", () => {
  assert.match(CC_PRIVATE_NO_STORE, /no-store/);
  assert.match(CC_CDN_STICKER, /immutable/);
});
