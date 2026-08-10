/**
 * Lightweight sticker image safety checks (no native deps).
 * Blocks SVG, magic/mime mismatch, and common polyglot / script payloads.
 * Not a full antivirus — complements admin review.
 */

export class StickerSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "StickerSecurityError";
  }
}

const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/**
 * Suspicious ASCII patterns often embedded in polyglot / XSS payloads.
 *
 * `textRunOnly` marks a pattern too short to survive a whole-buffer scan. Image
 * payloads are compressed, so their bytes are ≈uniform noise: a 3-byte pattern
 * matches somewhere with probability ~1/2^21 per offset, which over a 2 MiB
 * upload is an expected hit count of ~1 — i.e. it rejected roughly two thirds
 * of maximum-size stickers on pure chance. Animated GIFs are the largest
 * sticker format, so that read to users as "GIFs are not supported".
 *
 * Such patterns are matched against readable text runs instead (see
 * extractTextRuns): a real injected payload is contiguous source text, random
 * noise is not.
 */
const DANGEROUS_PATTERNS: {
  re: RegExp;
  code: string;
  textRunOnly?: boolean;
}[] = [
  { re: /<\s*script\b/i, code: "script_tag" },
  { re: /javascript\s*:/i, code: "javascript_uri" },
  { re: /\bonerror\s*=/i, code: "onerror" },
  { re: /\bonload\s*=/i, code: "onload" },
  { re: /\bonclick\s*=/i, code: "onclick" },
  { re: /<\?php/i, code: "php" },
  { re: /<%[\s=]/, code: "asp_jsp", textRunOnly: true },
  { re: /#!\s*\/(?:usr\/)?bin\//i, code: "shell_shebang" },
  { re: /data\s*:\s*text\/html/i, code: "data_html" },
  { re: /<\s*iframe\b/i, code: "iframe" },
  { re: /<\s*object\b/i, code: "object" },
  { re: /<\s*embed\b/i, code: "embed" },
  { re: /<\s*svg\b/i, code: "svg_tag" },
  { re: /<\s*html\b/i, code: "html_tag" },
  { re: /<\s*body\b/i, code: "body_tag" },
  { re: /eval\s*\(/i, code: "eval" },
  { re: /Function\s*\(/, code: "function_ctor" },
];

/**
 * Shortest run of readable bytes still worth scanning.
 *
 * Every DANGEROUS_PATTERN describes source text, and injected source is always
 * longer than this. Random 2 MiB buffers contain a run this long only rarely,
 * which is the whole point — see DANGEROUS_PATTERNS.
 */
const MIN_TEXT_RUN = 16;

/** Printable ASCII plus tab/CR/LF — what injected source is made of. */
function isTextByte(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e);
}

/** Maximal runs of readable bytes at least `minRun` long, as latin1 strings. */
export function extractTextRuns(buf: Buffer, minRun = MIN_TEXT_RUN): string[] {
  const runs: string[] = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && isTextByte(buf[i]!)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= minRun) {
      runs.push(buf.toString("latin1", start, i));
    }
    start = -1;
  }
  return runs;
}

export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  // SVG / XML masquerading
  const head = buf
    .subarray(0, Math.min(256, buf.length))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return "image/svg+xml";
  }
  return null;
}

function normalizeMime(mime: string | undefined): string | null {
  let m = (mime || "").trim().toLowerCase();
  if (m === "image/jpg") m = "image/jpeg";
  if (!ALLOWED.has(m)) return null;
  return m;
}

/**
 * Validate sticker image bytes. Throws StickerSecurityError on failure.
 * Returns canonical mime from magic bytes.
 */
export function assertSafeStickerImage(
  buf: Buffer,
  claimedMime?: string,
  opts?: { maxBytes?: number },
): { mime: string } {
  const maxBytes = opts?.maxBytes ?? 2 * 1024 * 1024;
  if (!buf?.length) {
    throw new StickerSecurityError("empty image", "empty");
  }
  if (buf.length > maxBytes) {
    throw new StickerSecurityError(
      `image too large (max ${maxBytes} bytes)`,
      "too_large",
    );
  }

  const sniffed = sniffImageMime(buf);
  if (!sniffed) {
    throw new StickerSecurityError(
      "unrecognized or unsupported image format",
      "bad_magic",
    );
  }
  if (sniffed === "image/svg+xml") {
    throw new StickerSecurityError("SVG images are not allowed", "svg_forbidden");
  }
  if (!ALLOWED.has(sniffed)) {
    throw new StickerSecurityError(
      `mime not allowed: ${sniffed}`,
      "mime_forbidden",
    );
  }

  const claimed = normalizeMime(claimedMime);
  if (claimed && claimed !== sniffed) {
    throw new StickerSecurityError(
      `mime mismatch: claimed ${claimed}, actual ${sniffed}`,
      "mime_mismatch",
    );
  }

  // Scan full buffer as latin1 so we catch ASCII payloads in binary; patterns
  // too short to be meaningful at that scale see readable text runs only.
  const text = buf.toString("latin1");
  let runs: string[] | null = null;
  for (const { re, code, textRunOnly } of DANGEROUS_PATTERNS) {
    let hit: boolean;
    if (textRunOnly) {
      runs ??= extractTextRuns(buf);
      hit = runs.some((run) => re.test(run));
    } else {
      hit = re.test(text);
    }
    if (hit) {
      throw new StickerSecurityError(
        `suspicious payload detected (${code})`,
        code,
      );
    }
  }

  // Polyglot: HTML after image end markers (JPEG EOI / PNG IEND)
  if (sniffed === "image/jpeg") {
    const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (eoi >= 0 && eoi < buf.length - 2) {
      const tail = buf.subarray(eoi + 2).toString("latin1");
      if (/<\s*(?:html|script|svg|iframe|body)\b/i.test(tail)) {
        throw new StickerSecurityError(
          "trailing HTML after JPEG EOI",
          "polyglot_tail",
        );
      }
    }
  }
  if (sniffed === "image/png") {
    const iend = buf.lastIndexOf(Buffer.from("IEND", "ascii"));
    if (iend >= 0 && iend + 8 < buf.length) {
      const tail = buf.subarray(iend + 8).toString("latin1");
      if (/<\s*(?:html|script|svg|iframe|body)\b/i.test(tail)) {
        throw new StickerSecurityError(
          "trailing HTML after PNG IEND",
          "polyglot_tail",
        );
      }
    }
  }

  return { mime: sniffed };
}
