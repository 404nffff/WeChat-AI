/**
 * Split a long assistant reply into multiple chat bubbles to feel human.
 */

export interface SplitReplyOptions {
  /** Max bubbles (default 5) */
  maxChunks?: number;
  /** Prefer not to produce tiny fragments (default 8) */
  minChunkChars?: number;
  /** Soft max chars per bubble before force-split (default 80) */
  maxChunkChars?: number;
}

/** Must consume the terminator so split loops always advance. */
const SENTENCE_END = /[。！？!?…～~]+["'」』）)\]]*\s*/g;
const CLAUSE_END = /[；;，,]+\s*/;

/**
 * Split reply text into ordered chunks for multi-message send.
 */
export function splitReplyIntoBubbles(
  text: string,
  opts: SplitReplyOptions = {},
): string[] {
  const maxChunks = opts.maxChunks ?? 5;
  const minChunkChars = opts.minChunkChars ?? 8;
  const maxChunkChars = opts.maxChunkChars ?? 80;

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  // Short enough and no line breaks — single bubble.
  // A single `\n` is a deliberate bubble boundary (models often write
  // "在呢\n刚改完排版\n你说" as one string); only skip the early-return when
  // there is no newline at all.
  if (normalized.length <= maxChunkChars && !/\n/.test(normalized)) {
    return [normalized];
  }

  let parts: string[] = [];

  // 1) any newline (single or double) is a bubble boundary
  if (/\n/.test(normalized)) {
    parts = normalized
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    // 2) sentences
    parts = splitByRegex(normalized, SENTENCE_END);
  }

  // 3) further split long paragraphs by clauses / length
  parts = parts.flatMap((p) => splitLongPart(p, maxChunkChars));

  // merge tiny fragments into previous
  parts = mergeTiny(parts, minChunkChars);

  // cap chunk count by merging overflow into last
  if (parts.length > maxChunks) {
    const head = parts.slice(0, maxChunks - 1);
    const tail = parts.slice(maxChunks - 1).join("");
    parts = [...head, tail];
  }

  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitByRegex(text: string, re: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  const r = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    // Prevent zero-length match infinite loops
    if (m[0].length === 0) {
      r.lastIndex += 1;
      continue;
    }
    const end = m.index + m[0].length;
    const chunk = text.slice(last, end).trim();
    if (chunk) out.push(chunk);
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push(rest);
  return out.length ? out : [text];
}

function splitLongPart(part: string, maxChunkChars: number): string[] {
  if (part.length <= maxChunkChars) return [part];

  // try clauses
  const clauses = part.split(CLAUSE_END).map((s) => s.trim()).filter(Boolean);
  if (clauses.length > 1) {
    const rebuilt: string[] = [];
    let buf = "";
    for (const c of clauses) {
      const next = buf ? buf + c : c;
      if (next.length > maxChunkChars && buf) {
        rebuilt.push(buf);
        buf = c;
      } else {
        buf = next;
      }
    }
    if (buf) rebuilt.push(buf);
    return rebuilt.flatMap((p) =>
      p.length > maxChunkChars * 1.5
        ? hardSlice(p, maxChunkChars)
        : [p],
    );
  }

  return hardSlice(part, maxChunkChars);
}

function hardSlice(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

function mergeTiny(parts: string[], minChunkChars: number): string[] {
  if (parts.length <= 1) return parts;
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && p.length < minChunkChars) {
      out[out.length - 1] = out[out.length - 1] + p;
    } else {
      out.push(p);
    }
  }
  return out;
}

export interface HumanDelayOptions {
  /** ms per character when "typing" (default 90) */
  msPerChar?: number;
  /** minimum delay between bubbles (default 1400) */
  minMs?: number;
  /** maximum delay between bubbles (default 5500) */
  maxMs?: number;
  /** first bubble delay after LLM ready (default 900–2200) */
  firstMinMs?: number;
  firstMaxMs?: number;
  /** extra "think" pause before 2nd+ bubbles (default 400) */
  thinkExtraMs?: number;
}

/** Delay before sending a bubble, based on length + jitter (simulates human typing). */
export function humanDelayMs(
  chunk: string,
  index: number,
  opts: HumanDelayOptions = {},
): number {
  const msPerChar = opts.msPerChar ?? 90;
  const minMs = opts.minMs ?? 1400;
  const maxMs = opts.maxMs ?? 5500;
  const firstMin = opts.firstMinMs ?? 900;
  const firstMax = opts.firstMaxMs ?? 2200;
  const thinkExtra = opts.thinkExtraMs ?? 400;

  if (index === 0) {
    // Read message + start typing
    return rand(firstMin, firstMax);
  }
  // Subsequent: typing time + small think pause + jitter
  const typed = Math.round(chunk.length * msPerChar) + thinkExtra;
  const base = Math.min(maxMs, Math.max(minMs, typed));
  // ±25% jitter so it doesn't feel mechanical
  const jitter = base * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

function rand(a: number, b: number): number {
  return Math.round(a + Math.random() * (b - a));
}
