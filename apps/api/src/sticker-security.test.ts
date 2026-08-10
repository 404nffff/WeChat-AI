import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  assertSafeStickerImage,
  extractTextRuns,
  sniffImageMime,
  StickerSecurityError,
} from "./sticker-security.js";

/** Minimal 1x1 PNG */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Minimal JPEG SOI+APP0+EOI-ish (not valid full image but magic ok) — use real tiny jpeg */
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64",
);

describe("sticker-security", () => {
  it("accepts valid PNG", () => {
    const r = assertSafeStickerImage(PNG_1X1, "image/png");
    assert.equal(r.mime, "image/png");
  });

  it("accepts valid JPEG", () => {
    const r = assertSafeStickerImage(JPEG_1X1);
    assert.equal(r.mime, "image/jpeg");
  });

  it("rejects SVG", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    assert.equal(sniffImageMime(svg), "image/svg+xml");
    assert.throws(
      () => assertSafeStickerImage(svg),
      (e: unknown) =>
        e instanceof StickerSecurityError && e.code === "svg_forbidden",
    );
  });

  it("rejects PNG with script polyglot", () => {
    const evil = Buffer.concat([
      PNG_1X1,
      Buffer.from('<script>alert(1)</script>', "utf8"),
    ]);
    assert.throws(
      () => assertSafeStickerImage(evil, "image/png"),
      (e: unknown) =>
        e instanceof StickerSecurityError &&
        (e.code === "script_tag" || e.code === "polyglot_tail"),
    );
  });

  it("rejects mime mismatch", () => {
    assert.throws(
      () => assertSafeStickerImage(PNG_1X1, "image/jpeg"),
      (e: unknown) =>
        e instanceof StickerSecurityError && e.code === "mime_mismatch",
    );
  });

  it("rejects empty", () => {
    assert.throws(
      () => assertSafeStickerImage(Buffer.alloc(0)),
      (e: unknown) => e instanceof StickerSecurityError && e.code === "empty",
    );
  });

  it("rejects too large", () => {
    assert.throws(
      () => assertSafeStickerImage(PNG_1X1, "image/png", { maxBytes: 10 }),
      (e: unknown) =>
        e instanceof StickerSecurityError && e.code === "too_large",
    );
  });
});

/**
 * Compressed-image-like filler: high entropy, and deliberately free of long
 * readable runs (every 8th byte is forced to NUL) so these fixtures are
 * deterministic rather than merely usually-passing.
 */
function binaryNoise(len: number, seed = 1): Buffer {
  const b = Buffer.alloc(len);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    b[i] = i % 8 === 0 ? 0x00 : (x >>> 24) & 0xff;
  }
  return b;
}

function gif(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "ascii"), body]);
}

describe("sticker-security payload scan", () => {
  it("splits readable runs and ignores short ones", () => {
    const buf = Buffer.concat([
      Buffer.from([0x00, 0xff]),
      Buffer.from("short", "ascii"), // below MIN_TEXT_RUN
      Buffer.from([0x00]),
      Buffer.from("a readable sentence", "ascii"),
      Buffer.from([0x80]),
    ]);
    assert.deepEqual(extractTextRuns(buf), ["a readable sentence"]);
  });

  // Regression: `<%[\s=]` is only 3 bytes, so on compressed image data it
  // matched by pure chance — at STICKER_MAX_BYTES that rejected ~2 of every 3
  // uploads, worst of all for animated GIFs, the largest sticker format.
  it("does not reject a GIF for a 3-byte sequence buried in binary noise", () => {
    const body = binaryNoise(64 * 1024);
    body.write("<%=", 1001, "ascii"); // not inside any readable run
    const r = assertSafeStickerImage(gif(body), "image/gif");
    assert.equal(r.mime, "image/gif");
  });

  it("accepts a maximum-size random GIF", () => {
    const r = assertSafeStickerImage(
      gif(randomBytes(2 * 1024 * 1024 - 6)),
      "image/gif",
    );
    assert.equal(r.mime, "image/gif");
  });

  it("still rejects a real JSP payload in a readable run", () => {
    const body = Buffer.concat([
      binaryNoise(4096),
      Buffer.from('<%= request.getParameter("cmd") %>', "ascii"),
      binaryNoise(4096, 7),
    ]);
    assert.throws(
      () => assertSafeStickerImage(gif(body), "image/gif"),
      (e: unknown) =>
        e instanceof StickerSecurityError && e.code === "asp_jsp",
    );
  });

  it("still rejects long payloads anywhere in the buffer", () => {
    const body = Buffer.concat([
      binaryNoise(4096),
      Buffer.from("<script>alert(1)</script>", "ascii"),
      binaryNoise(4096, 7),
    ]);
    assert.throws(
      () => assertSafeStickerImage(gif(body), "image/gif"),
      (e: unknown) =>
        e instanceof StickerSecurityError && e.code === "script_tag",
    );
  });
});
